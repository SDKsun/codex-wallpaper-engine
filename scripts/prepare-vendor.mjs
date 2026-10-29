// Explicit source preparation; no npm lifecycle hooks or user configuration access.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=promisify(execFile),lock=JSON.parse(await fs.readFile(path.join(root,'dependencies.lock.json'),'utf8'));
const plugin=path.join(root,'plugins/gpt-wallpaper'),target=path.join(plugin,'vendor/dsh-engine/source');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function verifyFiles(directory,files){
  for(const [name,digest]of Object.entries(files))try{if(sha(await fs.readFile(path.join(directory,name)))!==digest)return false;}catch{return false;}
  return true;
}
async function command(file,args,cwd){
  const result=await run(file,args,{cwd,maxBuffer:8*1024*1024,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
  return result.stdout;
}
for(const [name,digest]of Object.entries(lock.patches))if(sha(await fs.readFile(path.join(root,name)))!==digest)throw Error('Patch checksum mismatch: '+name);
const ready=await verifyFiles(target,lock.dsh.preparedFiles);
const standalone=path.join(plugin,'vendor/webwallgl');
if(ready&&await verifyFiles(standalone,lock.webwallgl.standaloneFiles)){console.log('Pinned DSH and WebWallGL dependencies are verified.');process.exit(0);}
if(process.argv.includes('--check'))throw Error('Dependencies are missing or modified; run npm run prepare:vendor.');
if(!ready){try{await fs.lstat(target);throw Error('Existing DSH source differs from the lock. Preserve it and use a clean checkout.');}catch(error){if(error.code!=='ENOENT')throw error;}}

const cache=path.join(root,'build/dependencies');await fs.mkdir(cache,{recursive:true});
const stage=path.join(cache,'prepare-'+randomUUID());await fs.mkdir(stage);
console.log('Fetching the pinned WebWallGL package from npm (no install scripts).');
const response=await fetch(lock.webwallgl.url,{redirect:'error',signal:AbortSignal.timeout(60000)});
if(!response.ok||Number(response.headers.get('content-length'))>16*1024*1024)throw Error('WebWallGL download failed or exceeded its limit');
const parts=[];let bytes=0;for await(const part of response.body){bytes+=part.length;if(bytes>16*1024*1024)throw Error('WebWallGL archive exceeds its limit');parts.push(part);}
const archive=Buffer.concat(parts);if('sha512-'+createHash('sha512').update(archive).digest('base64')!==lock.webwallgl.integrity)throw Error('WebWallGL registry integrity mismatch');
const archivePath=path.join(stage,'webwallgl.tgz');await fs.writeFile(archivePath,archive);
const extracted=path.join(stage,'webwallgl');await fs.mkdir(extracted);
const engineFiles=['package.json','LICENSE','webwallgl.mjs','webwallgl.global.min.js'];
await command('tar',['-xzf',archivePath,'-C',extracted,...engineFiles.map(name=>'package/'+name)],root);
const cleanEngine=path.join(extracted,'package');
const replacements=JSON.parse(await fs.readFile(path.join(plugin,'patches/webwallgl-replacements.json'),'utf8'));
if(!ready){
  const source=path.join(stage,'dsh');await fs.mkdir(source);
  console.log('Fetching DSH commit '+lock.dsh.commit+'.');
  await command('git',['init','-q'],source);await command('git',['config','core.autocrlf','false'],source);
  await command('git',['fetch','--depth','1',lock.dsh.repository,lock.dsh.commit],source);
  await command('git',['checkout','--detach','FETCH_HEAD'],source);
  if((await command('git',['rev-parse','HEAD'],source)).trim()!==lock.dsh.commit)throw Error('DSH source identity mismatch');
  const patch=path.join(plugin,'patches/dsh-codex-adapter.patch');
  await command('git',['apply','--check',patch],source);await command('git',['apply',patch],source);
  const runtime=path.join(source,'runtime-deps/webwallgl');await fs.mkdir(runtime,{recursive:true});
  for(const name of engineFiles)await fs.copyFile(path.join(cleanEngine,name),path.join(runtime,name));
  for(const item of replacements){
    if(!['webwallgl.mjs','webwallgl.global.min.js'].includes(item.name))throw Error('Unknown engine patch target');
    const input=await fs.readFile(path.join(runtime,item.name),'utf8');if(sha(input)!==item.before||input.slice(item.start,item.start+item.from.length)!==item.from)throw Error('Engine patch input mismatch');
    const output=item.prepend+input.slice(0,item.start)+item.to+input.slice(item.start+item.from.length);
    if(sha(output)!==item.after)throw Error('Engine patch result mismatch');await fs.writeFile(path.join(runtime,item.name),output);
  }
  console.log('Building the original five DSH browser modules from patched source.');
  await command(process.execPath,['scripts/build-client.mjs'],source);
  if(!await verifyFiles(source,lock.dsh.preparedFiles))throw Error('Prepared DSH files differ from the reviewed build');
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.cp(source,target,{recursive:true,filter:name=>!['.git','node_modules'].includes(path.basename(name))});
}
await fs.mkdir(standalone,{recursive:true});
for(const name of ['LICENSE','webwallgl.global.min.js'])await fs.copyFile(path.join(cleanEngine,name),path.join(standalone,name));
if(!await verifyFiles(target,lock.dsh.preparedFiles)||!await verifyFiles(standalone,lock.webwallgl.standaloneFiles))throw Error('Dependency verification failed');
console.log('Dependencies prepared and verified. Upstream artwork stays in generated, Git-ignored files.');
