import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
import {startLibrary} from '../plugins/gpt-wallpaper/scripts/library.mjs';

test('service refuses implicit or relative state roots before touching user state',async()=>{
  await assert.rejects(startLibrary(async()=>({})),/explicit absolute stateRoot/);
  await assert.rejects(startLibrary(async()=>({}),{stateRoot:'relative'}),/explicit absolute stateRoot/);
});

test('full library mounts original host, prepares checked native factory and keeps original routes authenticated',async()=>{
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'full-wallpaper-library-'));
  const {server,url} = await startLibrary(async()=>({}),{stateRoot:temp,scanSteam:async()=>new Map()});
  const bootstrap = new URL('/dsh-bootstrap',url);bootstrap.search = new URL(url).search;
  try {
    const advanced = new URL('/advanced',url);advanced.search = bootstrap.search;
    const page = await fetch(advanced);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/style-src 'self' 'unsafe-inline'/);
    assert.ok((await page.text()).includes('react-settings'));
    assert.equal((await fetch(new URL('/dsh/not-a-capability/wallpaper-engine/settings',url))).status,403);
    const info = await (await fetch(bootstrap)).json();
    assert.equal(info.clientBundles.length,5);assert.ok(info.routeCount >= 40);
    assert.equal((await fetch(info.base+'/settings')).status,200);
    const config = JSON.parse(await fs.readFile(path.join(temp,'dsh-native.json'),'utf8'));
    const factory = await fs.readFile(path.join(temp,'native-client.js'),'utf8');
    assert.equal(config.scriptHash,createHash('sha256').update(factory).digest('hex'));
    assert.equal(config.origin,new URL(url).origin);assert.equal(config.enabled,true);
    new Script(`(${factory})`);
    await fs.writeFile(path.join(temp,'native-client.js'),'stale overwritten factory');
    const oldSettings=await(await fetch(info.base+'/settings')).json();
    const updated=await fetch(info.base+'/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...oldSettings.settings,settingsVersion:6,blur:11})});
    assert.equal(updated.status,200);
    const repaired=await fs.readFile(path.join(temp,'native-client.js'),'utf8');
    const repairedConfig=JSON.parse(await fs.readFile(path.join(temp,'dsh-native.json'),'utf8'));
    assert.equal(repaired,factory);assert.equal(repairedConfig.scriptHash,createHash('sha256').update(repaired).digest('hex'));
    const client = await fetch(info.clientBundles[0]);assert.equal(client.status,200);assert.ok(Number(client.headers.get('content-length') || 1) > 0);
  } finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await new Promise(resolve=>setTimeout(resolve,100));
    await fs.rm(temp,{recursive:true,force:true});
  }
});
