import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {startLibrary} from '../plugins/gpt-wallpaper/scripts/library.mjs';

test('library restricts origin, paths and actions; selected media supports video ranges',async()=>{
  const calls = [];
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'wallpaper-library-'));
  const {server,url} = await startLibrary(async input=>{calls.push(input);return {ok:true};},{stateRoot:path.join(temp,'state'),scanSteam:async()=>new Map()});
  const endpoint = new URL('/api',url); endpoint.search = new URL(url).search;
  const request = data=>fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  try {
    await fs.writeFile(path.join(temp,'风景.mp4'),'0123456789');
    await fs.writeFile(path.join(temp,'private.txt'),'not media');
    assert.equal((await fetch(new URL('/',url))).status,403);
    assert.equal((await fetch(url,{headers:{Origin:'https://untrusted.example'}})).status,403);
    const page = await (await fetch(url)).text();
    assert.ok(page.includes('GPT 壁纸库')); assert.ok(!page.includes('__KEY__'));
    assert.equal((await request({action:'set_wallpaper',path:path.join(temp,'private.txt')})).status,400);
    assert.equal((await request({action:'scan',folder:'relative'})).status,400);
    const scan = await (await request({action:'scan',folder:temp})).json();
    assert.equal(scan.items.length,1); assert.equal(scan.items[0].type,'video');
    const media = new URL('/media',url); media.search = endpoint.search; media.searchParams.set('id',scan.items[0].id);
    const range = await fetch(media,{headers:{Range:'bytes=2-5'}});
    assert.equal(range.status,206); assert.equal(range.headers.get('content-range'),'bytes 2-5/10'); assert.equal(await range.text(),'2345');
    assert.equal((await fetch(media,{headers:{Range:'bytes=50-70'}})).status,416);
    media.searchParams.set('id','../private.txt'); assert.equal((await fetch(media)).status,404);
    assert.equal((await request({action:'apply',id:'unregistered'})).status,400);
    assert.equal((await request({action:'apply',id:scan.items[0].id})).status,200);
    assert.deepEqual(calls.pop(),{action:'set_wallpaper',path:await fs.realpath(path.join(temp,'风景.mp4'))});
    await request({action:'rotation_start',seconds:60});
    assert.deepEqual(calls.pop(),{action:'rotation_start',folder:await fs.realpath(temp),seconds:60});
    await request({action:'pause',path:'ignored'}); assert.deepEqual(calls.pop(),{action:'pause'});
    await request({action:'scan',folder:temp});
    assert.equal((await request({action:'apply',id:scan.items[0].id})).status,400);
  } finally {
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    await fs.rm(temp,{recursive:true,force:true});
  }
});
