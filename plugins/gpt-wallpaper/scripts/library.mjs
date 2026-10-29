import http from 'node:http';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {scanSteam,safeProjectFile,readProject} from './steam.mjs';
import {PreferencesStore} from './preferences.mjs';
import {readSceneProperties} from './scene-properties.mjs';
import {SERVICE_REVISION} from './service-version.mjs';
import {buildNativeSceneRuntime} from './native-scene.mjs';

const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui');
const types = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm'};
const assets = {'/':'index.html','/basic':'index.html','/advanced':'dsh-shell.html','/native-harness':'native-harness.html','/native-harness.css':'native-harness.css','/dsh-shell.js':'dsh-shell.js','/dsh-shell.css':'dsh-shell.css','/runtime/react.js':'runtime/react.js','/runtime/react-dom.js':'runtime/react-dom.js','/app.js':'app.js','/style.css':'style.css'};

async function nativeClientOptions(host,title) {
  const bundleNames=['lib/client.js','packages/fonts/lib/client.fonts.js','packages/fx/lib/client.fx.js','packages/parallax/lib/client.parallax.js','packages/pet-link/lib/client.pet-link.js'];
  const [reactSource,reactDOMSource,clientBundles,engineSource,rendererSource,occlusionSource]=await Promise.all([
    fs.readFile(path.join(ui,'runtime/react.js'),'utf8'),fs.readFile(path.join(ui,'runtime/react-dom.js'),'utf8'),
    Promise.all(bundleNames.map(name=>fs.readFile(path.join(host.vendor,name),'utf8'))),
    fs.readFile(path.join(host.vendor,'runtime-deps/webwallgl/webwallgl.global.min.js'),'utf8'),
    fs.readFile(path.join(host.vendor,'lib/webwallgl/renderer.js'),'utf8'),
    fs.readFile(path.join(host.vendor,'lib/webwallgl/occlusion-bridge.js'),'utf8'),
  ]);
  return {apiBase:host.publicInfo().base,reactSource,reactDOMSource,clientBundles,title,
    sceneRuntimeSource:buildNativeSceneRuntime({engineSource,rendererSource,occlusionSource})};
}

