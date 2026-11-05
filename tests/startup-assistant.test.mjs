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

test('assistant native window inventory excludes Chromium auxiliary windows and preserves real ambiguity',windows,async t=>{
  const f=await fixture(t);
  const {stdout}=await f.run(`
. ${quote(bridge)}
Initialize-WallpaperAssistantNative
# These are our own off-screen, non-activating fixture windows. No running
# application is focused, hidden, closed or sent a message.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AssistantWindowFixture {
  private delegate IntPtr WindowProc(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  private static readonly WindowProc Procedure = DefWindowProcW;
  private static readonly List<IntPtr> Created = new List<IntPtr>();
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct WindowClass {
    public uint style; public IntPtr procedure; public int classExtra; public int windowExtra;
    public IntPtr instance; public IntPtr icon; public IntPtr cursor; public IntPtr background;
    public string menuName; public string className;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern ushort RegisterClassW(ref WindowClass value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateWindowExW(uint extended, string name, string title, uint style, int x, int y, int width, int height, IntPtr owner, IntPtr menu, IntPtr instance, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr DefWindowProcW(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetModuleHandleW(string name);
  public static void Register(string name) {
    var value = new WindowClass { procedure=Marshal.GetFunctionPointerForDelegate(Procedure), instance=GetModuleHandleW(null), className=name };
    if(RegisterClassW(ref value)==0) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static long Create(string name, string title, bool tool, bool visible, long owner) {
    // WS_EX_NOACTIVATE, WS_POPUP, optionally WS_VISIBLE, and WS_EX_TOOLWINDOW.
    var window=CreateWindowExW(0x08000000u | (tool?0x80u:0u),name,title,0x80000000u | (visible?0x10000000u:0u),-32000,-32000,8,8,new IntPtr(owner),IntPtr.Zero,GetModuleHandleW(null),IntPtr.Zero);
    if(window==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    Created.Add(window); return window.ToInt64();
  }
  public static void Remove(long window) { var handle=new IntPtr(window); if(!DestroyWindow(handle)) throw new Win32Exception(); Created.Remove(handle); }
  public static void Cleanup() { foreach(var window in Created) DestroyWindow(window); Created.Clear(); }
}
'@
function Assert($condition,$message){if(-not $condition){throw $message}}
try {
  [AssistantWindowFixture]::Register('Chrome_WidgetWin_1')
  [AssistantWindowFixture]::Register('Assistant_Fixture_Other')
  $main=[AssistantWindowFixture]::Create('Chrome_WidgetWin_1','Fixture primary',$false,$true,0)
  $null=[AssistantWindowFixture]::Create('Chrome_WidgetWin_1','',$false,$true,0)
  $null=[AssistantWindowFixture]::Create('Chrome_WidgetWin_1','Fixture tool',$true,$true,0)
  $null=[AssistantWindowFixture]::Create('Assistant_Fixture_Other','Other class',$false,$true,0)
  $null=[AssistantWindowFixture]::Create('Chrome_WidgetWin_1','Hidden fixture',$false,$false,0)
  $null=[AssistantWindowFixture]::Create('Chrome_WidgetWin_1','Owned popup',$false,$true,$main)
  $windows=@(Get-WallpaperAssistantWindows $PID)
  Assert ($windows.Count -eq 1 -and $windows[0] -eq $main) 'Auxiliary windows must not make a single primary ineligible'
  Assert (@(Get-WallpaperAssistantWindows ($PID+500000)).Count -eq 0) 'The process owner must match'
  $second=[AssistantWindowFixture]::Create('Chrome_WidgetWin_1','Second actual window',$false,$true,0)
  Assert (@(Get-WallpaperAssistantWindows $PID).Count -eq 2) 'Two actual application windows must remain ambiguous'
  [AssistantWindowFixture]::Remove($second)
  Assert (@(Get-WallpaperAssistantWindows $PID).Count -eq 1) 'The remaining primary must become eligible again'
  @{ok=$true;actualWindows=$true;applicationActions=$false}|ConvertTo-Json -Compress
} finally { [AssistantWindowFixture]::Cleanup() }
`);
  assert.deepEqual(JSON.parse(stdout.trim()),{ok:true,actualWindows:true,applicationActions:false});
});

