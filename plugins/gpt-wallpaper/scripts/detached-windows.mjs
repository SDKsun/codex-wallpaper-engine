import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const broker = fileURLToPath(new URL('./detached-launch.ps1',import.meta.url));
const environmentNames = new Set([
  'SystemRoot','WINDIR','SystemDrive','PATH','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA',
  'LOCALAPPDATA','USERNAME','USERDOMAIN','HOMEDRIVE','HOMEPATH','COMSPEC','ProgramFiles',
  'ProgramFiles(x86)','PROGRAMDATA','PROCESSOR_ARCHITECTURE','OS','NUMBER_OF_PROCESSORS',
  'CODEX_DREAM_SKIN_LOCAL_APPDATA',
].map(name=>name.toLowerCase()));
function textArgument(value,label) {
  if(typeof value !== 'string' || value.length > 32760 || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${label}`);
}

// Node detached:true does not request CREATE_BREAKAWAY_FROM_JOB on Windows.
// Use the local WMI provider as broker and prove the child has no job binding.
export async function launchIndependent({executable,args = [],cwd,showWindow = false,environment = {}}) {
  if(process.platform !== 'win32') throw new Error('Independent Windows launcher requires Windows');
  textArgument(executable,'executable');textArgument(cwd,'cwd');
  if(!path.isAbsolute(executable) || !path.isAbsolute(cwd)) throw new Error('Executable and cwd must be absolute');
  if(!Array.isArray(args) || args.length > 256) throw new Error('Arguments must be an array of at most 256 strings');
  for(const argument of args) textArgument(argument,'argument');
  if(typeof showWindow !== 'boolean') throw new Error('showWindow must be boolean');
  if(!environment || typeof environment !== 'object' || Array.isArray(environment)) throw new Error('Environment overrides must be an object');
  for(const [name,value] of Object.entries(environment)) {
    if(!environmentNames.has(name.toLowerCase()) || typeof value !== 'string' || value.includes('\0') || value.length > 32760) throw new Error('Disallowed environment override');
  }
  if(executable.length+args.reduce((sum,arg)=>sum+arg.length*2+3,0)>32000) throw new Error('Windows command line is too long');
  const realExecutable = await fs.realpath(executable);
  const realCwd = await fs.realpath(cwd);
  if(!(await fs.stat(realExecutable)).isFile() || !(await fs.stat(realCwd)).isDirectory()) throw new Error('Executable or cwd is invalid');
  const env = {};
  for(const [name,value] of Object.entries(process.env)) {
    if(!environmentNames.has(name.toLowerCase()) || value === undefined) continue;
    if(typeof value !== 'string' || value.includes('\0') || value.length > 32760) throw new Error('Invalid allowed environment value');
    env[name] = value;
  }
  for(const [name,value] of Object.entries(environment)) {
    for(const existing of Object.keys(env)) if(existing.toLowerCase() === name.toLowerCase()) delete env[existing];
    env[name] = value;
  }
  const payload = JSON.stringify({executable:realExecutable,args,cwd:realCwd,showWindow,env});
  if(Buffer.byteLength(payload,'utf8')>128*1024) throw new Error('Launch payload is too large');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return await new Promise((resolve,reject)=>{
    const child = spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',broker],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout = '',stderr = '',settled = false;
    const finish = (error,result)=>{if(settled)return;settled = true;clearTimeout(timer);if(error)reject(error);else resolve(result);};
    const timer = setTimeout(()=>{
      // This is only our short-lived broker, never the target application.
      child.kill();finish(new Error('Independent process broker timed out; target state is unknown'));
    },15000);
    child.once('error',error=>finish(error));
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',data=>{stdout = (stdout+data).slice(-65536);});
    child.stderr.on('data',data=>{stderr = (stderr+data).slice(-8192);});
    child.once('close',code=>{
      let result;try {result = JSON.parse(stdout.trim().replace(/^\uFEFF/,''));} catch {return finish(new Error('Independent broker returned invalid output: '+stderr.slice(-1000)));}
      if(code !== 0 || result.ok !== true || result.independent !== true || result.verifiedBeforeResume !== true || !Number.isInteger(result.pid) || result.pid <= 0) {
        const error = new Error(result.error || `Independent launch failed (${code})`);
        if(Number.isInteger(result.pid)) error.pid = result.pid;
        return finish(error);
      }
      finish(null,{pid:result.pid,independent:true,verifiedBeforeResume:true,sessionId:result.sessionId,callerJobFlags:result.callerJobFlags});
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(payload,'utf8');
  });
}
