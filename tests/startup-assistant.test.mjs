import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile),windows={skip:process.platform!=='win32',timeout:60000};
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const bridge=fileURLToPath(new URL('../plugins/gpt-wallpaper/scripts/assistant-command.ps1',import.meta.url));
const installer=fileURLToPath(new URL('../plugins/gpt-wallpaper/scripts/install-startup-assistant.ps1',import.meta.url));
async function fixture(t){
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'startup-assistant-'));
  const registrySubKey='Software\\CodexWallpaperEngine\\Tests\\StartupAssistant\\'+randomUUID().replaceAll('-','');
  let count=0;
  async function run(code){const script=path.join(root,`test-${count++}.ps1`);await fs.writeFile(script,'\uFEFF'+`$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n${code}`);return await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',script],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});}
  t.after(async()=>{await run(`$key=[Microsoft.Win32.Registry]::CurrentUser\n$key.DeleteSubKeyTree(${quote(registrySubKey)},$false)`);await fs.rm(root,{recursive:true,force:true});});
  const state=path.join(root,'独立状态'),contentId='c'.repeat(64),installed=path.join(state,'GPTWallpaper','installed',contentId);
  await fs.mkdir(path.join(installed,'manager'),{recursive:true});await fs.mkdir(path.join(installed,'scripts'),{recursive:true});
  const manager=path.join(installed,'manager','CodexDreamSkinManager.exe');
  await fs.writeFile(manager,'inert manager fixture; never executed');await fs.writeFile(path.join(installed,'scripts','assistant-command.ps1'),'# inert fixture');
  await fs.writeFile(path.join(state,'GPTWallpaper','launcher-install.json'),JSON.stringify({schema:1,product:'codex-wallpaper-launcher',contentId,installedPath:installed}));
  return {root,state,installed,manager,registrySubKey,registryPath:'HKCU:\\'+registrySubKey,run,
    install:async(action='Install',extra='')=>{const {stdout}=await run(`& ${quote(installer)} -Action ${action} -StateRoot ${quote(state)} -RegistryPath ${quote('HKCU:\\'+registrySubKey)} ${extra}\nif($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`);return JSON.parse(stdout.trim());}};
}

