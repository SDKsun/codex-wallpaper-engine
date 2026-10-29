import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveSharedLocal} from './paths.mjs';

export async function engineHealth({stateRoot=path.join(resolveSharedLocal(),'CodexDreamSkin'),fetchImpl=fetch,processAlive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}}={}) {
  const result = {state:'not_started',connected:false,renderingVerified:false,message:'聊天背景引擎尚未连接当前 Codex 窗口。'};
  let state;
  try {
    const file = path.join(stateRoot,'state.json');const stat = await fs.lstat(file);
    if(stat.isSymbolicLink() || stat.size > 16384)throw new Error('invalid state');
    state = JSON.parse(await fs.readFile(file,'utf8'));
  } catch {
    try {
      const file=path.join(stateRoot,'startup-error.log');const stat=await fs.lstat(file);
      if(!stat.isSymbolicLink() && stat.size <= 128*1024) {
        const error=(await fs.readFile(file,'utf8')).trim();
        if(error){result.state='startup_failed';result.message='上次引擎启用失败；管理器已保留具体错误。';result.lastError=error.slice(-2000);}
      }
    } catch {}
    return result;
  }
  if(!Number.isInteger(state.port) || state.port < 1024 || state.port > 65535 || !Number.isInteger(state.injectorPid) || state.injectorPid < 1 || !/^[A-Za-z0-9-]{1,128}$/.test(state.browserId || '') || !processAlive(state.injectorPid))return {...result,state:'stale',message:'引擎的旧连接已失效，当前聊天背景尚未启用。'};
  try {
    const response=await fetchImpl(`http://127.0.0.1:${state.port}/json/version`,{signal:AbortSignal.timeout(1200)});
    const text=await response.text();if(!response.ok || text.length > 16384)throw new Error('endpoint failed');
    const version=JSON.parse(text);
    const expected=`ws://127.0.0.1:${state.port}/devtools/browser/${state.browserId}`;
    if(version.webSocketDebuggerUrl !== expected)throw new Error('browser changed');
    return {...result,state:'connected',connected:true,message:'背景引擎已连接；画面是否成功仍需真实界面检测。'};
  } catch {return {...result,state:'stale',message:'引擎连接不可用，当前聊天背景尚未启用。'};}
}
