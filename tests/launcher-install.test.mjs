import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';

const execute=promisify(execFile);
const installer=fileURLToPath(new URL('../plugins/gpt-wallpaper/scripts/install-launcher.ps1',import.meta.url));
const windows={skip:process.platform!=='win32',timeout:120000};
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const hash=value=>createHash('sha256').update(value).digest('hex');

async function fixture(t,{unicode=false}={}){
  const temporary=await fs.realpath(os.tmpdir());
  const root=await fs.mkdtemp(path.join(temporary,'codex-launcher-'));
  // Shell may associate links across directories by AppID. Isolate both paths
  // and identity so fixture deletion cannot affect the user's real pin.
  const appId='CodexWallpaperEngine.Test.'+randomUUID().replaceAll('-','');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const plugin=path.join(root,'构建 包'),state=path.join(root,unicode?'状态 🖼 مرح':'状态'),desktop=path.join(root,'桌面'),programs=path.join(root,'开始菜单'),taskbar=path.join(root,'任务栏');
  for(const directory of [plugin,state,desktop,programs,taskbar])await fs.mkdir(directory,{recursive:true});
  const write=async(relative,text)=>{const file=path.join(plugin,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);};
  await write('manager/CodexDreamSkinManager.exe','inert manager fixture; never executed');
  await write('manager/CodexDreamSkinManager.dll','inert assembly fixture');
  await write('scripts/server.mjs','export const fixture=true;');
  await write('engine/scripts/start-dream-skin.ps1','# inert engine fixture');
  await write('vendor/dsh/lib/client.js','export {};');
  await write('vendor/dsh/tests/private.test.mjs','excluded');
  await write('vendor/dsh/node_modules/secret/index.js','excluded');
  await write('scripts/runtime.log','private log');
  await write('engine/state.json','private state');
  await write('private-settings.json','root not allowlisted');
  await write('LICENSE','fixture license');
  let counter=0;
  async function command(code){
    const script=path.join(root,`invoke-${counter++}.ps1`);
    await fs.writeFile(script,'\uFEFF'+code,'utf8');
    return await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',script],{windowsHide:true,timeout:60000,maxBuffer:1024*1024});
  }
  async function install(extra='',prefix='function global:Get-AppxPackage { @() }',options={}){
    const invocation=`& ${quote(installer)} -PluginRoot ${quote(plugin)} -StateRoot ${quote(options.stateRoot??state)} -DesktopDirectory ${quote(desktop)} -ProgramsDirectory ${quote(programs)} -TaskbarDirectory ${quote(taskbar)} -ApplicationId ${quote(options.appId??appId)} ${extra}`;
    const {stdout}=await command(`$ErrorActionPreference='Stop'\n${prefix}\n${invocation}`);
    return JSON.parse(stdout.trim().replace(/^\uFEFF/,''));
  }
  const manifest=async()=>JSON.parse(await fs.readFile(path.join(state,'GPTWallpaper/launcher-install.json'),'utf8'));
  return {root,plugin,state,desktop,programs,taskbar,appId,write,install,command,manifest};
}

