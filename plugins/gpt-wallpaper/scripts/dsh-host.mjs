// Codex adapter around pinned MIT dsh-wallpaper-engine host modules.
// All upstream state lives in the caller's separate dataDir, never ~/.dsh*.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export const DSH_COMMIT = '7ba44b2424e55b70fe28fea753a7abf27ae7cdb3';
const vendor = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../vendor/dsh-engine/source');
const bundlePaths = [
  'lib/client.js','packages/fonts/lib/client.fonts.js','packages/fx/lib/client.fx.js',
  'packages/parallax/lib/client.parallax.js','packages/pet-link/lib/client.pet-link.js',
];
let liveHost = null;
const packageIds = ['about-notice','mascot-avatar','media-bridge','fonts','fx','parallax','pet-link'];

// Relative ESM resolution wrappers are portable across workspace/cache copies.
// No machine-specific junctions, npm install, lifecycle scripts or global packages.
export async function ensureDshDependencies(sourceRoot = vendor) {
  for(const id of packageIds) {
    const name = `dsh-plugin-wallpaper-engine-${id}`;
    const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot,'packages',id,'package.json'),'utf8'));
    if(manifest.name !== name) throw new Error('Unexpected vendored subpackage identity');
    const directory = path.join(sourceRoot,'node_modules',name);
    await fs.mkdir(directory,{recursive:true});
    await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({type:'module',main:'index.js',name}));
    await fs.writeFile(path.join(directory,'index.js'),`export * from '../../packages/${id}/lib/index.js';\n`);
  }
  const engine = path.join(sourceRoot,'node_modules','webwallgl');
  await fs.mkdir(engine,{recursive:true});
  for(const file of ['package.json','LICENSE','webwallgl.mjs','webwallgl.global.min.js']) {
    await fs.copyFile(path.join(sourceRoot,'runtime-deps','webwallgl',file),path.join(engine,file));
  }
}