test('managed handoff binds the exact browser identity and primary HWND before restoring it',windows,async t=>{
  const f=await fixture(t),engine=path.join(f.root,'managed-engine-fixture.ps1');
  await fs.writeFile(engine,`
function Get-DreamSkinCdpBrowserIdentity($Port){
  if($Port -ne 9335){throw 'Incorrect managed endpoint'}
  if($script:mode -eq 'no-browser'){return $null}
  return [pscustomobject]@{BrowserId=$(if($script:mode -eq 'browser-changed'){'22222222-2222-2222-2222-222222222222'}else{'11111111-1111-1111-1111-111111111111'})}
}
function Get-DreamSkinManagedWindowIdentity($Codex,$Port,$BrowserId,$ProfilePath){
  if($Codex.Executable -cne 'C:\\Fixture\\app\\ChatGPT.exe' -or $ProfilePath -cne 'C:\\FixtureState\\CodexDreamSkin\\cdp-profile'){throw 'Incorrect managed profile/executable'}
  if($script:mode -eq 'wrong-exe'){return $null}
  return [pscustomobject]@{ProcessId=$(if($script:mode -eq 'wrong-pid'){201}else{200});SessionId=$(if($script:mode -eq 'wrong-session'){8}else{7});StartedAt=$(if($script:mode -eq 'reused-pid'){'2026-10-29T12:01:00.1234560Z'}else{'2026-10-29T12:00:00.1234560Z'})}
}
function Get-DreamSkinOwnedCodexWindows($ProcessId,[switch]$IncludeHidden){
  if($ProcessId -ne 200){throw 'Unexpected window process'}
  if($script:mode -eq 'duplicate-window'){return @([IntPtr]9200,[IntPtr]9201)}
  if(-not $IncludeHidden -and -not $script:visible){return @()}
  return @([IntPtr]$(if($script:mode -eq 'window-changed'){9201}else{9200}))
}
function Invoke-DreamSkinOwnedWindowRestore($Window,$ProcessId){
  $script:restored+=([string]$ProcessId+':'+$Window.ToInt64())
  if($script:mode -eq 'restore-failed'){return $false}
  $script:visible=$true;return $true
}
`);
  const {stdout}=await f.run(`
. ${quote(bridge)}
function Assert($condition,$message){if(-not $condition){throw $message}}
function Get-WallpaperAssistantManagedEnginePath {return ${quote(engine)}}
function Get-WallpaperAssistantStateRoot {return 'C:\\FixtureState'}
function Test-WallpaperAssistantConsent {return $script:consent}
function Get-WallpaperAssistantPinnedProcess($Expected){
  $script:pinned++
  $result=[pscustomobject]@{}
  $result|Add-Member ScriptMethod Dispose { }
  return $result
}
function Get-WallpaperAssistantContext {return $script:context}
$process=[pscustomobject]@{processId=200;parentId=1;sessionId=7;executable='C:\\Fixture\\app\\ChatGPT.exe';startedAt='2026-10-29T12:00:00.1234567Z';commandLine='pinned managed argv';identityVerified=$true}
$root=[pscustomobject]@{processId=200;startedAt=$process.startedAt;kind='managed'}
$script:context=[pscustomobject]@{sessionId=7;roots=@($root);processes=@($process);installations=@([pscustomobject]@{executable=$process.executable})}
$script:mode='ready';$script:visible=$false;$script:consent=$true;$script:restored=@();$script:pinned=0
$session=Get-WallpaperAssistantManagedSession $script:context $root
Assert ($session -and $session.window -eq 9200 -and -not $session.visible) 'Exactly owned hidden primary must be capturable without activation'
Assert (-not (Test-WallpaperAssistantManagedSession $session -RequireVisible)) 'A hidden primary is not a completed handoff'
Assert (Restore-WallpaperAssistantManagedSession $session) 'The same verified existing HWND must restore'
Assert (($script:restored -join ',') -ceq '200:9200' -and $script:pinned -eq 1) 'Restore must pin and address only the captured existing owner and HWND'
Assert (Test-WallpaperAssistantManagedSession $session -RequireVisible) 'Restored matching primary must verify'
foreach($mode in @('no-browser','wrong-exe','wrong-pid','wrong-session','reused-pid','duplicate-window')){
  $script:mode=$mode
  Assert ($null -eq (Get-WallpaperAssistantManagedSession $script:context $root)) ('Unproven managed ownership must refuse: '+$mode)
}
foreach($mode in @('browser-changed','window-changed')){
  $script:mode=$mode
  Assert (-not (Test-WallpaperAssistantManagedSession $session)) ('Immutable handoff identity must not drift: '+$mode)
}
$script:mode='ready';$script:consent=$false;$script:restored=@();$script:pinned=0
Assert (-not (Restore-WallpaperAssistantManagedSession $session)) 'Revocation must prevent existing-window activation'
Assert ($script:restored.Count -eq 0 -and $script:pinned -eq 0) 'Disabled handoff must not reach process pinning or window activation'
$script:consent=$true;$script:mode='restore-failed'
Assert (-not (Restore-WallpaperAssistantManagedSession $session)) 'Native restore refusal must not be reported as reused'
@{ok=$true;applicationActions=$false}|ConvertTo-Json -Compress
`);
  assert.deepEqual(JSON.parse(stdout.trim()),{ok:true,applicationActions:false});
});