test('launcher preserves non-ANSI Unicode targets in a stable payload and correctly identified startup links',windows,async t=>{
  const f=await fixture(t,{unicode:true});
  const result=await f.install();
  assert.equal(result.ok,true);
  assert.match(result.contentId,/^[a-f0-9]{64}$/);
  assert.equal(result.installedPath,path.join(f.state,'GPTWallpaper/installed',result.contentId));
  assert.equal(result.shortcuts.length,2);
  assert.equal(await fs.readFile(path.join(result.installedPath,'scripts/server.mjs'),'utf8'),'export const fixture=true;');
  for(const excluded of ['vendor/dsh/tests','vendor/dsh/node_modules','scripts/runtime.log','engine/state.json','private-settings.json'])await assert.rejects(fs.stat(path.join(result.installedPath,excluded)),{code:'ENOENT'});
  const link=path.join(f.desktop,'Codex.lnk');
  const {stdout}=await f.command(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$a=New-Object -ComObject Shell.Application\n$i=$a.NameSpace(${quote(f.desktop)}).ParseName('Codex.lnk')\n@{target=$i.ExtendedProperty('System.Link.TargetParsingPath');args=$i.ExtendedProperty('System.Link.Arguments');appId=$i.ExtendedProperty('System.AppUserModel.ID')} | ConvertTo-Json -Compress`);
  const shortcut=JSON.parse(stdout.trim());
  assert.equal(shortcut.target,result.managerPath);
  assert.equal(shortcut.args,'--launch');
  assert.equal(shortcut.appId,f.appId);
  const manifest=await f.manifest();
  assert.equal(manifest.schema,1);
  assert.equal(manifest.applicationId,f.appId);
  assert.equal(manifest.links[0].sha256,hash(await fs.readFile(manifest.links[0].path)));
  await fs.rm(f.plugin,{recursive:true});
  assert.ok((await fs.stat(result.managerPath)).isFile(),'removing the source plugin does not break the installed target');
  const removed=await f.install('-Action Uninstall');
  assert.equal(removed.restored.length,2);
  assert.equal(removed.preserved.length,0);
  await assert.rejects(fs.stat(link),{code:'ENOENT'});
  assert.ok((await fs.stat(result.managerPath)).isFile(),'uninstall retains payloads that may still be running');
});

test('launcher refuses a private same-name shortcut before changing any entry',windows,async t=>{
  const f=await fixture(t);
  const privateLink=path.join(f.desktop,'Codex.lnk');
  await fs.writeFile(privateLink,'private shortcut bytes');
  await assert.rejects(f.install(),/private shortcut|Command failed/i);
  assert.equal(await fs.readFile(privateLink,'utf8'),'private shortcut bytes');
  await assert.rejects(fs.stat(path.join(f.programs,'Codex.lnk')),{code:'ENOENT'});
});

test('launcher updates its own links and preserves a later user edit during uninstall',windows,async t=>{
  const f=await fixture(t);
  const first=await f.install();
  await f.write('scripts/server.mjs','export const fixture=2;');
  const second=await f.install();
  assert.notEqual(second.contentId,first.contentId);
  assert.equal((await f.manifest()).links[0].originalBase64,null);
  const privateLink=path.join(f.desktop,'Codex.lnk');
  const ownedBytes=await fs.readFile(privateLink);
  await fs.writeFile(privateLink,'edited by user after installation');
  const removed=await f.install('-Action Uninstall');
  assert.deepEqual(removed.preserved,[privateLink]);
  assert.equal(removed.restored.length,1);
  assert.equal(await fs.readFile(privateLink,'utf8'),'edited by user after installation');
  const remaining=await f.manifest();
  assert.deepEqual(remaining.links.map(link=>link.path),[privateLink],'successfully removed records are not left as false conflicts');
  await fs.writeFile(privateLink,ownedBytes);
  const retried=await f.install('-Action Uninstall');
  assert.deepEqual(retried.restored,[privateLink]);
  assert.equal(retried.preserved.length,0);
  await assert.rejects(fs.stat(path.join(f.state,'GPTWallpaper/launcher-install.json')),{code:'ENOENT'});
});

test('launcher only replaces an exact official link and restores its original bytes',windows,async t=>{
  const f=await fixture(t);
  const officialRoot=path.join(f.root,'registered-store-package');
  await fs.mkdir(path.join(officialRoot,'app'),{recursive:true});
  const exe=path.join(officialRoot,'app/ChatGPT.exe');
  await fs.writeFile(exe,'inert official fixture; never executed');
  const officialLink=path.join(f.desktop,'Codex.lnk');
  const privateLink=path.join(f.programs,'ChatGPT.lnk');
  await f.command(`$s=New-Object -ComObject WScript.Shell\n$l=$s.CreateShortcut(${quote(officialLink)});$l.TargetPath=${quote(exe)};$l.Save()\n$l=$s.CreateShortcut(${quote(privateLink)});$l.TargetPath=${quote(exe)};$l.Arguments='--private-custom-arguments';$l.Save()`);
  const original=await fs.readFile(officialLink),custom=await fs.readFile(privateLink);
  const mock=`function global:Get-AppxPackage { [pscustomobject]@{SignatureKind='Store';PackageFamilyName='OpenAI.Codex_2p2nqsd0c76g0';InstallLocation=${quote(officialRoot)}} }`;
  await f.install('-ReplaceExisting',mock);
  const manifest=await f.manifest();
  const record=manifest.links.find(link=>link.path===officialLink);
  assert.equal(record.originalSha256,hash(original));
  assert.deepEqual(Buffer.from(record.originalBase64,'base64'),original);
  assert.deepEqual(await fs.readFile(privateLink),custom);
  await f.install('-Action Uninstall');
  assert.deepEqual(await fs.readFile(officialLink),original);
  assert.deepEqual(await fs.readFile(privateLink),custom);
});

test('launcher rejects linked payload directories and manifest paths outside its shortcut folders',windows,async t=>{
  const f=await fixture(t);
  const external=path.join(f.root,'external');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external,'private.txt'),'must not be copied');
  await fs.symlink(external,path.join(f.plugin,'vendor/linked'),'junction');
  await assert.rejects(f.install(),/linked file|Command failed/i);
  await fs.unlink(path.join(f.plugin,'vendor/linked'));
  await f.install();
  const manifest=await f.manifest();
  const outside=path.join(f.root,'Codex.lnk');
  await fs.writeFile(outside,'outside link');
  manifest.links[0].path=outside;
  await fs.writeFile(path.join(f.state,'GPTWallpaper/launcher-install.json'),JSON.stringify(manifest));
  await assert.rejects(f.install('-Action Uninstall'),/Invalid launcher shortcut|Command failed/i);
  assert.equal(await fs.readFile(outside,'utf8'),'outside link');
});

test('launcher rejects drive-relative paths and volume roots before writing installation state',windows,async t=>{
  const f=await fixture(t);
  await assert.rejects(f.install('',undefined,{stateRoot:'C:relative'}),/local absolute directory/);
  await assert.rejects(f.install('',undefined,{stateRoot:path.parse(f.root).root}),/volume root/);
  await assert.rejects(fs.stat(path.join(f.state,'GPTWallpaper/launcher-install.json')),{code:'ENOENT'});
});

test('launcher adopts and updates a Unicode pinned target while leaving unpinning to Explorer',windows,async t=>{
  const f=await fixture(t,{unicode:true});
  const first=await f.install();
  assert.deepEqual(await fs.readdir(f.taskbar),[],'installation never creates a pin');
  const pin=path.join(f.taskbar,'Codex.lnk');
  await fs.copyFile(path.join(f.desktop,'Codex.lnk'),pin);
  assert.equal((await f.manifest()).links.length,2,'a later Explorer pin is absent from the original manifest');
  await f.write('scripts/server.mjs','export const fixture="upgrade";');
  const second=await f.install();
  assert.notEqual(second.contentId,first.contentId);
  const manifest=await f.manifest();
  const record=manifest.links.find(link=>link.path===pin);
  assert.equal(record.kind,'taskbar');
  assert.equal(record.originalBase64,null);
  const {stdout}=await f.command(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$a=New-Object -ComObject Shell.Application\n$i=$a.NameSpace(${quote(f.taskbar)}).ParseName('Codex.lnk')\n@{target=$i.ExtendedProperty('System.Link.TargetParsingPath');args=$i.ExtendedProperty('System.Link.Arguments');appId=$i.ExtendedProperty('System.AppUserModel.ID')} | ConvertTo-Json -Compress`);
  const link=JSON.parse(stdout.trim());
  assert.equal(link.target,second.managerPath);
  assert.equal(link.args,'--launch');
  assert.equal(link.appId,f.appId);
  const pinBytes=await fs.readFile(pin);
  const result=await f.install('-Action Uninstall');
  assert.deepEqual(result.taskbarRetained,[pin]);
  assert.equal(result.restored.length,2);
  assert.deepEqual(await fs.readFile(pin),pinBytes,'uninstall never pretends that deleting a file unpins Explorer');
  assert.deepEqual((await f.manifest()).links.map(item=>item.path),[pin]);
  await fs.unlink(pin); // Model the user unpinning in Explorer.
  await f.install('-Action Uninstall');
  await assert.rejects(fs.stat(path.join(f.state,'GPTWallpaper/launcher-install.json')),{code:'ENOENT'});
});