test('assistant bridge selection and takeover use only injected process mocks',windows,async t=>{
  const f=await fixture(t);
  const {stdout}=await f.run(`
. ${quote(bridge)}
function Assert($condition,$message){if(-not $condition){throw $message}}
$script:now=[datetime]::Parse('2026-10-29T12:00:10.1234567Z').ToUniversalTime()
$script:exe='C:\\Fixture\\app\\ChatGPT.exe'
$script:state='C:\\FixtureState'
function Get-WallpaperAssistantNow {return $script:now}
function Get-WallpaperAssistantWindows($ProcessId){if($script:hidden -and $ProcessId -eq 100){return @()};return @(9000+$ProcessId)}
function Test-WallpaperAssistantConsent {return $script:consent}
function Enter-WallpaperAssistantOperation {return [pscustomobject]@{mock=$true}}
function Exit-WallpaperAssistantOperation($Mutex){}
function MakeRow($id,$parent,$arguments,$age=2){return [pscustomobject]@{processId=$id;parentId=$parent;sessionId=7;executable=$script:exe;commandLine=($arguments -join '|');startedAt=$script:now.AddSeconds(-$age).ToString('o');arguments=@($arguments);identityVerified=$true}}
function Reset {
  $script:consent=$true;$script:hidden=$false;$script:close=@();$script:stops=@();$script:onClose='none'
  $script:rows=@((MakeRow 100 1 @($script:exe)),(MakeRow 101 100 @($script:exe,'--type=renderer')),(MakeRow 200 1 @($script:exe,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=9335',('--user-data-dir='+$script:state+'\\CodexDreamSkin\\cdp-profile')) 300))
}
function Get-WallpaperAssistantContext {
  $copy=@($script:rows|ForEach-Object {$_|Select-Object *})
  $installs=@([pscustomobject]@{executable=$script:exe})
  return [pscustomobject]@{installations=$installs;processes=$copy;sessionId=7;roots=@(Get-WallpaperAssistantRoots $copy $installs 7 $script:now $script:state)}
}
function Request-WallpaperAssistantClose($Expected){
  $script:close+=$Expected.processId
  if($script:onClose -eq 'pause'){$script:consent=$false}
  if($script:onClose -eq 'reuse'){$script:rows[1].startedAt=$script:now.AddSeconds(-1).ToString('o')}
  if($script:onClose -eq 'new-root'){$script:rows+=MakeRow 300 1 @($script:exe) 100}
  if($script:onClose -eq 'new-child'){$script:rows+=MakeRow 102 100 @($script:exe,'--type=utility')}
  return $true
}
function Stop-WallpaperAssistantCaptured($Expected,$Root){$script:stops+=$Expected.processId;$script:rows=@($script:rows|Where-Object processId -ne $Expected.processId);return $true}
function Wait-WallpaperAssistantDelay {}
Assert (Test-WallpaperAssistantTimestampPrecision '2026-10-29T12:00:00.0000000Z' '2026-10-29T12:00:00.0000003Z') 'CIM microsecond/native 100ns mismatch must normalize'
Assert (-not (Test-WallpaperAssistantTimestampPrecision '2026-10-29T12:00:00.0000000Z' '2026-10-29T12:00:00.0000010Z')) 'Different microseconds must not normalize'
Reset
$expected=$script:rows[0].startedAt
$result=Invoke-WallpaperAssistantTakeover 100 $expected 0 0
Assert ($result.closed -and $result.takenOver) 'Scoped takeover should complete'
Assert (($script:stops -join ',') -ceq '100,101') 'Only captured root then captured descendants may stop'
Assert ($script:rows.Count -eq 1 -and $script:rows[0].processId -eq 200) 'Managed bystander must survive'
Reset;$script:consent=$false
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
Assert ($result.reason -eq 'consent_revoked' -and $script:close.Count -eq 0 -and $script:stops.Count -eq 0) 'Revoked consent must prevent initial close'
Reset;$script:onClose='pause'
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 100 0
Assert ($result.reason -eq 'consent_revoked' -and $script:stops.Count -eq 0) 'Pause during grace must prevent all remaining kills'
foreach($scenario in @('reuse','new-root','new-child')){
  Reset;$script:onClose=$scenario
  $result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
  Assert (-not $result.closed -and $script:stops.Count -eq 0) ('Changed graph/PID identity must refuse: '+$scenario)
}
Reset;$script:hidden=$true
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
Assert ($result.reason -eq 'not_visible' -and $script:close.Count -eq 0) 'Hidden startup must not be converted'
Reset;$script:now=$script:now.AddSeconds(20)
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
Assert ($result.reason -eq 'too_old' -and $script:close.Count -eq 0) 'Old app roots must not close'
Reset;$script:rows[0].arguments=@($script:exe,'--single-argument','codex://oauth/example');$script:rows[0].commandLine='opaque callback'
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
Assert ($result.reason -eq 'not_plain' -and $script:close.Count -eq 0) 'Deeplinks must remain untouched'
@{ok=$true;mockOnly=$true;cases=10}|ConvertTo-Json -Compress
`);
  assert.equal(JSON.parse(stdout.trim()).ok,true);
});

test('assistant installer backs up and restores only its isolated registry value and configuration',windows,async t=>{
  const f=await fixture(t),configPath=path.join(f.state,'GPTWallpaper','startup-assistant.json');
  const previous=JSON.stringify({schema:1,enabled:false,paused:true,launcherPath:f.manager});await fs.writeFile(configPath,previous);
  const privateRun='"C:\\Private\\previous-helper.exe" --private';
  await f.run(`$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(f.registrySubKey)})\n$key.SetValue('CodexWallpaperStartupAssistant',${quote(privateRun)},[Microsoft.Win32.RegistryValueKind]::ExpandString)\n$key.Dispose()`);
  const installed=await f.install();assert.equal(installed.enabled,true);assert.equal(installed.launcherPath,f.manager);
  const settings=JSON.parse(await fs.readFile(configPath,'utf8'));assert.deepEqual(Object.keys(settings),['schema','enabled','paused','launcherPath']);assert.equal(settings.paused,false);
  const {stdout}=await f.run(`$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(f.registrySubKey)})\n@{value=$key.GetValue('CodexWallpaperStartupAssistant',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=$key.GetValueKind('CodexWallpaperStartupAssistant').ToString()}|ConvertTo-Json -Compress\n$key.Dispose()`);
  assert.deepEqual(JSON.parse(stdout.trim()),{value:'"'+f.manager+'" --assistant',kind:'String'});
  const removed=await f.install('Uninstall');assert.equal(removed.removedRun,true);assert.equal(removed.restoredConfig,true);assert.equal(await fs.readFile(configPath,'utf8'),previous);
  const restored=await f.run(`$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(f.registrySubKey)})\n@{value=$key.GetValue('CodexWallpaperStartupAssistant',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=$key.GetValueKind('CodexWallpaperStartupAssistant').ToString()}|ConvertTo-Json -Compress\n$key.Dispose()`);
  assert.deepEqual(JSON.parse(restored.stdout.trim()),{value:privateRun,kind:'ExpandString'});
});

