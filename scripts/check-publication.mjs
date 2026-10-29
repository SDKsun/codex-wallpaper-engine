import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {stdout}=await promisify(execFile)('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,maxBuffer:8*1024*1024});
const files=[...new Set(stdout.split('\0').filter(Boolean))],errors=[];
for(const file of files){
  if(/^(?:build|dist|source|upstream|downloads|vendor)\//.test(file)||/(?:^|\/)(?:node_modules|test-state|\.git|TASK_PROGRESS\.md)(?:\/|$)/.test(file)||/\.(?:exe|dll|pdb|zip|tar|tgz|log|mp4|webm|png|jpe?g)$/i.test(file))errors.push(file+': generated, private, or media artifact');
  const stat=await fs.lstat(path.join(root,file));if(!stat.isFile()||stat.isSymbolicLink()||stat.size>10*1024*1024){errors.push(file+': unexpected type or size');continue;}
  const text=await fs.readFile(path.join(root,file),'utf8');
  if(/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text))errors.push(file+': possible credential');
  if(/[A-Z]:[\\/]Users[\\/]Lenovo[\\/]|D:[\\/]APP[\\/]nodejs/i.test(text))errors.push(file+': machine-specific development path');
}
for(const name of ['LICENSE','README.md','README.en.md','dependencies.lock.json','plugins/gpt-wallpaper/LICENSE-UPSTREAM','plugins/gpt-wallpaper/vendor/dsh/LICENSE','plugins/gpt-wallpaper/THIRD-PARTY-NOTICES.md'])if(!files.includes(name))errors.push(name+': required publication file missing');
if(errors.length){for(const error of errors)console.error(error);process.exitCode=1;}else console.log('Publication check passed: '+files.length+' source/license/documentation files; no generated media or credential matches.');
