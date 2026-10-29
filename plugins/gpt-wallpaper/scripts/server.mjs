import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import readline from 'node:readline';
import {scanSteam} from './steam.mjs';
import {engineHealth} from './health.mjs';
import {launchIndependent} from './detached-windows.mjs';
import {resolveSharedLocal} from './paths.mjs';
import {SERVICE_REVISION} from './service-version.mjs';

const run = promisify(execFile);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm']);
const actions = ['status','open_library','open_manager','use_scene','set_wallpaper','set_reveal','pause','resume','list_themes','use_theme','list_wallpaper_engine','rotation_start','rotation_stop','rotation_status'];
const local = resolveSharedLocal();
const rotationFile = local ? path.join(local, 'GPTWallpaper', 'rotation.json') : '';
const notice = '配置已保存；只有在壁纸管理器已启用引擎时才会显示。首次启用请在管理器确认重启。';
let libraryStarting = null;
async function openLibrary() {
  if(libraryStarting) return libraryStarting;
  libraryStarting = (async()=>{
    const directory = path.join(local,'GPTWallpaper');
    const registry = path.join(directory,'library.json');
    try {
      const stat = await fs.lstat(registry);
      if(stat.isSymbolicLink() || stat.size > 4096) throw new Error('invalid registry');
      const {url} = JSON.parse(await fs.readFile(registry,'utf8'));
      if(typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{4,5}\/\?key=[a-f0-9]{64}$/.test(url)) throw new Error('invalid URL');
      const ping = new URL('/ping',url);ping.search = new URL(url).search;
      const res = await fetch(ping,{signal:AbortSignal.timeout(1200)});
      const health = await res.json();
      if(res.ok && health.plugin === 'gpt-wallpaper' && health.apiVersion === 5 && health.revision === SERVICE_REVISION) return url;
    } catch {}
    const readyDirectory = path.join(directory,'ready');await fs.mkdir(readyDirectory,{recursive:true});
    const readyFile = path.join(readyDirectory,`library-${randomUUID()}.json`);
    const launched = await launchIndependent({executable:process.execPath,args:[fileURLToPath(import.meta.url),'--library','--ready-file',readyFile],cwd:root,showWindow:false,environment:{LOCALAPPDATA:local,CODEX_DREAM_SKIN_LOCAL_APPDATA:local}});
    let url = null;
    const deadline = Date.now()+15000;
    while(Date.now() < deadline) {
      try {
        const stat = await fs.lstat(readyFile);
        if(stat.isSymbolicLink() || stat.size > 4096)throw new Error('invalid readiness file');
        const ready = JSON.parse(await fs.readFile(readyFile,'utf8'));
        if(ready.pid !== launched.pid || !/^http:\/\/127\.0\.0\.1:\d{4,5}\/\?key=[a-f0-9]{64}$/.test(ready.url))throw new Error('invalid ready identity');
        url=ready.url;await fs.unlink(readyFile);break;
      } catch(error) {if(error.code !== 'ENOENT')throw error;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    if(!url) {
      let detail='';try{detail=(await fs.readFile(path.join(directory,'service-error.log'),'utf8')).slice(-1500);}catch{}
      throw new Error('独立壁纸服务启动超时'+(detail?'：'+detail:'；请查看管理器诊断'));
    }
    await fs.mkdir(directory,{recursive:true});
    const temp = registry+'.'+randomUUID()+'.tmp';
    await fs.writeFile(temp,JSON.stringify({url}),{flag:'wx'});await fs.rename(temp,registry);
    return url;
  })();
  try{return await libraryStarting;}finally{libraryStarting = null;}
}
async function restoreSceneService() {
  if(!local) return;
  for(const name of ['scene.json','dsh-native.json']) {
    try {
      const file = path.join(local,'GPTWallpaper',name);const stat = await fs.lstat(file);
      if(!stat.isSymbolicLink() && stat.size <= 4096 && JSON.parse(await fs.readFile(file,'utf8')).enabled === true) {await openLibrary();return;}
    } catch {}
  }
}

export function validate(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !actions.includes(a.action)) throw new Error('无效的 action');
  const allowed = new Set(['action', 'path', 'percent', 'themeId', 'folder', 'seconds']);
  for (const k of Object.keys(a)) if (!allowed.has(k)) throw new Error(`未知参数: ${k}`);
  for (const k of ['path','folder','themeId']) if (a[k] !== undefined && (typeof a[k] !== 'string' || !a[k].trim() || a[k].length > 32760 || /[\r\n\0]/.test(a[k]) || a[k].startsWith('-'))) throw new Error(`无效的 ${k}`);
  if (a.action === 'set_wallpaper' && (!a.path || !path.isAbsolute(a.path) || !extensions.has(path.extname(a.path).toLowerCase()))) throw new Error('需要图片或视频的绝对路径');
  if (a.action === 'set_reveal' && (!Number.isInteger(a.percent) || a.percent < 0 || a.percent > 100)) throw new Error('percent 必须为 0 到 100 的整数');
  if (['use_theme','use_scene'].includes(a.action) && !a.themeId) throw new Error('缺少 themeId');
  if (a.action === 'rotation_start' && (!a.folder || !path.isAbsolute(a.folder) || !Number.isInteger(a.seconds) || a.seconds < 30 || a.seconds > 86400)) throw new Error('轮播需要绝对目录与 30 到 86400 秒间隔');
  return a;
}

async function native(action, parameters = []) {
  const script = path.join(root, 'engine', 'scripts', 'manager-command.ps1');
  const {stdout} = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', script, '-Action', action, ...parameters], {
    windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: {...process.env,LOCALAPPDATA:local,CODEX_DREAM_SKIN_LOCAL_APPDATA:local, PATH: `${path.dirname(process.execPath)};${process.env.PATH || ''}`}
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

async function readRotation() {
  if (!rotationFile) throw new Error('需要 Windows LOCALAPPDATA');
  try { return JSON.parse(await fs.readFile(rotationFile, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {enabled:false}; throw e; }
}
async function writeRotation(value) {
  if (!rotationFile) throw new Error('需要 Windows LOCALAPPDATA');
  await fs.mkdir(path.dirname(rotationFile), {recursive:true});
  const tmp = `${rotationFile}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), {flag:'wx'});
  await fs.rename(tmp, rotationFile);
}
async function disableScene() {
  const directory = path.join(local,'GPTWallpaper');
  await fs.mkdir(directory,{recursive:true});
  const temp = path.join(directory,`scene-${randomUUID()}.tmp`);
  await fs.writeFile(temp,'{"enabled":false}',{flag:'wx'});
  await fs.rename(temp,path.join(directory,'scene.json'));
  const nativeTemp = path.join(directory,`native-${randomUUID()}.tmp`);
  await fs.writeFile(nativeTemp,'{"enabled":false}',{flag:'wx'});await fs.rename(nativeTemp,path.join(directory,'dsh-native.json'));
}
async function filesIn(folder) {
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('轮播目录必须是普通本地目录');
  const entries = await fs.readdir(folder, {withFileTypes:true});
  const files = entries.filter(e=>e.isFile() && extensions.has(path.extname(e.name).toLowerCase())).map(e=>path.join(folder,e.name)).sort();
  if (!files.length || files.length > 500) throw new Error('轮播目录需要 1 到 500 个图片或视频文件');
  return files;
}
async function startChild(args, options = {}) {
  return launchIndependent({executable:process.execPath,args,cwd:options.cwd || root,showWindow:false,environment:{LOCALAPPDATA:local,CODEX_DREAM_SKIN_LOCAL_APPDATA:local}});
}
export async function control(input) {
  const a = validate(input);
  if (process.platform !== 'win32') throw new Error('仅支持 Windows');
  switch (a.action) {
    case 'use_scene': {
      const projects = await scanSteam();
      const matches = [...projects.values()].filter(p=>p.type === 'scene' && (p.id === a.themeId || p.name === a.themeId));
      if(matches.length !== 1) throw new Error('场景名称不存在或不唯一，请先列出 Wallpaper Engine 壁纸并使用准确 ID');
      const library = await control({action:'open_library'});
      const url = new URL('/api',library.url);url.search = new URL(library.url).search;
      const request = async data=>{
        const res = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(15000)});
        const result = await res.json();if(!res.ok) throw new Error(result.error);return result;
      };
      return {...await request({action:'dsh_select',id:path.basename(matches[0].root)}),url:library.url,name:matches[0].name};
    }
    case 'open_library': {
      const view = new URL(await openLibrary());view.pathname='/advanced';
      return {url:view.href,message:'完整壁纸引擎已启动；用 open_in_codex 的 browser 目标打开此 URL。六个原版页签提供壁纸库、外观、播放、系统、扩展和关于。首次聊天背景启用仍由原生管理器确认。',renderingVerified:false};
    }
    case 'open_manager': {
      const exe = path.join(root,'manager','CodexDreamSkinManager.exe');
      await fs.access(exe);
      const launched = await launchIndependent({executable:exe,args:[],cwd:path.dirname(exe),showWindow:true,environment:{LOCALAPPDATA:local,CODEX_DREAM_SKIN_LOCAL_APPDATA:local}});
      return {opened:true,pid:launched.pid,independent:launched.independent,message:'独立壁纸管理器已打开；Codex 重启不会中断它。首次启用由你确认重启。'};
    }
    case 'status': return {...await native('Status'), rotation:await readRotation(), engine:await engineHealth({stateRoot:path.join(local,'CodexDreamSkin')}),renderingVerified:false};
    case 'set_wallpaper': {
      if (!(await fs.stat(a.path)).isFile()) throw new Error('壁纸文件不存在');
      await writeRotation({enabled:false});
      await disableScene();
      return {...await native('SetWallpaper',['-Path',a.path]), message:notice};
    }
    case 'set_reveal': return {...await native('SetReveal',['-Percent',String(a.percent)]), message:notice};
    case 'pause': await writeRotation({enabled:false}); return {...await native('Pause'), message:notice};
    case 'resume': return {...await native('Resume'), message:notice};
    case 'list_themes': return await native('ListThemes');
    case 'use_theme': await writeRotation({enabled:false}); await disableScene(); return {...await native('UseTheme',['-ThemeId',a.themeId]), message:notice};
    case 'list_wallpaper_engine': return {items:[...await scanSteam()].map(([id,p])=>({id,name:p.name,type:p.type})),sceneEngine:'WebWallGL 3.0.0'};
    case 'rotation_stop': await writeRotation({enabled:false}); return {enabled:false};
    case 'rotation_status': return await readRotation();
    case 'rotation_start': {
      const files = await filesIn(a.folder);
      await disableScene();
      const token = randomUUID();
      const value = {enabled:true, token, folder:a.folder, seconds:a.seconds, count:files.length};
      await writeRotation(value);
      try { await startChild([fileURLToPath(import.meta.url),'--rotation',token]); }
      catch (e) { await writeRotation({enabled:false,error:e.message}); throw e; }
      return {...value,message:notice};
    }
  }
}

export async function rotate(token) {
  let next = 0, index = 0;
  while (true) {
    const config = await readRotation();
    if (!config.enabled || config.token !== token) return;
    if (Date.now() >= next) {
      try {
        const files = await filesIn(config.folder);
        await native('SetWallpaper',['-Path',files[index++ % files.length]]);
        next = Date.now() + config.seconds * 1000;
      } catch (e) {
        const current = await readRotation();
        if (current.token === token) await writeRotation({...current,enabled:false,error:e.message});
        return;
      }
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
}

export const tool = {
  name:'wallpaper_control',
  description:'控制 Windows GPT 动态壁纸：打开可视化壁纸库，自动连接 Wallpaper Engine，列出场景并按名称或 ID 实时切换，控制图片/视频、透出度、暂停和轮播。不会自动重启 GPT；配置保存不等于聊天界面渲染成功。',
  inputSchema:{type:'object',properties:{action:{type:'string',enum:actions},path:{type:'string'},percent:{type:'integer',minimum:0,maximum:100},themeId:{type:'string'},folder:{type:'string'},seconds:{type:'integer',minimum:30,maximum:86400}},required:['action'],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
};
export async function dispatch(m) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return {jsonrpc:'2.0',id:m?.id ?? null,error:{code:-32600,message:'Invalid Request'}};
  if (m.id === undefined) return null;
  const reply = result=>({jsonrpc:'2.0',id:m.id,result});
  switch (m.method) {
    case 'initialize': return reply({protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(m.params?.protocolVersion)?m.params.protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'gpt-wallpaper',version:'0.1.0'}});
    case 'ping': return reply({});
    case 'tools/list': return reply({tools:[tool]});
    case 'tools/call': {
      if (m.params?.name !== tool.name) return {jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'Unknown tool'}};
      try {const result = await control(m.params.arguments); return reply({content:[{type:'text',text:JSON.stringify(result)}]});}
      catch (e) {return reply({isError:true,content:[{type:'text',text:e.message}]});}
    }
    default:return {jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}};
  }
}
async function main() {
  if (process.argv[2] === '--library') {
    const {startLibrary} = await import('./library.mjs');
    const {server,url,hasActiveScene} = await startLibrary(control,{stateRoot:path.join(local,'GPTWallpaper'),prepareMediaBridge:true});
    try {
      const readyIndex = process.argv.indexOf('--ready-file');
      if(readyIndex >= 0) {
      const readyFile = path.resolve(process.argv[readyIndex+1] || '');
      const expectedDirectory=path.resolve(local,'GPTWallpaper','ready');
      if(path.dirname(readyFile) !== expectedDirectory || !/^library-[a-f0-9-]{36}\.json$/.test(path.basename(readyFile)))throw new Error('无效服务就绪文件');
      const stat=await fs.lstat(expectedDirectory);
      if(!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(expectedDirectory) !== expectedDirectory)throw new Error('无效服务就绪目录');
      await fs.writeFile(readyFile,JSON.stringify({url,pid:process.pid}),{flag:'wx'});
      } else process.stdout.write(url+'\n');
    } catch(error) {server.closeAllConnections();server.close();throw error;}
    setTimeout(()=>{if(!hasActiveScene()) server.close();},2*60*60*1000).unref();
    return;
  }
  if (process.argv[2] === '--rotation') return rotate(process.argv[3]);
  if (process.argv[2] === '--command') {console.log(JSON.stringify(await control(JSON.parse(process.argv[3]))));return;}
  const rl = readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  for await (const line of rl) {
    let response;
    try {if (line.length > 1024*1024) throw new Error();const message=JSON.parse(line);if(message.method === 'initialize')void restoreSceneService().catch(()=>{});response=await dispatch(message);}
    catch {response={jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}};}
    if (response) process.stdout.write(JSON.stringify(response)+'\n');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(async e=>{
  try {const directory=path.join(local,'GPTWallpaper');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'service-error.log'),String(e.stack || e.message).slice(-8192));} catch {}
  console.error(e.message);process.exitCode=1;
});
