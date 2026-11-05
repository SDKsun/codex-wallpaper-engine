import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const installer=fileURLToPath(new URL('../plugins/gpt-wallpaper/scripts/install-startup-assistant.ps1',import.meta.url));
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const windows={skip:process.platform!=='win32',timeout:90000};

test('assistant payload upgrade preserves disable and pause while updating owned startup paths',windows,async t=>{
  const temporary=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'assistant-upgrade-'));
  const keys=[];
  let sequence=0;
  async function run(code){
    const script=path.join(temporary,`test-${sequence++}.ps1`);
    await fs.writeFile(script,'\uFEFF'+`$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n${code}`);
    return execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',script],{windowsHide:true,timeout:30000,maxBuffer:65536});
  }
  t.after(async()=>{
    for(const key of keys)await run(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${quote(key)},$false)`);
    await fs.rm(temporary,{recursive:true,force:true});
  });
  for(const [enabled,paused] of [[false,false],[true,true],[true,false]]){
    const state=path.join(temporary,`状态-${enabled}-${paused}`);
    const library=path.join(state,'GPTWallpaper');
    const subKey='Software\\CodexWallpaperEngine\\Tests\\StartupAssistant\\'+randomUUID().replaceAll('-','');
    keys.push(subKey);
    const manifest=path.join(library,'launcher-install.json');
    const configFile=path.join(library,'startup-assistant.json');
    async function payload(character){
      const contentId=character.repeat(64),installedPath=path.join(library,'installed',contentId);
      await fs.mkdir(path.join(installedPath,'manager'),{recursive:true});
      await fs.mkdir(path.join(installedPath,'scripts'),{recursive:true});
      await fs.writeFile(path.join(installedPath,'manager','CodexDreamSkinManager.exe'),'inert fixture; never executed');
      await fs.writeFile(path.join(installedPath,'scripts','assistant-command.ps1'),'# inert fixture');
      await fs.writeFile(manifest,JSON.stringify({schema:1,product:'codex-wallpaper-launcher',contentId,installedPath}));
      return path.join(installedPath,'manager','CodexDreamSkinManager.exe');
    }
    async function install(extra=''){
      const {stdout}=await run(`& ${quote(installer)} -StateRoot ${quote(state)} -RegistryPath ${quote('HKCU:\\'+subKey)} ${extra}\nif($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`);
      return JSON.parse(stdout.trim());
    }
    const oldLauncher=await payload('a');
    // A maintenance operation must not opt in an uninstalled helper.
    await assert.rejects(install('-PreserveActivation'));
    assert.equal(await fs.stat(configFile).catch(()=>null),null);
    await install();
    await fs.writeFile(configFile,JSON.stringify({schema:1,enabled,paused,launcherPath:oldLauncher}));
    const nextLauncher=await payload('b');
    const result=await install('-PreserveActivation');
    assert.equal(result.enabled,enabled);
    assert.equal(result.paused,paused);
    assert.deepEqual(JSON.parse(await fs.readFile(configFile,'utf8')),{schema:1,enabled,paused,launcherPath:nextLauncher});
    const {stdout}=await run(`$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(subKey)})\ntry{@{run=$key.GetValue('CodexWallpaperStartupAssistant');names=@($key.GetValueNames())}|ConvertTo-Json -Compress}finally{$key.Dispose()}`);
    const registered=JSON.parse(stdout.trim());
    assert.equal(registered.run,`"${nextLauncher}" --assistant`);
    assert.deepEqual(registered.names,['CodexWallpaperStartupAssistant']);
  }
});
