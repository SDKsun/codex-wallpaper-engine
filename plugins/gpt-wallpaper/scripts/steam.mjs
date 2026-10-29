import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

export async function steamLibraries() {
  const roots = new Set();
  if (process.platform === 'win32') {
    try {
      const {stdout} = await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',"(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -ErrorAction Stop).SteamPath"],{windowsHide:true,timeout:5000});
      if(stdout.trim()) roots.add(path.resolve(stdout.trim()));
    } catch {}
  }
  for (const root of [...roots]) {
    try {
      const vdf = await fs.readFile(path.join(root,'steamapps','libraryfolders.vdf'),'utf8');
      for(const match of vdf.matchAll(/"path"\s*"((?:\\.|[^"\\])*)"/g)) roots.add(path.resolve(match[1].replaceAll('\\\\','\\')));
    } catch {}
  }
  return [...roots];
}

export async function readProject(directory) {
  const root = await fs.realpath(directory);
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('项目目录不能是链接');
  const file = await safeProjectFile(root,'project.json');
  if(file.stat.size > 1024*1024) throw new Error('项目描述过大');
  const data = JSON.parse(await fs.readFile(file.path,'utf8'));
  if(!['scene','video'].includes(data.type)) return null;
  const preview = typeof data.preview === 'string' ? data.preview : '';
  let previewPath = null;
  if(preview && /\.(png|jpe?g|webp)$/i.test(preview)) {
    try { previewPath = (await safeProjectFile(root,preview)).path; } catch {}
  }
  if(data.type === 'scene') {
    try { await safeProjectFile(root,'scene.pkg'); }
    catch { await safeProjectFile(root,typeof data.file === 'string' ? data.file:'scene.json'); }
  }
  let mediaPath = null;
  if(data.type === 'video') {
    if(typeof data.file !== 'string' || !/\.(mp4|webm)$/i.test(data.file)) return null;
    mediaPath = (await safeProjectFile(root,data.file)).path;
  }
  return {id:createHash('sha256').update(root).digest('hex').slice(0,24),root,name:typeof data.title === 'string'?data.title.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,200):path.basename(root),type:data.type,previewPath,mediaPath};
}

export async function safeProjectFile(root,relative) {
  if(typeof relative !== 'string' || !relative || relative.includes('\0') || relative.includes(':') || path.isAbsolute(relative)) throw new Error('无效项目路径');
  const full = path.resolve(root,relative);
  const rel = path.relative(root,full);
  if(!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('项目路径越界');
  const real = await fs.realpath(full);
  if (real !== full) throw new Error('不允许项目链接');
  const stat = await fs.lstat(full);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size > 512*1024*1024) throw new Error('项目文件无效或过大');
  return {path:full,stat};
}

export async function scanSteam(libraries = null) {
  const projects = new Map();
  const roots = libraries ?? await steamLibraries();
  for(const library of roots) {
    const workshop = path.join(library,'steamapps','workshop','content','431960');
    let entries; try {entries = await fs.readdir(workshop,{withFileTypes:true});} catch {continue;}
    for(const entry of entries.slice(0,1000)) {
      if(!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try {const project = await readProject(path.join(workshop,entry.name));if(project) projects.set(project.id,project);} catch {}
    }
  }
  return projects;
}
