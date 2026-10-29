import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createDshHost} from '../../../scripts/dsh-host.mjs';

const root = fileURLToPath(new URL('../source/',import.meta.url));
const read = relative=>fs.readFile(path.join(root,relative),'utf8');
function declaration(source,name) {
  const start = source.indexOf('function '+name+'(');
  assert.ok(start>=0,name+' exists');
  return source.slice(start,source.indexOf('\n}',start)+2);
}
async function functions(base,location) {
  const globals = base ? {__CODEX_WE_API_BASE__:base} : {};
  const api = (await read('src/api-client.js')).replace(/export \{[^}]+\};\s*$/,'');
  const apiUrl = new Function('globalThis',api+';return apiUrl;')(globals);
  const live = await read('src/live-layer.js');
  const make = new Function('globalThis','apiUrl','selection','location',`
    const SCENE_LIVE_FIT={cover:'cover',contain:'contain',fill:'stretch'};
    const SCENE_LIVE_FPS_VALUES=[30,60];const SCENE_FILES_PATH='/wallpaper-engine/scene-files';
    const weAudioVolume=()=>0;const resolveSceneMediaBase=()=> 'http://127.0.0.1:9999';
    ${declaration(live,'liveRenderUrl')};return liveRenderUrl;`);
  const liveRenderUrl = make(globals,apiUrl,{inventory:{weAssetsAvailable:true}},location);
  const transcode = new Function('apiUrl',declaration(await read('src/video-layer.js'),'transcodedUrlFor')+';return transcodedUrlFor;')(apiUrl);
  return {liveRenderUrl,transcode,apiUrl};
}

test('actual scene, Web and transcode URL producers retain scoped native and HTTP resources',async()=>{
  const token = 'e'.repeat(64);
  for(const origin of ['app://codex','http://127.0.0.1:62662']) {
    const base = `${origin}/dsh/${token}/wallpaper-engine`;
    const {liveRenderUrl,transcode} = await functions(base,{href:origin+'/index.html',origin:origin.startsWith('app:')?'null':origin});
    const scene = new URL(liveRenderUrl({type:'scene',sceneLiveSrc:'payload',objectFit:'cover',sceneLiveFps:30}));
    assert.equal(scene.protocol,origin.startsWith('app:')?'app:':'http:');
    assert.equal(scene.pathname,`/dsh/${token}/wallpaper-engine/scene-live/index.html`);
    assert.equal(scene.searchParams.get('mediaBase'),base+'/scene-files');assert.equal(scene.searchParams.get('src'),'payload');
    assert.equal(scene.searchParams.get('localAssets'),'1');
    for(const entry of [base+'/scene-files/key/index.html',`/dsh/${token}/wallpaper-engine/scene-files/key/index.html`,'/wallpaper-engine/scene-files/key/index.html']) {
      const web = new URL(liveRenderUrl({type:'web',webLiveSrc:entry}));
      assert.equal(web.searchParams.get('src'),base+'/scene-files/key/index.html');
      assert.equal(web.searchParams.get('mediaBase'),base+'/scene-files');assert.equal(web.searchParams.get('webSandbox'),'strict');
    }
    for(const entry of ['https://evil.example/index.html','app://other/dsh/'+token+'/wallpaper-engine/scene-files/x.html',base+'/settings',base+'/scene-files/../settings']) {
      assert.throws(()=>liveRenderUrl({type:'web',webLiveSrc:entry}),/outside the authenticated/);
    }
    assert.equal(transcode('bytes /?',24),base+'/transcoded/bytes%20%2F%3F?fps=24');
    const renderer = await read('lib/webwallgl/renderer.js');
    const diag = new Function('current','location',declaration(renderer,'diagOrigin')+';return diagOrigin();')({mediaBase:base+'/scene-files'},{href:base+'/scene-live/index.html'});
    assert.equal(diag,base);
  }
  const original = await functions(null,{href:'http://localhost:1234/',origin:'http://localhost:1234'});
  const before = new URL(original.liveRenderUrl({type:'scene',sceneLiveSrc:'token'}),'http://localhost:1234');
  assert.equal(before.pathname,'/wallpaper-engine/scene-live/index.html');assert.equal(before.searchParams.get('mediaBase'),'http://127.0.0.1:9999/wallpaper-engine/scene-files');
  assert.equal(original.transcode('token',30),'/wallpaper-engine/transcoded/token?fps=30');
});

test('real host HTML and standalone renderer/engine scripts keep frame resources and local-assets authenticated',async()=>{
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'codex-resource-url-'));
  const token = 'f'.repeat(64);const host = await createDshHost({dataDir:directory,token});
  const server = http.createServer(async(req,res)=>{if(!await host.handle(req,res)){res.statusCode=404;res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:'+server.address().port;
  const mount = `/dsh/${token}`;const frame = origin+mount+'/wallpaper-engine/scene-live/index.html';
  try {
    const html = await (await fetch(frame)).text();
    assert.match(html,new RegExp(mount+'/wallpaper-engine/scene-live/occlusion-bridge\\.js'));
    assert.ok(!html.includes('src="/wallpaper-engine'));
    for(const entry of ['./renderer.js','./engine/webwallgl.global.min.js','./default-wallpaper/index.html']) {
      const url = new URL(entry,frame);assert.ok(url.pathname.startsWith(mount+'/'));
      const response=await fetch(url);assert.equal(response.status,200);const source=await response.text();
      if(entry.includes('renderer'))assert.match(source,/authenticated mount/);
      if(entry.includes('webwallgl.global')) {
        assert.match(source,/Codex adapter: token-scoped local-assets/);
        assert.ok(source.includes('location.pathname.split("/wallpaper-engine/scene-live/")[0]+"/api/local-assets"'));
      }
    }
    const local=await fetch(origin+mount+'/api/local-assets');assert.equal(local.status,200);
    assert.equal((await fetch(origin+'/api/local-assets')).status,404);
    assert.equal((await fetch(origin+mount+'/wallpaper-engine/diag?msg=scoped-url-test')).status,204);
  } finally {
    await host.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await fs.rm(directory,{recursive:true,force:true});
  }
});
