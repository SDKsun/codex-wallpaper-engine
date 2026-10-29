import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {launchIndependent} from '../plugins/gpt-wallpaper/scripts/detached-windows.mjs';

test('independent Windows broker preserves literal Unicode/quotes/metacharacters outside caller job',async()=>{
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'codex-independent-中文-'));
  const helper = path.join(directory,'独立助手.mjs');
  const resultFile = path.join(directory,'结果.json');
  const argumentsToKeep = ['','中文 路径','a"quoted"b','trailing\\','two \\slashes\\','& calc.exe | echo bad','$(not-a-command); `literal`','%PATH%'];
  await fs.writeFile(helper,"import fs from 'node:fs/promises';import{spawnSync}from'node:child_process';spawnSync(process.execPath,['-e','process.exit(0)'],{windowsHide:true});await fs.writeFile(process.argv[2],JSON.stringify({pid:process.pid,args:process.argv.slice(3),localAppData:process.env.LOCALAPPDATA,sharedBase:process.env.CODEX_DREAM_SKIN_LOCAL_APPDATA,secret:process.env.CODEX_BROKER_TEST_SECRET}));setTimeout(()=>{},2500);\n");
  const previousLocal = process.env.LOCALAPPDATA;
  const previousSecret = process.env.CODEX_BROKER_TEST_SECRET;
  const localDirectory = path.join(directory,'隔离环境 本地数据');
  const overrideDirectory = path.join(directory,'共享环境 显式覆盖');
  process.env.LOCALAPPDATA = localDirectory;
  process.env.CODEX_BROKER_TEST_SECRET = 'must-not-be-forwarded';
  try {
    const launched = await launchIndependent({executable:process.execPath,args:[helper,resultFile,...argumentsToKeep],cwd:directory,showWindow:false,
      environment:{localappdata:overrideDirectory,CODEX_DREAM_SKIN_LOCAL_APPDATA:overrideDirectory}});
    assert.ok(launched.pid>0);assert.equal(launched.independent,true);assert.equal(launched.verifiedBeforeResume,true);
    let result;
    for(let i=0;i<30;i++) {try {result=JSON.parse(await fs.readFile(resultFile,'utf8'));break;} catch {await new Promise(r=>setTimeout(r,50));}}
    assert.equal(result.pid,launched.pid);assert.deepEqual(result.args,argumentsToKeep);
    assert.equal(result.localAppData,overrideDirectory);assert.equal(result.sharedBase,overrideDirectory);assert.equal(result.secret,undefined);
    // The disposable helper ends itself; do not kill any application processes.
    await new Promise(r=>setTimeout(r,2700));
  } finally {
    if(previousLocal === undefined) delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA = previousLocal;
    if(previousSecret === undefined) delete process.env.CODEX_BROKER_TEST_SECRET;else process.env.CODEX_BROKER_TEST_SECRET = previousSecret;
    await fs.rm(directory,{recursive:true,force:true});
  }
});

test('independent broker rejects malformed launch requests before spawning',async()=>{
  for(const request of [
    {executable:'relative.exe',cwd:process.cwd()},
    {executable:process.execPath,cwd:'relative'},
    {executable:process.execPath,cwd:process.cwd(),args:['bad\nargument']},
    {executable:process.execPath,cwd:process.cwd(),args:'not-array'},
    {executable:process.execPath,cwd:process.cwd(),showWindow:'true'},
    {executable:process.execPath,cwd:process.cwd(),environment:{API_KEY:'must-reject'}},
    {executable:process.execPath,cwd:process.cwd(),environment:{LOCALAPPDATA:'bad\0value'}},
  ]) await assert.rejects(launchIndependent(request));
});

test('independent library daemon honors isolated LOCALAPPDATA and ready-file identity',async()=>{
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'codex-independent-library-'));
  const previousLocal = process.env.LOCALAPPDATA;
  const readyDir = path.join(directory,'GPTWallpaper','ready');await fs.mkdir(readyDir,{recursive:true});
  const readyFile = path.join(readyDir,`library-${randomUUID()}.json`);
  const serverScript = fileURLToPath(new URL('../plugins/gpt-wallpaper/scripts/server.mjs',import.meta.url));
  let launched;
  process.env.LOCALAPPDATA = directory;
  try {
    launched = await launchIndependent({executable:process.execPath,args:[serverScript,'--library','--ready-file',readyFile],cwd:path.dirname(serverScript),showWindow:false});
    assert.equal(launched.verifiedBeforeResume,true);
    let ready;
    for(let i=0;i<300;i++) {try {ready=JSON.parse(await fs.readFile(readyFile,'utf8'));break;} catch {await new Promise(r=>setTimeout(r,50));}}
    assert.ok(ready && Number.isInteger(ready.pid),'The isolated daemon did not publish a valid ready file within 15 seconds');
    assert.equal(ready.pid,launched.pid);
    const ping = new URL('/ping',ready.url);ping.search = new URL(ready.url).search;
    const health = await (await fetch(ping)).json();assert.equal(health.plugin,'gpt-wallpaper');assert.equal(health.apiVersion,5);
  } finally {
    if(previousLocal === undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previousLocal;
    // This PID belongs only to our newly created isolated test daemon.
    if(launched) {try {process.kill(launched.pid);} catch {} await new Promise(r=>setTimeout(r,200));}
    await fs.rm(directory,{recursive:true,force:true});
  }
});