test('launcher upgrade leaves unknown taskbar links with mismatched identity or arguments untouched',windows,async t=>{
  const f=await fixture(t);
  const first=await f.install();
  const unknown=path.join(f.taskbar,'Codex.lnk'),custom=path.join(f.taskbar,'Codex custom.lnk');
  const source=await fs.readFile(path.join(f.desktop,'Codex.lnk'));
  // Alter one same-width Unicode field in an inert link; avoid WSH's ANSI path
  // roundtrip while keeping these deliberately mismatched link fixtures real.
  function replaceText(from,to){
    const before=Buffer.from(from,'utf16le'),after=Buffer.from(to,'utf16le');
    assert.equal(before.length,after.length);
    const offset=source.indexOf(before);assert.ok(offset>=0);
    const changed=Buffer.from(source);after.copy(changed,offset);return changed;
  }
  const wrongId=f.appId.slice(0,-1)+(f.appId.endsWith('0')?'1':'0');
  await fs.writeFile(unknown,replaceText(f.appId,wrongId));
  await fs.writeFile(custom,replaceText('--launch','--custom'));
  const unknownBytes=await fs.readFile(unknown),customBytes=await fs.readFile(custom);
  await f.write('scripts/server.mjs','export const fixture="another upgrade";');
  await f.install();
  assert.equal((await f.manifest()).links.length,2);
  assert.deepEqual(await fs.readFile(unknown),unknownBytes,'matching target and arguments without the AppID is insufficient');
  assert.deepEqual(await fs.readFile(custom),customBytes,'matching AppID without exact arguments is insufficient');
});

test('launcher restricts shell identity and refuses a different identity for an installed state root',windows,async t=>{
  const f=await fixture(t);
  await assert.rejects(f.install('',undefined,{appId:'Unrelated.Application'}),/ApplicationId|ValidatePattern/);
  await assert.rejects(f.install('',undefined,{appId:'CodexWallpaperEngine.'+'a'.repeat(97)}),/ApplicationId|ValidatePattern/);
  await f.install();
  const before=await fs.readFile(path.join(f.desktop,'Codex.lnk'));
  await assert.rejects(f.install('',undefined,{appId:'CodexWallpaperEngine.Test.'+randomUUID().replaceAll('-','')}),/Invalid launcher installation manifest/);
  assert.deepEqual(await fs.readFile(path.join(f.desktop,'Codex.lnk')),before);
});
