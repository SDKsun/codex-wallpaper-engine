import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createDshHost} from '../../../scripts/dsh-host.mjs';
import {DEFAULTS} from '../source/lib/settings-schema.js';

test('actual DSH host serves authenticated settings, bundles, fonts, presets and inventory',async()=>{
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'codex-dsh-host-'));
  let called = null;
  const host = await createDshHost({dataDir:temp,token:'b'.repeat(64),onSettingsChanged:async s=>{called = s;}});
  const server = http.createServer(async(req,res)=>{if(!await host.handle(req,res)){res.statusCode = 404;res.end('Not found');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const prefix = `${origin}/dsh/${'b'.repeat(64)}/wallpaper-engine`;
  try {
    assert.equal((await fetch(origin+'/wallpaper-engine/settings')).status,404);
    assert.equal((await fetch(origin+'/dsh/invalid/wallpaper-engine/settings')).status,403);
    assert.equal((await fetch(prefix+'/settings',{headers:{Origin:'https://untrusted.example'}})).status,403);
    assert.equal((await fetch(prefix+'/settings',{headers:{Origin:'null'}})).status,403);
    const badHost = await new Promise((resolve,reject)=>{http.get(prefix+'/settings',{headers:{Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
    assert.equal(badHost,403);
    const get = await fetch(prefix+'/settings',{headers:{Origin:'app://codex'}});
    assert.equal(get.status,200);assert.equal(get.headers.get('access-control-allow-origin'),'app://codex');
    const put = await fetch(prefix+'/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({glassAlpha:47,id:'',settingsVersion:DEFAULTS.settingsVersion})});
    assert.equal(put.status,200);assert.equal((await put.json()).settings.glassAlpha,47);assert.equal(called.glassAlpha,47);
    assert.equal(host.getSelection().glassAlpha,47);
    assert.ok(host.publicInfo().routeCount >= 40);
    for(const url of host.publicInfo().clientBundles) {
      const bundle = await fetch(url);assert.equal(bundle.status,200);assert.match(await bundle.text(),/__ModuleLoader__\.load/);
    }
    assert.equal((await fetch(prefix+'/fontsets')).status,200);
    assert.equal((await fetch(prefix+'/glass-presets')).status,200);
    const inventory = await fetch(prefix+'/inventory');assert.equal(inventory.status,200);
    const data = await inventory.json();assert.ok(Array.isArray(data.wallpapers));
    assert.ok(!JSON.stringify(data).includes('"/wallpaper-engine/'));
    assert.ok(!data.sceneMediaBase || data.sceneMediaBase.startsWith(origin+'/dsh/'));
    const scene = data.wallpapers.find(w=>w.type === 'scene');
    if(scene) {
      const resolved = await host.resolveWallpaper(scene.id);
      assert.equal(resolved.id,scene.id);assert.equal(resolved.type,'scene');assert.ok(path.isAbsolute(resolved.projectDirectory));
    }
  } finally {
    await host.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));
    await fs.rm(temp,{recursive:true,force:true});
  }
});