export async function startLibrary(control, options = {}) {
  if(typeof options.stateRoot !== 'string' || !path.isAbsolute(options.stateRoot))throw new Error('An explicit absolute stateRoot is required for the wallpaper service');
  const token = randomBytes(32).toString('hex');
  let folder = '', files = new Map(), projects = new Map(), busy = false, activeScene = false;
  const scenePrefix = `/s/${token}`;
  const discover = options.scanSteam ?? scanSteam;
  const stateRoot = path.resolve(options.stateRoot);
  const preferences = new PreferencesStore({stateRoot});
  let dshHost = null, dshStarting = null, bridgedId = null;
  let nativePrepared = null, nativeFactory = null;
  async function atomicState(name,value) {
    await fs.mkdir(stateRoot,{recursive:true});
    const file = path.join(stateRoot,name);
    try {if(await fs.readFile(file,'utf8') === value)return;} catch {}
    const temp = file+'.'+randomBytes(8).toString('hex')+'.tmp';
    await fs.writeFile(temp,value,{flag:'wx'});await fs.rename(temp,file);
  }
  async function publishNative(forceEnable = false) {
    if(!dshHost)return;
    if(!nativePrepared) {
      const {buildNativeClientFactory} = await import('./native-client.mjs');
      const factory = buildNativeClientFactory(await nativeClientOptions(dshHost,'Codex 壁纸引擎'));
      nativeFactory = factory;
      let enabled = true;
      try {enabled = JSON.parse(await fs.readFile(path.join(stateRoot,'dsh-native.json'),'utf8')).enabled !== false;} catch {}
      nativePrepared = {enabled,origin:`http://127.0.0.1:${server.address().port}`,token,scriptHash:createHash('sha256').update(factory).digest('hex')};
    }
    if(forceEnable)nativePrepared.enabled=true;
    // Restore the matching fixed factory if another process replaced it. The
    // verified script and its published digest must always describe one build.
    await atomicState('native-client.js',nativeFactory);
    await atomicState('dsh-native.json',JSON.stringify(nativePrepared));
  }
  const dshRequest = async (method,relative,data) => {
    const host = await ensureDsh();
    const res = await fetch(host.publicInfo().base+relative,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(20000)});
    const result = await res.json();if(!res.ok)throw new Error(result.error || '壁纸引擎操作失败');return result;
  };
  async function ensureDsh() {
    if(dshHost) return dshHost;
    if(dshStarting) return dshStarting;
    dshStarting = (async()=>{
      // Production uses the pinned native provider. Isolated tests opt in
      // explicitly so a disposable library never reads user caches or downloads.
      if(process.platform === 'win32' && options.prepareMediaBridge === true) {
        const {ensureTrustedMediaBridge} = await import('./media-bridge.mjs');
        try {
          const provision = await ensureTrustedMediaBridge({dataDir:path.join(stateRoot,'dsh')});
          Object.assign(process.env,provision.env);
        } catch(error) {
          await atomicState('media-bridge-setup.json',JSON.stringify({available:false,error:String(error.code || 'media-bridge-unavailable').slice(0,120)}));
        }
      }
      const {createDshHost} = await import('./dsh-host.mjs');
      dshHost = await createDshHost({token,origin:`http://127.0.0.1:${server.address().port}`,dataDir:path.join(stateRoot,'dsh'),onSettingsChanged:async(settings,wallpaper)=>{
        activeScene = !!settings.id;
        await publishNative(true);
        if(settings.id === bridgedId)return;
        bridgedId = settings.id;
        if(wallpaper?.type === 'scene') {
          const project = await readProject(wallpaper.projectDirectory);projects.set(project.id,project);
          await control({action:'rotation_stop'});
          await saveScene({enabled:true,url:`http://127.0.0.1:${server.address().port}${scenePrefix}/scene/${project.id}`,name:project.name});
        } else if(wallpaper?.type === 'video' || wallpaper?.type === 'image') {
          await saveScene({enabled:false});
        } else if(!settings.id) await saveScene({enabled:false});
      }});
      // Carry the user's existing Scene choice into the full upstream library.
      if(!dshHost.getSelection().id) {
        try {
          const previous = JSON.parse(await fs.readFile(path.join(stateRoot,'scene.json'),'utf8'));
          const id = previous.enabled && /\/scene\/([a-f0-9]{24})$/.exec(previous.url)?.[1];
          const project = id && projects.get(id);
          if(project && /^\d+$/.test(path.basename(project.root))) await dshRequest('PUT','/settings',{...dshHost.getSelection(),settingsVersion:6,id:path.basename(project.root)});
        } catch {}
      }
      await publishNative();
      return dshHost;
    })();
    try{return await dshStarting;}catch(error){dshStarting=null;throw error;}
  }
  async function saveScene(value) {
    const state = stateRoot;
    await fs.mkdir(state,{recursive:true});
    const temp = path.join(state,`scene-${randomBytes(8).toString('hex')}.tmp`);
    await fs.writeFile(temp,JSON.stringify(value),{flag:'wx'});
    await fs.rename(temp,path.join(state,'scene.json'));
    activeScene = value.enabled;
  }
  const send = (res, code, data) => {
    res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (req.headers.host !== `127.0.0.1:${server.address().port}`) return send(res,403,{error:'无效宿主'});
      const url = new URL(req.url, 'http://127.0.0.1');
      if(url.pathname.startsWith('/dsh/')) {
        if(!url.pathname.startsWith(`/dsh/${token}/`)) return send(res,403,{error:'无效壁纸引擎密钥'});
        await (await ensureDsh()).handle(req,res);return;
      }
      const isScene = url.pathname.startsWith(scenePrefix+'/');
      if (url.searchParams.get('key') !== token && !isScene) return send(res,403,{error:'请从插件重新打开壁纸库'});
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res,403,{error:'无效来源'});
      if(req.method === 'GET' && url.pathname === '/ping') return send(res,200,{plugin:'gpt-wallpaper',apiVersion:5,revision:SERVICE_REVISION});
      if(req.method === 'GET' && url.pathname === '/dsh-bootstrap') {return send(res,200,(await ensureDsh()).publicInfo());}
      if(req.method === 'GET' && url.pathname === '/native-harness.js') {
        const host=await ensureDsh();const {buildNativeClient}=await import('./native-client.mjs');
        const code=buildNativeClient(await nativeClientOptions(host,'原生接入测试'));
        res.setHeader('Content-Type','text/javascript; charset=utf-8');
        res.end(code+';setInterval(()=>{const s=globalThis.__GPT_DSH_NATIVE_STATE__?.summary?.();if(s){document.body.dataset.nativeHarnessReady=String(s.ready);document.body.dataset.nativeHarnessError=String(s.error||"");document.body.dataset.nativeHarnessFps=String(s.fps);}},500);');return;
      }
      if (isScene && req.method === 'GET') {
        const relative = url.pathname.slice(scenePrefix.length);
        res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' blob:; frame-ancestors 'self' app:; base-uri 'none'");
        const sceneId = /^\/scene\/([a-f0-9]{24})$/.exec(relative)?.[1];
        const settingsId = /^\/scene-settings\/([a-f0-9]{24})$/.exec(relative)?.[1];
        if(settingsId) {
          const project = projects.get(settingsId);if(!project)return send(res,404,{error:'未知场景'});
          const settings = dshHost?.getSelection() || await preferences.readSettings();
          const props = await readSceneProperties(project.root);
          return send(res,200,{settings,properties:props.properties});
        }
        const staticFiles = {'/scene.js':['scene.js','text/javascript'],'/scene.css':['scene.css','text/css']};
        if(sceneId) {
          if(!projects.has(sceneId)) return send(res,404,{error:'场景不在当前壁纸库'});
          res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await fs.readFile(path.join(ui,'scene.html')));return;
        }
        if(relative === '/engine.js') {
          res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(ui,'../vendor/webwallgl/webwallgl.global.min.js')));return;
        }
        if(staticFiles[relative]) {
          const [name,mime] = staticFiles[relative];res.setHeader('Content-Type',mime+'; charset=utf-8');res.end(await fs.readFile(path.join(ui,name)));return;
        }
        const resource = /^\/project\/([a-f0-9]{24})\/(.+)$/.exec(relative);
        if(resource) {
          const project = projects.get(resource[1]);
          if(!project) return send(res,404,{error:'未知项目'});
          const rel = decodeURIComponent(resource[2]);
          if(!/\.(json|pkg|tex|mdl|anim|png|jpe?g|webp|gif|mp4|webm|ogg|mp3|wav|glsl|vert|frag|ttf|otf)$/i.test(rel)) return send(res,403,{error:'不支持的场景资源'});
          const file = await safeProjectFile(project.root,rel);
          res.setHeader('Content-Type',rel.endsWith('.json')?'application/json':types[path.extname(rel).toLowerCase()] || 'application/octet-stream');
          res.setHeader('Content-Length',file.stat.size);
          const stream = createReadStream(file.path);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
        }
        return send(res,404,{error:'未找到场景资源'});
      }
      if (req.method === 'GET' && assets[url.pathname]) {
        if(url.pathname === '/advanced') res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'");
        const file = assets[url.pathname];
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
        res.end((await fs.readFile(path.join(ui,file),'utf8')).replaceAll('__KEY__',token));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/media') {
        const item = files.get(url.searchParams.get('id'));
        if (!item) return send(res,404,{error:'文件不在当前壁纸库'});
        const stat = await fs.lstat(item.path);
        if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(item.path) !== item.path) return send(res,404,{error:'文件已变化，请刷新壁纸库'});
        let start = 0, end = stat.size - 1;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) return send(res,416,{error:'无效范围'});
          if (!match[1]) start = Math.max(0,stat.size - Number(match[2]));
          else { start = Number(match[1]); if (match[2]) end = Math.min(end,Number(match[2])); }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
            res.setHeader('Content-Range',`bytes */${stat.size}`);
            return send(res,416,{error:'无效范围'});
          }
          res.statusCode = 206;
          res.setHeader('Content-Range',`bytes ${start}-${end}/${stat.size}`);
        }
        res.setHeader('Content-Type',item.mime);
        res.setHeader('Accept-Ranges','bytes');
        res.setHeader('Content-Length',Math.max(0,end-start+1));
        const stream = createReadStream(item.path,{start,end});
        stream.on('error',()=>res.destroy());
        res.on('close',()=>stream.destroy());
        stream.pipe(res);
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/api') return send(res,404,{error:'未找到'});
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(res,415,{error:'需要 JSON'});
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536) return send(res,413,{error:'请求过大'});
      }
      const input = JSON.parse(body);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res,400,{error:'无效请求'});
      if (busy) return send(res,409,{error:'正在应用，请稍候'});
      busy = true;
      try {
        if(input.action === 'steam') {
          const found = await discover();
          for(const [id,project] of found) {
            projects.set(id,project);
            const preview = project.type === 'video'?project.mediaPath:project.previewPath;
            if(preview) files.set(id,{path:preview,name:project.name,mime:types[path.extname(preview).toLowerCase()]});
          }
          return send(res,200,{items:[...found.values()].map(p=>({id:p.id,name:p.name,type:p.type,preview:!!p.previewPath,source:'steam',sceneUrl:p.type === 'scene'?`${scenePrefix}/scene/${p.id}`:null}))});
        }
        if(input.action === 'dsh_select') {
          const host = await ensureDsh();
          const wallpaper = await host.resolveWallpaper(input.id);
          if(!wallpaper) throw new Error('壁纸不在当前 Wallpaper Engine 壁纸库');
          await dshRequest('PUT','/settings',{...host.getSelection(),settingsVersion:6,id:wallpaper.id});
          return send(res,200,{name:wallpaper.name,message:'壁纸选择已保存到完整引擎。实际聊天背景请以引擎连接和界面检测为准。',renderingVerified:false});
        }
        if(input.action === 'clear_scene') {
          await saveScene({enabled:false});
          await atomicState('dsh-native.json','{"enabled":false}');if(nativePrepared)nativePrepared.enabled=false;
          return send(res,200,{message:'已退出场景壁纸，保留原图片或视频配置。'});
        }
        if (input.action === 'scan') {
          if (typeof input.folder !== 'string' || !path.isAbsolute(input.folder)) throw new Error('请输入本地壁纸文件夹的完整路径');
          const selected = await fs.realpath(input.folder);
          if (!(await fs.stat(selected)).isDirectory()) throw new Error('请选择文件夹');
          const entries = await fs.readdir(selected,{withFileTypes:true});
          const candidates = entries.filter(e=>e.isFile() && types[path.extname(e.name).toLowerCase()]);
          if (candidates.length > 500) throw new Error('单个目录最多支持 500 个文件');
          const next = new Map();
          for (const entry of candidates.sort((a,b)=>a.name.localeCompare(b.name))) {
            const full = path.join(selected,entry.name);
            if (await fs.realpath(full) !== full) continue;
            if ((await fs.stat(full)).size === 0) continue;
            const id = randomBytes(12).toString('hex');
            next.set(id,{path:full,name:entry.name,mime:types[path.extname(entry.name).toLowerCase()]});
          }
          folder = selected; files = next;
          return send(res,200,{folder,items:[...files].map(([id,item])=>({id,name:item.name,type:item.mime.startsWith('video/')?'video':'image'}))});
        }
        let action;
        if (input.action === 'apply') {
          const project = projects.get(input.id);
          if(project?.type === 'scene') {
            const sceneUrl = `http://${req.headers.host}${scenePrefix}/scene/${project.id}`;
            await control({action:'rotation_stop'});
            await saveScene({enabled:true,url:sceneUrl,name:project.name});
            return send(res,200,{sceneUrl,message:'场景配置已保存。已启用的背景引擎会读取场景；首次请通过管理器启用并确认重启。实际聊天渲染需在界面确认。',renderingVerified:false});
          }
          const item = files.get(input.id);
          if (!item) throw new Error('请先选择壁纸');
          if (!(await fs.lstat(item.path)).isFile() || await fs.realpath(item.path) !== item.path) throw new Error('文件已变化，请重新加载壁纸库');
          action = {action:'set_wallpaper',path:item.path};
          await saveScene({enabled:false});
        } else if (input.action === 'rotation_start') {
          if (!folder || !files.size) throw new Error('请先加载壁纸文件夹');
          action = {action:'rotation_start',folder,seconds:input.seconds};
          await saveScene({enabled:false});
        } else if (input.action === 'set_reveal') action = {action:input.action,percent:input.percent};
        else if (['status','pause','resume','rotation_stop','rotation_status','open_manager'].includes(input.action)) action = {action:input.action};
        else throw new Error('不支持的操作');
        send(res,200,await control(action));
      } finally { busy = false; }
    } catch (error) {
      if (!res.headersSent) send(res,400,{error:error.code ? '无法访问文件，请检查路径和权限' : error.message});
      else res.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('close',()=>{void dshHost?.dispose();});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  // Keep an enabled local scene usable when the library is reopened on a new port.
  try {
    const file = path.join(stateRoot,'scene.json');
    if((await fs.stat(file)).size <= 4096) {
      const previous = JSON.parse(await fs.readFile(file,'utf8'));
      const id = previous.enabled === true && typeof previous.url === 'string' ? /^http:\/\/127\.0\.0\.1:\d+\/s\/[a-f0-9]{64}\/scene\/([a-f0-9]{24})$/.exec(previous.url)?.[1] : null;
      if(id) {
        projects = await discover();
        const project = projects.get(id);
        if(project?.type === 'scene') await saveScene({enabled:true,url:`http://127.0.0.1:${server.address().port}${scenePrefix}/scene/${id}`,name:project.name});
      }
    }
  } catch {}
  try {
    const state = path.join(stateRoot,'dsh-native.json');
    if((await fs.stat(state)).size <= 4096 && JSON.parse(await fs.readFile(state,'utf8')).enabled === true) await ensureDsh();
  } catch {}
  return {server,url:`http://127.0.0.1:${server.address().port}/?key=${token}`,hasActiveScene:()=>activeScene};
}