export async function createDshHost(options = {}) {
  if(liveHost) throw new Error('A DSH host is already active in this process');
  const token = options.token ?? randomBytes(32).toString('hex');
  if(!/^[a-f0-9]{64}$/.test(token)) throw new Error('DSH token must be 64 hex characters');
  if(typeof options.dataDir !== 'string' || !path.isAbsolute(options.dataDir)) throw new Error('DSH dataDir must be absolute');
  const dataDir = path.resolve(options.dataDir);
  const mount = `/dsh/${token}`;
  const apiBase = mount+'/wallpaper-engine';
  const allowedAppOrigins = new Set(options.allowedOrigins ?? ['app://codex']);
  let origin = options.origin ?? null;
  if(origin && !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(origin)) throw new Error('DSH origin must be loopback HTTP');
  await fs.mkdir(dataDir,{recursive:true});
  await ensureDshDependencies(vendor);
  process.env.DSH_WE_DATA_DIR = dataDir;
  if(options.cacheDir) process.env.DSH_WE_CACHE_DIR = path.resolve(options.cacheDir);
  // This is a Codex host, not a DSH profile: do not probe/alter real DSH profiles.
  process.env.DSH_WE_SKIP_HOST_CHECK = '1';
  const routes = new Map();
  const cleanup = new Set();
  const logs = [];
  const transfers = new Map();
  const transferDirectory = path.join(dataDir,'codex-transfers');
  const transferLimit = 512*1024*1024;
  const chunkLimit = 256*1024;
  let reservedBytes = 0;
  let disposed = false;
  const log = (level,...args)=>{
    logs.push({level,message:args.map(String).join(' ').slice(0,1200),time:Date.now()});
    if(logs.length > 100) logs.shift();
    options.logger?.(level,...args);
  };
  const logger = {info:(...a)=>log('info',...a),warn:(...a)=>log('warn',...a),error:(...a)=>log('error',...a),debug:(...a)=>log('debug',...a),success:(...a)=>log('info',...a)};
  const ctx = {
    webServer:{register(route) {
      if(!route || !['exact','prefix'].includes(route.kind) || typeof route.path !== 'string' || typeof route.handler !== 'function') throw new Error('Invalid upstream route');
      const key = `${route.kind}:${route.path}`;
      if(routes.has(key)) throw new Error('Duplicate upstream route '+route.path);
      routes.set(key,route);return ()=>routes.delete(key);
    }},
    logger:()=>logger,
    effect(fn) {const dispose = fn();if(typeof dispose === 'function') cleanup.add(dispose);return dispose;},
    provide(name,value) {this[name] = value;},
    get(name) {return this[name];},
  };
  const upstream = await import(pathToFileURL(path.join(vendor,'lib/index.js')).href);
  const {hostKernel} = await import(pathToFileURL(path.join(vendor,'lib/host-boot.js')).href);
  try {
    const stopMain = upstream.apply(ctx);
    if(typeof stopMain === 'function') cleanup.add(stopMain);
    for(const name of packageIds) {
      const component = await import(pathToFileURL(path.join(vendor,'packages',name,'lib/index.js')).href);
      const stop = component.apply(ctx);if(typeof stop === 'function') cleanup.add(stop);
    }
  } catch(error) {
    for(const stop of [...cleanup].reverse()) {try {stop();} catch {}}
    throw error;
  }
  function getSelection() {return hostKernel.readSettings() ?? {};}
  async function resolveWallpaper(id) {
    if(typeof id !== 'string' || !id) return null;
    const installDir = await hostKernel.locateWallpaperEngineP();
    const libraries = await hostKernel.owningLibrariesP();
    const projects = await hostKernel.enumerateWallpapersAsync(installDir,libraries);
    const uploads = await hostKernel.enumerateUploadsP();
    const project = [...projects,...uploads].find(p=>p.id === id);
    if(!project) return null;
    return {id:project.id,name:project.title || project.id,type:project.type,
      projectDirectory:project.dirAbs ?? path.dirname(project.fileAbs),mediaPath:project.fileAbs,
      previewPath:project.previewAbs ?? null,raw:project};
  }
  function remap(value) {
    if(typeof value === 'string') return value.startsWith('/wallpaper-engine') ? apiBase+value.slice('/wallpaper-engine'.length) : value;
    if(Array.isArray(value)) return value.map(remap);
    if(value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v)]));
    return value;
  }
  const matchRoute = pathname=>[...routes.values()].sort((a,b)=>b.path.length-a.path.length).find(r=>r.kind === 'exact'?pathname === r.path:pathname === r.path || pathname.startsWith(r.path+'/'));
  async function discardTransfer(transfer) {
    if(!transfers.delete(transfer.id)) return;
    reservedBytes -= transfer.bytes;
    try {await fs.unlink(transfer.file);} catch(error) {if(error.code !== 'ENOENT')log('warn','transfer cleanup failed');}
  }
  const expiryTimer = setInterval(()=>{
    const now = Date.now();
    for(const transfer of transfers.values()) if(!transfer.busy && transfer.expires < now) void discardTransfer(transfer);
  },30000);
  expiryTimer.unref();
  async function uploadJson(req) {
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Upload controls require JSON'),{status:415});
    const chunks = [];let bytes = 0;
    for await(const chunk of req) {bytes += chunk.length;if(bytes > 400*1024) throw Object.assign(new Error('Upload control body too large'),{status:413});chunks.push(chunk);}
    let value;try {value = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new Error('Invalid upload JSON');}
    if(!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid upload control');
    return value;
  }
  function validatedUploadRoute(route) {
    if(typeof route !== 'string' || route.length > 8192 || !route.startsWith('/wallpaper-engine/') || /[\\\x00-\x20]/.test(route)) throw new Error('Invalid upload target');
    const url = new URL(route,'http://codex.invalid');
    if(url.origin !== 'http://codex.invalid' || url.hash || url.pathname !== route.split('?')[0]) throw new Error('Upload target must be a canonical local route');
    const decoded = decodeURIComponent(url.pathname);
    if(decoded.split('/').some(p=>p === '.' || p === '..') || decoded.includes('\\') || decoded.startsWith('/wallpaper-engine/codex-upload')) throw new Error('Invalid upload target');
    if(!matchRoute(url.pathname)) throw new Error('Upload target is not a registered upstream route');
    return url.pathname+url.search;
  }
  async function handleUpload(req,res,relative,self) {
    const json = (code,data)=>{res.statusCode = code;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));};
    if(req.method !== 'POST') {json(405,{error:'Upload controls require POST'});return;}
    let transfer = null;
    try {
      const input = await uploadJson(req);
      if(relative === '/wallpaper-engine/codex-upload/start') {
        if(Object.keys(input).some(k=>!['route','method','headers','bytes'].includes(k))) throw new Error('Unknown upload option');
        const route = validatedUploadRoute(input.route);
        if(!['POST','PUT','PATCH'].includes(input.method)) throw new Error('Invalid upload method');
        if(!Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > transferLimit) throw Object.assign(new Error('Upload exceeds 512 MiB limit'),{status:413});
        if(transfers.size >= 4 || reservedBytes+input.bytes > transferLimit) throw Object.assign(new Error('Upload capacity busy'),{status:429});
        if(input.headers && (typeof input.headers !== 'object' || Array.isArray(input.headers))) throw new Error('Invalid upload headers');
        const headers = {};
        for(const [name,value] of Object.entries(input.headers || {})) {
          if(!['content-type','x-filename','x-file-name'].includes(name.toLowerCase()) || typeof value !== 'string' || value.length > 1024 || /[\r\n\x00]/.test(value)) throw new Error('Disallowed upload header');
          headers[name.toLowerCase()] = value;
        }
        // Reserve synchronously before filesystem awaits so parallel starts
        // cannot overbook the bounded disk allocation.
        const id = randomBytes(16).toString('hex');const file = path.join(transferDirectory,id+'.tmp');
        transfer = {id,file,route,method:input.method,headers,bytes:input.bytes,received:0,index:0,busy:true,expires:Date.now()+600000};
        transfers.set(id,transfer);reservedBytes += transfer.bytes;
        await fs.mkdir(transferDirectory,{recursive:true});
        const stat = await fs.lstat(transferDirectory);
        if(!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(transferDirectory) !== transferDirectory) throw new Error('Unsafe upload staging directory');
        const handle = await fs.open(file,'wx');await handle.close();
        transfer.busy = false;
        json(200,{id,chunkBytes:chunkLimit});return;
      }
      if(!['/wallpaper-engine/codex-upload/chunk','/wallpaper-engine/codex-upload/finish','/wallpaper-engine/codex-upload/cancel'].includes(relative)) throw new Error('Unknown upload control');
      if(typeof input.id !== 'string' || !/^[a-f0-9]{32}$/.test(input.id)) throw new Error('Invalid transfer ID');
      transfer = transfers.get(input.id);
      if(!transfer) {json(404,{error:'Transfer not found'});return;}
      if(transfer.busy) {json(409,{error:'Transfer has a request in flight'});return;}
      if(transfer.expires < Date.now()) throw new Error('Transfer expired');
      if(relative.endsWith('/cancel')) {await discardTransfer(transfer);json(200,{ok:true});return;}
      transfer.busy = true;
      if(relative.endsWith('/chunk')) {
        if(Object.keys(input).some(k=>!['id','index','data'].includes(k))) throw new Error('Unknown chunk option');
        if(!Number.isSafeInteger(input.index) || input.index !== transfer.index) throw new Error('Chunks must arrive in exact sequence');
        if(typeof input.data !== 'string' || input.data.length > 349528 || input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error('Invalid base64 chunk');
        const bytes = Buffer.from(input.data,'base64');
        if(bytes.toString('base64') !== input.data || bytes.length === 0 || bytes.length > chunkLimit || transfer.received+bytes.length > transfer.bytes) throw new Error('Chunk exceeds declared size');
        await fs.appendFile(transfer.file,bytes);
        transfer.received += bytes.length;transfer.index++;transfer.busy = false;transfer.expires = Date.now()+600000;
        json(200,{ok:true,received:transfer.received,index:transfer.index});return;
      }
      if(transfer.received !== transfer.bytes) throw new Error('Transfer is incomplete');
      const abort = new AbortController();req.once('aborted',()=>abort.abort());
      res.once('close',()=>{if(!res.writableEnded)abort.abort();});
      const stream = createReadStream(transfer.file);
      try {
        // The target is a validated registered route on this exact authenticated
        // loopback origin. Raw bytes never pass through the native CDP proxy.
        const response = await fetch(self+mount+transfer.route,{method:transfer.method,
          headers:{...transfer.headers,'Content-Length':String(transfer.bytes)},body:stream,duplex:'half',signal:abort.signal});
        res.statusCode = response.status;
        for(const name of ['content-type','content-length','content-disposition','cache-control','etag','last-modified']) {
          const value = response.headers.get(name);if(value !== null)res.setHeader(name,value);
        }
        if(response.body) await pipeline(Readable.fromWeb(response.body),res);else res.end();
      } finally {stream.destroy();await discardTransfer(transfer);}
    } catch(error) {
      if(transfer) await discardTransfer(transfer);
      if(!res.headersSent)json(error.status || 400,{error:error.code?'Upload storage or transport failed':error.message});else res.destroy();
    }
  }
  function publicInfo() {
    const prefix = origin ?? '';
    return {base:prefix+apiBase,clientBundles:bundlePaths.map((_,i)=>`${prefix}${mount}/client/${i}.js`),
      commit:DSH_COMMIT,routeCount:routes.size,components:['core','fonts','fx','parallax','mascot-avatar','media-bridge','pet-link','about-notice']};
  }
  async function handle(req,res) {
    const url = new URL(req.url,'http://127.0.0.1');
    if(!url.pathname.startsWith(mount+'/')) {
      // Decline non-DSH routes, but reject DSH namespace requests missing this token.
      if(url.pathname === '/dsh' || url.pathname.startsWith('/dsh/')) {res.writeHead(403);res.end('Forbidden');return true;}
      return false;
    }
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    if(req.headers.host !== expectedHost) {res.writeHead(403);res.end('Invalid host');return true;}
    const requestOrigin = req.headers.origin;
    const self = `http://${expectedHost}`;
    const relative = url.pathname.slice(mount.length);
    // Strictly sandboxed local Web wallpapers have an opaque origin. They may
    // read only their token-registered project resources, never control APIs.
    const opaqueAsset = requestOrigin === 'null' && ['GET','HEAD','OPTIONS'].includes(req.method) && relative.startsWith('/wallpaper-engine/scene-files/');
    if(requestOrigin && requestOrigin !== self && !allowedAppOrigins.has(requestOrigin) && !opaqueAsset) {res.writeHead(403);res.end('Invalid origin');return true;}
    origin = self;
    // Vendored media-origin resolves onto this authenticated mount, never a new listener.
    globalThis.__CODEX_DSH_MEDIA_ORIGIN__ = self+mount;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Access-Control-Allow-Origin',requestOrigin || self);
    res.setHeader('Vary','Origin');
    res.setHeader('Content-Security-Policy',"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self' blob:; frame-ancestors 'self' app:; base-uri 'none'");
    if(req.method === 'OPTIONS') {res.setHeader('Access-Control-Allow-Methods','GET,HEAD,POST,PUT,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Range');res.writeHead(204);res.end();return true;}
    if(relative.startsWith('/wallpaper-engine/codex-upload/')) {await handleUpload(req,res,relative,self);return true;}
    const client = /^\/client\/([0-4])\.js$/.exec(relative);
    if(client && ['GET','HEAD'].includes(req.method)) {
      const bytes = await fs.readFile(path.join(vendor,bundlePaths[Number(client[1])]));
      res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(req.method === 'HEAD'?undefined:bytes);return true;
    }
    if(relative === '/metadata' && req.method === 'GET') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(publicInfo()));return true;}
    const route = matchRoute(relative);
    if(!route) {res.writeHead(404);res.end('DSH route not found');return true;}
    const originalUrl = req.url;
    req.url = relative+url.search;
    res.once('finish',()=>{req.url = originalUrl;});
    const originalHeader = res.setHeader.bind(res);
    res.setHeader = (name,value)=>originalHeader(name,String(name).toLowerCase() === 'access-control-allow-origin' ? (requestOrigin || self):value);
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (status,reason,headers)=>{
      const values = typeof reason === 'object' ? reason : headers;
      const sanitized = values && Object.fromEntries(Object.entries(values).map(([name,value])=>[name,name.toLowerCase() === 'access-control-allow-origin'?(requestOrigin || self):value]));
      return typeof reason === 'string'?originalWriteHead(status,reason,sanitized):originalWriteHead(status,sanitized);
    };
    const originalEnd = res.end.bind(res);
    res.end = function(chunk,encoding,callback) {
      let output = chunk;
      const mime = String(res.getHeader('Content-Type') || '');
      if(chunk && /application\/json/i.test(mime)) {
        try {output = JSON.stringify(remap(JSON.parse(Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk))));res.removeHeader('Content-Length');} catch {}
      }
      if(chunk && /text\/html/i.test(mime)) {
        output = (Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk))
          .replaceAll('"/wallpaper-engine','"'+apiBase).replaceAll("'/wallpaper-engine","'"+apiBase);
        res.removeHeader('Content-Length');
      }
      const changing = relative.startsWith('/wallpaper-engine/settings') && ['POST','PUT'].includes(req.method) && res.statusCode < 400;
      if(changing && options.onSettingsChanged) {
        Promise.resolve().then(async()=>{
          const selection = getSelection();const wallpaper = await resolveWallpaper(String(selection.id || ''));
          await options.onSettingsChanged(selection,wallpaper);
          originalEnd(output,encoding,callback);
        }).catch(error=>{
          log('error','settings bridge failed:',error.message);
          if(!res.headersSent) {res.statusCode = 500;originalHeader('Content-Type','application/json');originalEnd(JSON.stringify({error:error.message}));} else originalEnd(output,encoding,callback);
        });
        return res;
      }
      return originalEnd(output,encoding,callback);
    };
    try {await route.handler(req,res);} catch(error) {
      log('error',error.message);if(!res.headersSent) {res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));} else res.destroy(error);
    }
    return true;
  }
  async function dispose() {
    if(disposed) return;disposed = true;
    clearInterval(expiryTimer);
    await Promise.all([...transfers.values()].map(discardTransfer));
    for(const stop of [...cleanup].reverse()) {try {await stop();} catch(error) {log('warn',error.message);}}
    cleanup.clear();routes.clear();liveHost = null;
  }
  liveHost = {handle,publicInfo,getSelection,resolveWallpaper,dispose,diagnostics:()=>logs.slice(),vendor};
  return liveHost;
}