test('native TCP inventory reports exact listener addresses and owning process for IPv4 and IPv6',windows,async t=>{
  const f=await fixture(t);
  const {stdout}=await f.run(`
. ${quote(bridge)}
Initialize-WallpaperAssistantNative
function Assert($condition,$message){if(-not $condition){throw $message}}
$listeners=@()
try {
  foreach($address in @([Net.IPAddress]::Loopback,[Net.IPAddress]::IPv6Loopback,[Net.IPAddress]::Any)){
    $listener=[Net.Sockets.TcpListener]::new($address,0)
    $listeners+=$listener
    $listener.ExclusiveAddressUse=$true
    if($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6){$listener.Server.DualMode=$false}
    $listener.Start()
    $port=$listener.LocalEndpoint.Port
    $rows=@([CodexWallpaperAssistant.Native]::Listeners($port))
    $owned=@($rows|Where-Object {$_.OwningProcess -eq $PID -and $_.LocalAddress -ceq $address.ToString()})
    Assert ($owned.Count -eq 1) ('Real listener must retain its address and process identity: '+$address)
    $listener.Stop()
    Assert (@([CodexWallpaperAssistant.Native]::Listeners($port)|Where-Object {$_.OwningProcess -eq $PID -and $_.LocalAddress -ceq $address.ToString()}).Count -eq 0) 'A stopped listener must not survive in a cached ownership table'
  }
  $rejected=$false
  try{[CodexWallpaperAssistant.Native]::Listeners(0)|Out-Null}catch{$rejected=$true}
  Assert $rejected 'Invalid TCP ports must fail closed'
  @{ok=$true;actualListeners=3;applicationActions=$false}|ConvertTo-Json -Compress
} finally {foreach($listener in $listeners){$listener.Stop()}}
`);
  assert.deepEqual(JSON.parse(stdout.trim()),{ok:true,actualListeners:3,applicationActions:false});
});

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
  $script:consent=$true;$script:hidden=$false;$script:close=@();$script:stops=@();$script:restores=@();$script:onClose='none';$script:beforeClose='none';$script:contextCalls=0
  $script:managedMode='ready';$script:managedRestores=@()
  $script:rows=@((MakeRow 100 1 @($script:exe)),(MakeRow 101 100 @($script:exe,'--type=renderer')),(MakeRow 200 1 @($script:exe,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=9335',('--user-data-dir='+$script:state+'\\CodexDreamSkin\\cdp-profile')) 300))
}
function Get-WallpaperAssistantContext {
  $script:contextCalls++
  if($script:beforeClose -eq 'typed' -and $script:contextCalls -eq 2){$script:rows+=MakeRow 102 100 @($script:exe,'--type=utility')}
  if($script:beforeClose -eq 'untyped' -and $script:contextCalls -eq 2){$script:rows+=MakeRow 102 100 @($script:exe,'--unexpected')}
  if($script:beforeClose -eq 'busy' -and $script:contextCalls -ge 2){$script:rows+=MakeRow (1000+$script:contextCalls) 100 @($script:exe,'--type=utility')}
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
  if($script:onClose -eq 'new-grandchild'){$script:rows+=MakeRow 102 101 @($script:exe,'--type=renderer')}
  if($script:onClose -eq 'new-untyped-child'){$script:rows+=MakeRow 102 100 @($script:exe,'--other-argument')}
  if($script:onClose -eq 'new-untrusted-type'){$script:rows+=MakeRow 102 100 @($script:exe,'--type=untrusted')}
  if($script:onClose -eq 'orphan-child'){$script:rows=@($script:rows|Where-Object processId -ne 100);$script:rows+=MakeRow 102 100 @($script:exe,'--type=utility')}
  if($script:onClose -eq 'age-crossing'){$script:now=$script:now.AddSeconds(14)}
  if($script:onClose -eq 'expired'){$script:now=$script:now.AddSeconds(21)}
  if($script:onClose -eq 'managed-gone'){$script:rows=@($script:rows|Where-Object processId -ne 200)}
  if($script:onClose -eq 'managed-reused'){@($script:rows|Where-Object processId -eq 200)[0].startedAt=$script:now.AddSeconds(-1).ToString('o')}
  return $true
}
function Stop-WallpaperAssistantCaptured($Expected,$Root){$script:stops+=$Expected.processId;$script:rows=@($script:rows|Where-Object processId -ne $Expected.processId);return $true}
function Restore-WallpaperAssistantWindow($Expected){$script:restores+=$Expected.processId;return @($script:rows|Where-Object { $_.processId -eq $Expected.processId -and $_.startedAt -ceq $Expected.startedAt }).Count -eq 1}
function Get-WallpaperAssistantManagedSession($Context,$ManagedRoot){
  if($script:managedMode -eq 'unavailable'){return $null}
  return [pscustomobject]@{process=@($Context.processes|Where-Object processId -eq $ManagedRoot.processId)[0];browserId='fixture-browser';window=9200;visible=$true}
}
function Restore-WallpaperAssistantManagedSession($Expected){$script:managedRestores+=$Expected.process.processId;return $script:consent -and $script:managedMode -ne 'restore-failed'}
function Test-WallpaperAssistantManagedSession($Expected,[switch]$RequireVisible){
  $live=@($script:rows|Where-Object processId -eq $Expected.process.processId)
  return $live.Count -eq 1 -and (Test-WallpaperAssistantIdentity $Expected.process $live[0])
}
function Wait-WallpaperAssistantDelay {}
Assert (Test-WallpaperAssistantTimestampPrecision '2026-10-29T12:00:00.0000000Z' '2026-10-29T12:00:00.0000003Z') 'CIM microsecond/native 100ns mismatch must normalize'
Assert (-not (Test-WallpaperAssistantTimestampPrecision '2026-10-29T12:00:00.0000000Z' '2026-10-29T12:00:00.0000010Z')) 'Different microseconds must not normalize'
Reset
$expected=$script:rows[0].startedAt
Assert ((Get-WallpaperAssistantRegisteredProcessCount (Get-WallpaperAssistantContext)) -eq 3) 'Registered count must include roots and typed descendants'
$result=Invoke-WallpaperAssistantTakeover 100 $expected 0 0
Assert ($result.closed -and $result.takenOver) 'Scoped takeover should complete'
Assert ($result.reusedManaged -and ($script:managedRestores -join ',') -ceq '200') 'Existing managed window must be restored and reused, not relaunched'
Assert ($result.closeRequested -and -not $result.windowRestored -and $script:restores.Count -eq 0) 'Successful takeover must record close without undo'
Assert (($script:stops -join ',') -ceq '100,101') 'Only captured root then captured descendants may stop'
Assert ($script:rows.Count -eq 1 -and $script:rows[0].processId -eq 200) 'Managed bystander must survive'
foreach($managedFailure in @('unavailable','restore-failed')){
  Reset;$script:managedMode=$managedFailure
  $result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
  Assert ($result.reason -eq 'managed_unavailable' -and -not $result.reusedManaged -and $script:close.Count -eq 0 -and $script:stops.Count -eq 0) ('Unavailable managed window must preserve the ordinary window: '+$managedFailure)
}
Reset;$script:rows+=MakeRow 201 1 @($script:exe,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=9335',('--user-data-dir='+$script:state+'\CodexDreamSkin\cdp-profile')) 300
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
Assert ($result.reason -eq 'ambiguous_roots' -and $script:close.Count -eq 0 -and $script:managedRestores.Count -eq 0) 'Multiple managed browsers must refuse before touching any window'
foreach($scenario in @('managed-gone','managed-reused')){
  Reset;$script:onClose=$scenario
  $result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
  Assert ($result.takenOver -and -not $result.reusedManaged) ('Lost or reused managed browser must never be reported as a successful reuse: '+$scenario)
}
Reset;$script:rows=@($script:rows|Where-Object processId -ne 200)
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
Assert ($result.takenOver -and -not $result.reusedManaged -and $script:managedRestores.Count -eq 0 -and $script:rows.Count -eq 0) 'Cold takeover without managed browser keeps the original cold-start flow'
Reset;$script:beforeClose='typed'
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
$stoppedIds=($script:stops|Sort-Object) -join ','
Assert ($result.takenOver -and $stoppedIds -ceq '100,101,102') 'A verified child appearing between initial snapshots must be captured before close'
foreach($scenario in @('untyped','busy')){
  Reset;$script:beforeClose=$scenario
  $result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
  Assert (-not $result.closeRequested -and $script:close.Count -eq 0 -and $script:stops.Count -eq 0 -and $script:restores.Count -eq 0) ('An unverified or continuously changing graph must be rejected before hiding the window: '+$scenario)
}
Reset;$script:consent=$false
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
Assert ($result.reason -eq 'consent_revoked' -and $script:close.Count -eq 0 -and $script:stops.Count -eq 0) 'Revoked consent must prevent initial close'
Assert ($script:managedRestores.Count -eq 0 -and -not $result.reusedManaged) 'Disabled consent must also prevent managed-window activation'
Assert (-not $result.closeRequested -and -not $result.windowRestored) 'Refusal before close must not restore an untouched window'
Reset;$script:onClose='pause'
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 100 0
Assert ($result.reason -eq 'consent_revoked' -and $script:stops.Count -eq 0) 'Pause during grace must prevent all remaining kills'
Assert ($result.closeRequested -and $result.windowRestored -and ($script:restores -join ',') -ceq '100') 'A failed post-close attempt must restore only its original window'
foreach($scenario in @('new-child','new-grandchild','age-crossing')){
  Reset;$script:onClose=$scenario
  $result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
  Assert ($result.closed -and $result.takenOver) ('Verified startup descendants and admitted age crossing must complete: '+$scenario)
  Assert ($script:rows.Count -eq 1 -and $script:rows[0].processId -eq 200) 'New typed child enrolment must preserve managed bystander'
  $expectedIds=if($scenario -eq 'age-crossing'){'100,101'}else{'100,101,102'}
  Assert ((($script:stops|Sort-Object) -join ',') -ceq $expectedIds) ('Only verified descendants may stop: '+$scenario)
  Assert ($script:stops[0] -eq 100 -and ($scenario -ne 'new-grandchild' -or ($script:stops -join ',') -ceq '100,101,102')) 'New typed descendants must stop only after their exact parents'
}
foreach($scenario in @('reuse','new-root','new-untyped-child','new-untrusted-type','orphan-child')){
  Reset;$script:onClose=$scenario
  $result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
  Assert (-not $result.closed -and $script:stops.Count -eq 0) ('Changed graph/PID identity must refuse: '+$scenario)
  if($scenario -eq 'orphan-child'){
    $script:rows=@($script:rows|Where-Object processId -ne 200)
    $orphanContext=Get-WallpaperAssistantContext
    Assert ($orphanContext.roots.Count -eq 0 -and (Get-WallpaperAssistantRegisteredProcessCount $orphanContext) -eq 2) 'No browser roots must not be mistaken for no application processes'
  }
}
Reset;$script:onClose='expired'
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
Assert ($result.reason -eq 'operation_expired' -and $script:stops.Count -eq 0 -and $result.windowRestored) 'Bounded cleanup expiry must restore the original window without force stopping'
Reset;$script:hidden=$true
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
Assert ($result.reason -eq 'not_visible' -and $script:close.Count -eq 0) 'Hidden startup must not be converted'
Reset;$script:now=$script:now.AddSeconds(20)
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
Assert ($result.reason -eq 'too_old' -and $script:close.Count -eq 0) 'Old app roots must not close'
Reset;$script:rows[0].arguments=@($script:exe,'--single-argument','codex://oauth/example');$script:rows[0].commandLine='opaque callback'
$result=Invoke-WallpaperAssistantTakeover 100 $script:rows[0].startedAt 0 0
Assert ($result.reason -eq 'not_plain' -and $script:close.Count -eq 0) 'Deeplinks must remain untouched'
@{ok=$true;mockOnly=$true;cases=20}|ConvertTo-Json -Compress
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