test('assistant uninstall preserves later private edits and invalid stable payloads cannot be enabled',windows,async t=>{
  const f=await fixture(t);await f.install();
  const configPath=path.join(f.state,'GPTWallpaper','startup-assistant.json');
  const edited=JSON.stringify({schema:1,enabled:true,paused:true,launcherPath:f.manager});await fs.writeFile(configPath,edited);
  await f.run(`$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(f.registrySubKey)})\n$key.SetValue('CodexWallpaperStartupAssistant','private later edit')\n$key.Dispose()`);
  const result=await f.install('Uninstall');assert.deepEqual(result.preserved,['registry','configuration']);assert.equal(await fs.readFile(configPath,'utf8'),edited);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.state,'GPTWallpaper','startup-assistant-install.json'),'utf8')).active,false,'liveness must be revoked even while private configuration is retained');
  const manifestPath=path.join(f.state,'GPTWallpaper','launcher-install.json');const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));manifest.installedPath=path.join(f.root,'cache');await fs.writeFile(manifestPath,JSON.stringify(manifest));
  await assert.rejects(f.install(),/stable installed payload|privately edited/);
});

test('assistant production autostart rejects a custom state root before any registry access',windows,async t=>{
  const f=await fixture(t);
  const {stdout}=await f.run(`
. ${quote(installer)}
$StateRoot=${quote(f.state)}
$RegistryPath='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
function Get-AssistantRunRecord {throw 'Unexpected registry access'}
function Set-AssistantRunRecord {throw 'Unexpected registry write'}
$rejected=$false
try{Invoke-AssistantInstallation|Out-Null}catch{if($_.Exception.Message -notmatch 'default shared state root'){throw};$rejected=$true}
if(-not $rejected){throw 'Custom production state was accepted'}
@{ok=$true;registryAccess=$false}|ConvertTo-Json -Compress
`);
  assert.equal(JSON.parse(stdout.trim()).ok,true);
});

test('inactive assistant journals permit explicit reinstallation after an owned registry restore',windows,async t=>{
  const f=await fixture(t);await f.install();
  const config=path.join(f.state,'GPTWallpaper','startup-assistant.json');
  await fs.writeFile(config,JSON.stringify({schema:1,enabled:true,paused:true,launcherPath:f.manager}));
  const removed=await f.install('Uninstall');assert.deepEqual(removed.preserved,['configuration']);
  await f.install();
  assert.equal(JSON.parse(await fs.readFile(config,'utf8')).paused,false);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.state,'GPTWallpaper','startup-assistant-install.json'),'utf8')).active,true);
});

test('assistant consent reads only the exact active installed payload and revoked journals deny it',windows,async t=>{
  const f=await fixture(t);await f.install();
  const localBridge=path.join(f.installed,'scripts','assistant-command.ps1');await fs.copyFile(bridge,localBridge);
  const configPath=path.join(f.state,'GPTWallpaper','startup-assistant.json'),journalPath=path.join(f.state,'GPTWallpaper','startup-assistant-install.json');
  const originalConfig=JSON.parse(await fs.readFile(configPath,'utf8')),originalJournal=JSON.parse(await fs.readFile(journalPath,'utf8'));
  async function consent(){const {stdout}=await f.run(`$env:CODEX_DREAM_SKIN_LOCAL_APPDATA=${quote(f.state)}\n. ${quote(localBridge)}\n@{allowed=(Test-WallpaperAssistantConsent)}|ConvertTo-Json -Compress`);return JSON.parse(stdout.trim()).allowed;}
  assert.equal(await consent(),true);
  for(const config of [{...originalConfig,paused:true},{...originalConfig,enabled:false},{...originalConfig,privateExtra:true},{...originalConfig,launcherPath:path.join(f.root,'cache','CodexDreamSkinManager.exe')}]){await fs.writeFile(configPath,JSON.stringify(config));assert.equal(await consent(),false);}
  await fs.writeFile(configPath,JSON.stringify(originalConfig));
  for(const journal of [{...originalJournal,active:false},{...originalJournal,ownedRun:{...originalJournal.ownedRun,value:'"'+f.manager+'" --launch'}}]){await fs.writeFile(journalPath,JSON.stringify(journal));assert.equal(await consent(),false);}
  await fs.unlink(journalPath);assert.equal(await consent(),false);
  await fs.writeFile(journalPath,JSON.stringify(originalJournal));
  const paused={...originalConfig,enabled:true,paused:true};await fs.writeFile(configPath,JSON.stringify(paused));await f.install('Uninstall');
  assert.deepEqual(JSON.parse(await fs.readFile(configPath,'utf8')),paused);assert.equal(await consent(),false);
});
