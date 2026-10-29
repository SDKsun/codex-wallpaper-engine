import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {startLibrary} from '../plugins/gpt-wallpaper/scripts/library.mjs';
import {readProject} from '../plugins/gpt-wallpaper/scripts/steam.mjs';

test('scene service serves only registered projects, persists selection and restores with fresh token',async()=>{
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'scene-service-'));
  const root = path.join(temp,'project');const stateRoot = path.join(temp,'state');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root,'project.json'),JSON.stringify({type:'scene',file:'scene.json',title:'Test'}));
  await fs.writeFile(path.join(root,'scene.pkg'),'scene bytes');
  await fs.writeFile(path.join(root,'bad.html'),'<script>bad</script>');
  const project = await readProject(root);
  const calls = [];
  const options = {stateRoot,scanSteam:async()=>new Map([[project.id,project]])};
  let service = await startLibrary(async a=>{calls.push(a);return {};},options);
  async function request(data) {
    const url = new URL('/api',service.url);url.search = new URL(service.url).search;
    return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  }
  async function close() {service.server.closeAllConnections();await new Promise(r=>service.server.close(r));}
  try {
    const inventory = await (await request({action:'steam'})).json();assert.equal(inventory.items[0].type,'scene');
    const pageUrl = new URL(inventory.items[0].sceneUrl,service.url);
    const page = await fetch(pageUrl);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'self' app:/);
    const base = pageUrl.pathname.replace(/\/scene\/.+$/,'');
    assert.equal((await fetch(new URL(base+'/engine.js',service.url))).status,200);
    const pkg = await fetch(new URL(base+`/project/${project.id}/scene.pkg`,service.url));assert.equal(await pkg.text(),'scene bytes');
    assert.equal((await fetch(new URL(base+`/project/${project.id}/bad.html`,service.url))).status,403);
    assert.equal((await fetch(new URL(base+`/project/${project.id}/..%5C..%5Coutside.json`,service.url))).status,400);
    await request({action:'apply',id:project.id});
    const state = JSON.parse(await fs.readFile(path.join(stateRoot,'scene.json'),'utf8'));assert.equal(state.enabled,true);assert.equal(state.url,pageUrl.href);assert.deepEqual(calls.pop(),{action:'rotation_stop'});assert.equal(service.hasActiveScene(),true);
    const oldUrl = service.url;await close();service = await startLibrary(async()=>({}),options);
    assert.notEqual(service.url,oldUrl);assert.equal(service.hasActiveScene(),true);
    const restored = JSON.parse(await fs.readFile(path.join(stateRoot,'scene.json'),'utf8'));assert.ok(restored.url.startsWith(new URL(service.url).origin));
    await request({action:'clear_scene'});assert.equal(service.hasActiveScene(),false);
    assert.equal(JSON.parse(await fs.readFile(path.join(stateRoot,'scene.json'),'utf8')).enabled,false);
  } finally {await close();await fs.rm(temp,{recursive:true,force:true});}
});
