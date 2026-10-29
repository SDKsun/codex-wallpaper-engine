import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createDshHost} from '../../../scripts/dsh-host.mjs';

test('native chunk bridge preserves real upload bytes, upstream validation and bounded authenticated state',async()=>{
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'codex-chunks-'));
  const token = 'c'.repeat(64);
  const host = await createDshHost({dataDir:temp,token});
  const received = [];
  const server = http.createServer(async(req,res)=>{
    if(req.url.includes('/wallpaper-engine/upload?') || req.url.includes('/glass-presets/import')) {
      const parts = [];req.on('data',part=>parts.push(part));
      req.on('end',()=>received.push({url:req.url,bytes:Buffer.concat(parts)}));
    }
    if(!await host.handle(req,res)){res.statusCode = 404;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}/dsh/${token}/wallpaper-engine`;
  const control = (action,data,baseOverride=base)=>fetch(baseOverride+'/codex-upload/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const start = (extra={})=>control('start',{route:'/wallpaper-engine/upload',method:'POST',bytes:1,headers:{'content-type':'image/png'},...extra});
  globalThis.__CODEX_WE_API_BASE__ = base;
  globalThis.__CODEX_WE_CHUNK_UPLOAD__ = true;
  const {apiFetch} = await import('../source/src/api-client.js?chunk-test');
  try {
    const bytes = Buffer.alloc(600003);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
    const progress = [];let directCalls = 0;
    const transport = async(url,init)=>{assert.equal(typeof init.body,'string');assert.ok(Buffer.byteLength(init.body)<400*1024);directCalls++;return fetch(url,init);};
    const upload = await apiFetch('/upload?title='+encodeURIComponent('测试 🐟'),{method:'POST',headers:{'content-type':'image/png'},body:new Blob([bytes]),fetch:transport,onUploadProgress:p=>progress.push(p.loaded)});
    assert.equal(upload.status,200);assert.equal(upload.data.type,'image');assert.match(upload.data.media,/\/dsh\/c{64}\/wallpaper-engine\/media\//);
    assert.deepEqual(received.at(-1).bytes,bytes);assert.equal(directCalls,5);assert.deepEqual(progress,[262144,524288,600003]);
    // Verify the actual upstream stored file, rather than merely the transport echo.
    const stored = await fs.readdir(path.join(temp,'uploads'));
    assert.deepEqual(await fs.readFile(path.join(temp,'uploads',stored.find(f=>f.endsWith('.png')))),bytes);
    for(const body of [new Uint8Array([0,9,255]).buffer,new Uint8Array(new Uint8Array([99,0,17,255,88]).buffer,1,3),new ArrayBuffer(0)]) {
      const result = await apiFetch('/upload?title=buffer',{method:'POST',headers:{'content-type':'image/png'},body});
      assert.equal(result.status,200);
      const expected = ArrayBuffer.isView(body) ? Buffer.from(body.buffer,body.byteOffset,body.byteLength) : Buffer.from(body);
      assert.deepEqual(received.at(-1).bytes,expected);
    }
    const text = JSON.stringify({$schema:'dsh-we/profile-preset@1',name:'中文 🐟',values:{glassAlpha:46},padding:'中\u0000🐟'.repeat(70000)});
    const imported = await apiFetch('/glass-presets/import',{method:'POST',headers:{'content-type':'application/json'},body:text,fetch:transport});
    assert.equal(imported.status,200);assert.equal(imported.data.name,'中文 🐟');assert.deepEqual(received.at(-1).bytes,Buffer.from(text));
    // The original MIME checker still decides failure, and its 415 is preserved.
    const invalid = await apiFetch('/upload?title=unsupported',{method:'POST',headers:{'content-type':'application/octet-stream'},body:new Uint8Array([0,255,0]),parse:'always'});
    assert.equal(invalid.status,415);assert.match(invalid.data.error,/application\/octet-stream/);
    for(const route of ['https://example.com/upload','//example.com/upload','/wallpaper-engine/../upload','/wallpaper-engine/%2e%2e/upload','/wallpaper-engine/codex-upload/start','/wallpaper-engine/not-registered']) assert.equal((await start({route})).status,400);
    assert.equal((await start({headers:{Cookie:'private'}})).status,400);
    assert.equal((await start({method:'DELETE'})).status,400);
    assert.equal((await start({bytes:512*1024*1024+1})).status,413);
    assert.equal((await control('start',{},origin+'/dsh/'+'d'.repeat(64)+'/wallpaper-engine')).status,403);
    const sequence = await (await start({bytes:2})).json();
    assert.equal((await control('chunk',{id:sequence.id,index:1,data:'AA=='})).status,400);
    assert.equal((await control('finish',{id:sequence.id})).status,404);
    const oversized = await (await start()).json();
    assert.equal((await control('chunk',{id:oversized.id,index:0,data:'AAA='})).status,400);
    const malformed = await (await start()).json();
    assert.equal((await control('chunk',{id:malformed.id,index:0,data:'AB=='})).status,400);
    const incomplete = await (await start({bytes:2})).json();
    assert.equal((await control('finish',{id:incomplete.id})).status,400);
    // Synchronous reservations prevent racing starts from exceeding four slots.
    const starts = await Promise.all(Array.from({length:8},()=>start()));
    assert.equal(starts.filter(r=>r.status===200).length,4);assert.equal(starts.filter(r=>r.status===429).length,4);
    for(const response of starts)if(response.status===200)assert.equal((await control('cancel',{id:(await response.json()).id})).status,200);
    const huge = await (await start({bytes:512*1024*1024})).json();
    assert.equal((await start()).status,429);await control('cancel',{id:huge.id});
    // Only one request may append a transfer at once; duplicate indices cannot corrupt it.
    const concurrent = await (await start({bytes:262144})).json();
    const both = await Promise.all([0,1].map(()=>control('chunk',{id:concurrent.id,index:0,data:Buffer.alloc(262144).toString('base64')})));
    assert.equal(both.filter(r=>r.status===200).length,1);assert.ok(both.some(r=>r.status===409 || r.status===400));
    await control('cancel',{id:concurrent.id});
    const abort = new AbortController();
    const cancelled = await apiFetch('/upload',{method:'POST',headers:{'content-type':'image/png'},body:new Blob([bytes]),signal:abort.signal,onUploadProgress:()=>abort.abort()});
    assert.equal(cancelled.error,'AbortError');
    assert.deepEqual(await fs.readdir(path.join(temp,'codex-transfers')),[]);
    // Opt-in remains scoped: ordinary HTTP uploads keep the exact original body.
    globalThis.__CODEX_WE_CHUNK_UPLOAD__ = false;
    const original = new Uint8Array([0,255,0]);let observed;
    const plain = await apiFetch('/upload',{method:'POST',body:original,fetch:async(url,init)=>{observed={url,body:init.body};return new Response('{}');}});
    assert.equal(plain.status,200);assert.equal(observed.url,base+'/upload');assert.equal(observed.body,original);
  } finally {
    delete globalThis.__CODEX_WE_API_BASE__;delete globalThis.__CODEX_WE_CHUNK_UPLOAD__;
    await host.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await fs.rm(temp,{recursive:true,force:true});
  }
});
