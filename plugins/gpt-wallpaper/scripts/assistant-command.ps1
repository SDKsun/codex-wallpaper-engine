[CmdletBinding()]
param(
  [ValidateSet('Snapshot', 'Takeover')][string]$Action = 'Snapshot',
  [int]$ExpectedProcessId,
  [string]$ExpectedStartedAt
)

$ErrorActionPreference = 'Stop'

function Initialize-WallpaperAssistantNative {
  if ('CodexWallpaperAssistant.Native' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
namespace CodexWallpaperAssistant {
  public static class Native {
    public sealed class ProcessIdentity { public string StartedAt; public string Executable; }
    public sealed class Listener { public string LocalAddress; public int OwningProcess; }
    private delegate bool Callback(IntPtr hwnd, IntPtr data);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr CommandLineToArgvW(string line, out int count);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, int process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr handle, out long created, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder value, ref int size);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("iphlpapi.dll")] private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool ordered, int family, int tableClass, uint reserved);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextLengthW(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] private static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    public static string[] Arguments(string line) {
      int count; IntPtr memory=CommandLineToArgvW(line, out count);
      if(memory==IntPtr.Zero || count<1 || count>128) throw new InvalidOperationException("Invalid process arguments.");
      try { var result=new string[count];for(int i=0;i<count;i++)result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size));return result; }
      finally { LocalFree(memory); }
    }
    public static ProcessIdentity Identity(int process) {
      IntPtr handle=OpenProcess(0x1000,false,process);
      if(handle==IntPtr.Zero)return null;
      try {
        long created,exit,kernel,user;uint code;int size=32768;var image=new StringBuilder(size);
        if(!GetProcessTimes(handle,out created,out exit,out kernel,out user)||!QueryFullProcessImageName(handle,0,image,ref size)||!GetExitCodeProcess(handle,out code)||code!=259)return null;
        return new ProcessIdentity { StartedAt=DateTime.FromFileTimeUtc(created).ToString("o"),Executable=image.ToString() };
      } finally { CloseHandle(handle); }
    }
    private static void ReadListeners(int port, int family, List<Listener> result) {
      int size=0;
      uint error=GetExtendedTcpTable(IntPtr.Zero,ref size,false,family,3,0);
      if(error!=122 || size<4 || size>1048576) throw new InvalidOperationException("Cannot inspect listener ownership.");
      for(int attempt=0;attempt<3;attempt++) {
        int allocated=size;
        IntPtr table=Marshal.AllocHGlobal(allocated);
        try {
          error=GetExtendedTcpTable(table,ref size,false,family,3,0);
          if(size<4 || size>1048576) throw new InvalidOperationException("Invalid listener table size.");
          if(error==122) continue;
          if(error!=0 || size>allocated) throw new InvalidOperationException("Cannot inspect listener ownership.");
          int count=Marshal.ReadInt32(table);
          int rowSize=family==2?24:56;
          if(count<0 || count>(size-4)/rowSize) throw new InvalidOperationException("Invalid listener table rows.");
          for(int index=0;index<count;index++) {
            IntPtr row=IntPtr.Add(table,4+index*rowSize);
            int encoded=Marshal.ReadInt32(row,family==2?8:20);
            int localPort=((encoded&255)<<8)|((encoded>>8)&255);
            if(localPort!=port) continue;
            int state=Marshal.ReadInt32(row,family==2?0:48);
            int owner=Marshal.ReadInt32(row,family==2?20:52);
            if(state!=2 || owner<=0) throw new InvalidOperationException("Invalid listener identity.");
            var address=new byte[family==2?4:16];
            Marshal.Copy(IntPtr.Add(row,family==2?4:0),address,0,address.Length);
            IPAddress ip=family==2?new IPAddress(address):new IPAddress(address,(uint)Marshal.ReadInt32(row,16));
            result.Add(new Listener { LocalAddress=ip.ToString(),OwningProcess=owner });
          }
          return;
        } finally { Marshal.FreeHGlobal(table); }
      }
      throw new InvalidOperationException("Listener table changed repeatedly.");
    }
    public static Listener[] Listeners(int port) {
      if(port<1 || port>65535) throw new ArgumentOutOfRangeException("port");
      var result=new List<Listener>();ReadListeners(port,2,result);ReadListeners(port,23,result);
      return result.ToArray();
    }
    private static bool Owned(IntPtr hwnd, uint process, bool requireVisible=true) {
      uint owner;GetWindowThreadProcessId(hwnd,out owner);
      if(owner!=process || !IsWindow(hwnd) || GetWindow(hwnd,4)!=IntPtr.Zero || (requireVisible&&!IsWindowVisible(hwnd)&&!IsIconic(hwnd)))return false;
      var name=new StringBuilder(256);GetClassName(hwnd,name,name.Capacity);
      // Chromium also creates untitled and tool windows in the browser process.
      // Count only its primary application surface. Keeping the unique-window
      // check then rejects genuinely ambiguous user windows without treating an
      // invisible auxiliary surface as a second application.
      return name.ToString()=="Chrome_WidgetWin_1" && GetWindowTextLengthW(hwnd)>0 && (GetWindowLong(hwnd,-20)&0x80)==0;
    }
    public static long[] Windows(int process) {
      var result=new List<long>();Callback callback=(hwnd,data)=>{if(Owned(hwnd,(uint)process))result.Add(hwnd.ToInt64());return true;};
      EnumWindows(callback,IntPtr.Zero);GC.KeepAlive(callback);return result.ToArray();
    }
    public static bool Close(long window,int process) {
      var hwnd=new IntPtr(window);return Owned(hwnd,(uint)process)&&PostMessage(hwnd,0x0010,IntPtr.Zero,IntPtr.Zero);
    }
    public static bool Restore(int process) {
      var windows=new List<IntPtr>();Callback callback=(hwnd,data)=>{if(Owned(hwnd,(uint)process,false))windows.Add(hwnd);return true;};
      EnumWindows(callback,IntPtr.Zero);GC.KeepAlive(callback);
      if(windows.Count!=1 || !ShowWindowAsync(windows[0],9))return false;
      SetForegroundWindow(windows[0]);
      for(int attempt=0;attempt<8;attempt++) {
        if(Owned(windows[0],(uint)process)&&IsWindowVisible(windows[0]))return true;
        System.Threading.Thread.Sleep(25);
      }
      return false;
    }
  }
}
'@
}

function Get-WallpaperAssistantStateRoot {
  $configured = $env:CODEX_DREAM_SKIN_LOCAL_APPDATA
  if (-not $configured) { $configured = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\wallpaper-local' }
  if ($configured -notmatch '^[A-Za-z]:[\\/]' -or $configured -match '[\x00\r\n]') { throw 'Invalid assistant state path.' }
  return [IO.Path]::GetFullPath($configured)
}

function Test-WallpaperAssistantPath([string]$Left, [string]$Right) {
  if (-not $Left -or -not $Right) { return $false }
  try { return [IO.Path]::GetFullPath($Left).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Right).TrimEnd('\') } catch { return $false }
}

function Get-WallpaperAssistantInstallations {
  $result = @()
  foreach ($package in @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | Sort-Object Version -Descending)) {
    if ($package.PackageFamilyName -cne 'OpenAI.Codex_2p2nqsd0c76g0' -or "$($package.SignatureKind)" -ine 'Store') { continue }
    $root = "$($package.InstallLocation)"
    if ($root -notmatch '^[A-Za-z]:[\\/]' -or $root -match '[\x00\r\n]') { continue }
    $executable = Join-Path ([IO.Path]::GetFullPath($root)) 'app\ChatGPT.exe'
    if (Test-Path -LiteralPath $executable -PathType Leaf) { $result += [pscustomobject]@{ executable=$executable; version="$($package.Version)" } }
  }
  return $result
}

function Get-WallpaperAssistantProcesses {
  Initialize-WallpaperAssistantNative
  $rows = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction Stop)
  if ($rows.Count -gt 512) { throw 'Too many candidate processes.' }
  foreach ($row in $rows) {
    $arguments = @()
    if ($row.CommandLine) { try { $arguments = @([CodexWallpaperAssistant.Native]::Arguments($row.CommandLine)) } catch {} }
    $started = if ($row.CreationDate) { ([datetime]$row.CreationDate).ToUniversalTime().ToString('o') } else { '' }
    $native = [CodexWallpaperAssistant.Native]::Identity([int]$row.ProcessId)
    $verified = $native -and (Test-WallpaperAssistantTimestampPrecision $started $native.StartedAt) -and (Test-WallpaperAssistantPath $row.ExecutablePath $native.Executable)
    if ($verified) { $started=$native.StartedAt }
    [pscustomobject]@{processId=[int]$row.ProcessId;parentId=[int]$row.ParentProcessId;sessionId=[int]$row.SessionId;
      executable="$($row.ExecutablePath)";commandLine="$($row.CommandLine)";startedAt=$started;arguments=$arguments;identityVerified=[bool]$verified}
  }
}

function Get-WallpaperAssistantWindows([int]$ProcessId) {
  Initialize-WallpaperAssistantNative
  return @([CodexWallpaperAssistant.Native]::Windows($ProcessId))
}

function Get-WallpaperAssistantNow { return [datetime]::UtcNow }
function Wait-WallpaperAssistantDelay { Start-Sleep -Milliseconds 100 }
function Test-WallpaperAssistantTimestampPrecision([string]$CimTime, [string]$NativeTime) {
  try {
    $first=[datetime]::Parse($CimTime,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime().Ticks
    $second=[datetime]::Parse($NativeTime,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime().Ticks
    return ($first-($first%10)) -eq ($second-($second%10))
  } catch { return $false }
}

function Test-WallpaperAssistantConsent {
  try {
    $state=Get-WallpaperAssistantStateRoot
    $installed=Join-Path $state 'GPTWallpaper\installed'
    $pluginRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    $prefix=$installed.TrimEnd('\')+'\'
    if(-not $pluginRoot.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or $pluginRoot.Substring($prefix.Length) -cnotmatch '^[a-f0-9]{64}$'){return $false}
    $expected=Join-Path $pluginRoot 'manager\CodexDreamSkinManager.exe'
    $file=Join-Path $state 'GPTWallpaper\startup-assistant.json'
    $journalFile=Join-Path $state 'GPTWallpaper\startup-assistant-install.json'
    foreach($path in @($file,$expected,$journalFile)){
      $probe=$path
      while($probe){$item=Get-Item -LiteralPath $probe -Force -ErrorAction Stop;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){return $false};$probe=[IO.Path]::GetDirectoryName($probe)}
    }
    $item=Get-Item -LiteralPath $file -Force
    if($item.PSIsContainer -or $item.Length -gt 8192){return $false}
    $journalItem=Get-Item -LiteralPath $journalFile -Force
    if($journalItem.PSIsContainer -or $journalItem.Length -gt 65536){return $false}
    $journal=[IO.File]::ReadAllText($journalFile,[Text.Encoding]::UTF8)|ConvertFrom-Json
    if($journal.schema -ne 1 -or $journal.product -cne 'codex-wallpaper-startup-assistant' -or $journal.active -isnot [bool] -or -not $journal.active -or
      $journal.ownedRun.exists -ne $true -or $journal.ownedRun.kind -cne 'String' -or $journal.ownedRun.value -cne ('"'+$expected+'" --assistant')){return $false}
    $config=[IO.File]::ReadAllText($file,[Text.Encoding]::UTF8)|ConvertFrom-Json
    if(@($config.PSObject.Properties).Count -ne 4 -or $config.schema -isnot [int] -or $config.schema -ne 1 -or
      $config.enabled -isnot [bool] -or -not $config.enabled -or $config.paused -isnot [bool] -or $config.paused -or
      $config.launcherPath -isnot [string] -or -not (Test-WallpaperAssistantPath $config.launcherPath $expected)){return $false}
    foreach($property in $config.PSObject.Properties){if($property.Name -cnotin @('schema','enabled','paused','launcherPath')){return $false}}
    return $true
  } catch {return $false}
}

function Test-WallpaperAssistantFresh($Expected) {
  try{$age=((Get-WallpaperAssistantNow)-[datetime]::Parse($Expected.startedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)).TotalSeconds;return $age -ge 0 -and $age -le 15}catch{return $false}
}

function Get-WallpaperAssistantRoots($Processes, $Installations, [int]$SessionId, [datetime]$Now, [string]$StateRoot) {
  $current = @($Installations)[0]
  foreach ($process in @($Processes)) {
    if ($process.sessionId -ne $SessionId) { continue }
    if ($process.executable -and -not (@($Installations | Where-Object { Test-WallpaperAssistantPath $_.executable $process.executable }).Count)) { continue }
    $arguments = @($process.arguments)
    if (@($arguments | Where-Object { $_ -eq '--type' -or $_.StartsWith('--type=') }).Count) { continue }
    $kind = 'unknown'; $plain = $false
    $validExecutable = $current -and $process.identityVerified -eq $true -and (Test-WallpaperAssistantPath $current.executable $process.executable)
    if ($validExecutable -and $arguments.Count -gt 0 -and (Test-WallpaperAssistantPath $arguments[0] $process.executable)) {
      if ($arguments.Count -eq 1) { $kind='normal';$plain=$true }
      elseif ($arguments -ccontains '--remote-debugging-address=127.0.0.1' -and $arguments -ccontains '--remote-debugging-port=9335') {
        $profiles = @($arguments | Where-Object { $_.StartsWith('--user-data-dir=') })
        if ($profiles.Count -eq 1 -and (Test-WallpaperAssistantPath $profiles[0].Substring(16) (Join-Path $StateRoot 'CodexDreamSkin\cdp-profile'))) { $kind='managed' }
      }
    }
    $age = -1.0
    try { $age = ($Now - [datetime]::Parse($process.startedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)).TotalSeconds } catch {}
    $windows = @(Get-WallpaperAssistantWindows $process.processId)
    [pscustomobject]@{processId=$process.processId;startedAt=$process.startedAt;kind=$kind;plainLaunch=$plain;ageSeconds=[math]::Round($age,3);visibleWindow=($windows.Count -eq 1)}
  }
}

function Get-WallpaperAssistantContext {
  $installations = @(Get-WallpaperAssistantInstallations)
  $processes = @(Get-WallpaperAssistantProcesses)
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $roots = @(Get-WallpaperAssistantRoots $processes $installations $session (Get-WallpaperAssistantNow) (Get-WallpaperAssistantStateRoot))
  if ($roots.Count -gt 32) { throw 'Too many application roots.' }
  return [pscustomobject]@{installations=$installations;processes=$processes;roots=$roots;sessionId=$session}
}

function Get-WallpaperAssistantRegisteredProcessCount($Context) {
  $count=0
  foreach($process in @($Context.processes)){
    if($process.sessionId -eq $Context.sessionId -and (-not $process.executable -or @($Context.installations|Where-Object { Test-WallpaperAssistantPath $_.executable $process.executable }).Count)){$count++}
  }
  return $count
}

function Enter-WallpaperAssistantOperation {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $mutex = New-Object Threading.Mutex($false, "Local\CodexDreamSkin.$sid.Operation")
  $acquired = $false
  try { $acquired=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired=$true }
  if (-not $acquired) { $mutex.Dispose();return $null }
  return $mutex
}
function Exit-WallpaperAssistantOperation($Mutex) { if ($Mutex) { try { $Mutex.ReleaseMutex() } finally { $Mutex.Dispose() } } }

function Test-WallpaperAssistantIdentity($Expected, $Actual) {
  return $Actual -and $Expected.identityVerified -eq $true -and $Actual.identityVerified -eq $true -and $Expected.processId -eq $Actual.processId -and $Expected.startedAt -ceq $Actual.startedAt -and
    $Expected.sessionId -eq $Actual.sessionId -and (Test-WallpaperAssistantPath $Expected.executable $Actual.executable) -and
    $Expected.commandLine -ceq $Actual.commandLine
}

function Get-WallpaperAssistantEligibility($Context, [int]$ProcessId, [string]$StartedAt) {
  $root = @($Context.roots | Where-Object { $_.processId -eq $ProcessId })
  if ($root.Count -ne 1) { return 'process_missing' }
  if ($root[0].startedAt -cne $StartedAt) { return 'identity_changed' }
  if ($root[0].kind -cne 'normal' -or -not $root[0].plainLaunch) { return 'not_plain' }
  if (-not $root[0].visibleWindow) { return 'not_visible' }
  if ($root[0].ageSeconds -lt 0 -or $root[0].ageSeconds -gt 15) { return 'too_old' }
  if (@($Context.roots | Where-Object { $_.processId -ne $ProcessId -and $_.kind -cne 'managed' }).Count) { return 'ambiguous_roots' }
  if (@($Context.roots | Where-Object kind -CEQ 'managed').Count -gt 1) { return 'ambiguous_roots' }
  $process = @($Context.processes | Where-Object { $_.processId -eq $ProcessId })
  if ($process.Count -ne 1 -or -not @($Context.installations).Count -or $process[0].sessionId -ne $Context.sessionId -or
      -not (Test-WallpaperAssistantPath $process[0].executable $Context.installations[0].executable)) { return 'identity_changed' }
  return $null
}

function Get-WallpaperAssistantCapturedTree($Root, $Processes) {
  $captured = @([pscustomobject]@{process=$Root;depth=0})
  for ($depth=1; $depth -le 32; $depth++) {
    $parents = @($captured | Where-Object depth -eq ($depth-1) | ForEach-Object { $_.process.processId })
    if (-not $parents.Count) { break }
    foreach ($child in @($Processes | Where-Object { $_.parentId -in $parents })) {
      if ($child.processId -in @($captured | ForEach-Object { $_.process.processId })) { continue }
      $parent = @($captured | Where-Object { $_.process.processId -eq $child.parentId })[0].process
      if ($child.identityVerified -ne $true -or $child.sessionId -ne $Root.sessionId -or -not (Test-WallpaperAssistantPath $child.executable $Root.executable) -or
          -not $child.startedAt -or $child.startedAt -clt $parent.startedAt) { throw 'Unverifiable captured process ancestry.' }
      $captured += [pscustomobject]@{process=$child;depth=$depth}
    }
  }
  if ($captured.Count -gt 128) { throw 'Too many captured processes.' }
  return $captured
}

function Expand-WallpaperAssistantCapturedTree($Context, $Root, $Captured) {
  # Chromium starts renderers and utilities while the assistant takes its next
  # snapshot. Enrol only typed children whose exact, still-live parent belongs
  # to this capture; a numeric parent PID alone never proves ancestry.
  $tree=@($Captured)
  foreach($captured in $tree){
    $live=@($Context.processes|Where-Object { $_.processId -eq $captured.process.processId })
    if($live.Count -gt 1 -or ($live.Count -eq 1 -and -not (Test-WallpaperAssistantIdentity $captured.process $live[0]))){return [pscustomobject]@{captured=$tree;reason='identity_changed'}}
  }
  for($iteration=0;$iteration -lt 32;$iteration++){
    $ids=@($tree|ForEach-Object { $_.process.processId })
    $children=@($Context.processes|Where-Object { $_.parentId -in $ids -and $_.processId -notin $ids })
    if(-not $children.Count){return [pscustomobject]@{captured=$tree;reason=$null}}
    foreach($child in $children){
      $parent=@($tree|Where-Object { $_.process.processId -eq $child.parentId })
      $liveParent=@($Context.processes|Where-Object { $_.processId -eq $child.parentId })
      $arguments=@($child.arguments)
      $types=@($arguments|Where-Object { $_ -ceq '--type' -or $_.StartsWith('--type=',[StringComparison]::Ordinal) })
      if($parent.Count -ne 1 -or $liveParent.Count -ne 1 -or -not (Test-WallpaperAssistantIdentity $parent[0].process $liveParent[0]) -or
         $parent[0].depth -ge 32 -or $child.identityVerified -ne $true -or $child.sessionId -ne $Root.sessionId -or
         -not (Test-WallpaperAssistantPath $child.executable $Root.executable) -or $arguments.Count -lt 2 -or
         -not (Test-WallpaperAssistantPath $arguments[0] $child.executable) -or $types.Count -ne 1 -or
         $types[0] -cnotin @('--type=renderer','--type=gpu-process','--type=utility') -or
         -not $child.startedAt -or $child.startedAt -clt $parent[0].process.startedAt){return [pscustomobject]@{captured=$tree;reason='tree_changed'}}
      $tree+=[pscustomobject]@{process=$child;depth=($parent[0].depth+1)}
      if($tree.Count -gt 128){return [pscustomobject]@{captured=$tree;reason='tree_changed'}}
    }
  }
  return [pscustomobject]@{captured=$tree;reason='tree_changed'}
}

function Test-WallpaperAssistantOperationWindow($Root, [datetime]$Deadline=[datetime]::MinValue) {
  if($Deadline -eq [datetime]::MinValue){return (Test-WallpaperAssistantFresh $Root)}
  return (Get-WallpaperAssistantNow) -le $Deadline
}

function Test-WallpaperAssistantScope($Context, $Root, $Captured, [datetime]$Deadline=[datetime]::MinValue) {
  if(-not (Test-WallpaperAssistantConsent)){return 'consent_revoked'}
  if(-not (Test-WallpaperAssistantOperationWindow $Root $Deadline)){return $(if($Deadline -eq [datetime]::MinValue){'too_old'}else{'operation_expired'})}
  if (-not @($Context.installations).Count -or -not (Test-WallpaperAssistantPath $Context.installations[0].executable $Root.executable)) { return 'registration_changed' }
  if (@($Context.roots | Where-Object { $_.processId -ne $Root.processId -and $_.kind -cne 'managed' }).Count) { return 'ambiguous_roots' }
  if (@($Context.roots | Where-Object kind -CEQ 'managed').Count -gt 1) { return 'ambiguous_roots' }
  $live = @($Context.processes | Where-Object { $_.processId -eq $Root.processId })
  if ($live.Count -gt 1 -or ($live.Count -eq 1 -and -not (Test-WallpaperAssistantIdentity $Root $live[0]))) { return 'identity_changed' }
  if ($live.Count -eq 1) {
    $record = @($Context.roots | Where-Object { $_.processId -eq $Root.processId })
    if ($record.Count -ne 1 -or $record[0].kind -cne 'normal' -or -not $record[0].plainLaunch) { return 'not_plain' }
    if ($Deadline -eq [datetime]::MinValue -and ($record[0].ageSeconds -lt 0 -or $record[0].ageSeconds -gt 15)) { return 'too_old' }
    # Our own WM_CLOSE can hide the last window while Chromium is exiting.
    # Visibility is required before that request, not after it.
  }
  $ids = @($Captured | ForEach-Object { $_.process.processId })
  if (@($Context.processes | Where-Object { $_.parentId -in $ids -and $_.processId -notin $ids }).Count) { return 'tree_changed' }
  foreach($captured in @($Captured)){
    $matches=@($Context.processes|Where-Object { $_.processId -eq $captured.process.processId })
    if($matches.Count -gt 1 -or ($matches.Count -eq 1 -and -not (Test-WallpaperAssistantIdentity $captured.process $matches[0]))){return 'identity_changed'}
  }
  return $null
}

function Get-WallpaperAssistantTakeoverContext($Root, $Captured, [datetime]$Deadline=[datetime]::MinValue) {
  $context=Get-WallpaperAssistantContext
  $expanded=Expand-WallpaperAssistantCapturedTree $context $Root $Captured
  $reason=$expanded.reason
  if(-not $reason){$reason=Test-WallpaperAssistantScope $context $Root $expanded.captured $Deadline}
  return [pscustomobject]@{context=$context;captured=@($expanded.captured);reason=$reason}
}

function Get-WallpaperAssistantPinnedProcess($Expected) {
  $live = @(Get-WallpaperAssistantProcesses | Where-Object { $_.processId -eq $Expected.processId })
  if ($live.Count -ne 1 -or -not (Test-WallpaperAssistantIdentity $Expected $live[0])) { return $null }
  $process = [Diagnostics.Process]::GetProcessById($Expected.processId)
  try {
    $null = $process.Handle # Pin this process object before verifying its identity.
    if ($process.HasExited -or $process.StartTime.ToUniversalTime().ToString('o') -cne $Expected.startedAt -or
        $process.SessionId -ne $Expected.sessionId -or -not (Test-WallpaperAssistantPath $process.MainModule.FileName $Expected.executable)) { $process.Dispose();return $null }
    return $process
  } catch { $process.Dispose();return $null }
}

function Request-WallpaperAssistantClose($Expected) {
  $process = Get-WallpaperAssistantPinnedProcess $Expected
  if (-not $process) { return $false }
  try {
    if(-not (Test-WallpaperAssistantConsent) -or -not (Test-WallpaperAssistantFresh $Expected)){return $false}
    $windows = @(Get-WallpaperAssistantWindows $Expected.processId)
    if ($windows.Count -ne 1) { return $false }
    return [CodexWallpaperAssistant.Native]::Close($windows[0],$Expected.processId)
  } finally { $process.Dispose() }
}

function Stop-WallpaperAssistantCaptured($Expected,$Root,[datetime]$Deadline=[datetime]::MinValue) {
  $process = Get-WallpaperAssistantPinnedProcess $Expected
  if (-not $process) { return $false }
  try { if(-not (Test-WallpaperAssistantConsent) -or -not (Test-WallpaperAssistantOperationWindow $Root $Deadline)){return $false};$process.Kill();return $true } finally { $process.Dispose() }
}

function Restore-WallpaperAssistantWindow($Expected) {
  # Undo our own close request only for the same pinned browser identity. Never
  # activate another root or start an application as a generic recovery step.
  $process=Get-WallpaperAssistantPinnedProcess $Expected
  if(-not $process){return $false}
  try{return [CodexWallpaperAssistant.Native]::Restore($Expected.processId)}finally{$process.Dispose()}
}

function Get-WallpaperAssistantManagedEnginePath {
  # This bridge is shipped beside the bundled engine. Do not resolve arbitrary
  # commands from PATH or use a state-supplied script as a handoff authority.
  $directory=[IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) 'engine\scripts'))
  foreach($name in @('common-windows.ps1','config-utf8.ps1')){
    $file=Join-Path $directory $name
    $item=Get-Item -LiteralPath $file -Force -ErrorAction Stop
    if($item.PSIsContainer -or $item.Length -gt 1048576){throw 'Invalid bundled managed-window helper.'}
    $probe=$file
    while($probe){
      $component=Get-Item -LiteralPath $probe -Force -ErrorAction Stop
      if($component.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected bundled managed-window helper.'}
      $probe=[IO.Path]::GetDirectoryName($probe)
    }
  }
  return Join-Path $directory 'common-windows.ps1'
}

function Get-WallpaperAssistantManagedSession($Context,$ManagedRoot) {
  try {
    $managed=@($Context.roots|Where-Object kind -CEQ 'managed')
    if($managed.Count -ne 1 -or $managed[0].processId -ne $ManagedRoot.processId -or $managed[0].startedAt -cne $ManagedRoot.startedAt){return $null}
    $process=@($Context.processes|Where-Object processId -EQ $ManagedRoot.processId)
    if($process.Count -ne 1 -or $process[0].identityVerified -ne $true -or $process[0].sessionId -ne $Context.sessionId -or $process[0].startedAt -cne $ManagedRoot.startedAt){return $null}
    $registered=@($Context.installations|Where-Object {Test-WallpaperAssistantPath $_.executable $process[0].executable})
    if($registered.Count -ne 1){return $null}
    . (Get-WallpaperAssistantManagedEnginePath)
    # Use fresh native TCP ownership rows for the bundled helper's checks.
    # Get-NetTCPConnection/CIM module initialization can otherwise consume the
    # entire 15-second admission window. This override exists in this call's
    # scope only; all loopback, owner, browser and profile checks remain intact.
    function Get-DreamSkinPortListeners([int]$Port) {
      Initialize-WallpaperAssistantNative
      return @([CodexWallpaperAssistant.Native]::Listeners($Port))
    }
    $profile=Join-Path (Get-WallpaperAssistantStateRoot) 'CodexDreamSkin\cdp-profile'
    $browser=Get-DreamSkinCdpBrowserIdentity -Port 9335
    if(-not $browser){return $null}
    $codex=[pscustomobject]@{Executable=$registered[0].executable}
    $owner=Get-DreamSkinManagedWindowIdentity -Codex $codex -Port 9335 -BrowserId $browser.BrowserId -ProfilePath $profile
    if(-not $owner -or $owner.ProcessId -ne $process[0].processId -or $owner.SessionId -ne $process[0].sessionId -or
       -not (Test-WallpaperAssistantTimestampPrecision $owner.StartedAt $process[0].startedAt)){return $null}
    $windows=@(Get-DreamSkinOwnedCodexWindows -ProcessId $owner.ProcessId -IncludeHidden)
    if($windows.Count -ne 1){return $null}
    $visible=@(Get-DreamSkinOwnedCodexWindows -ProcessId $owner.ProcessId)
    return [pscustomobject]@{process=$process[0];browserId=$browser.BrowserId;window=$windows[0].ToInt64();
      visible=($visible.Count -eq 1 -and $visible[0].ToInt64() -eq $windows[0].ToInt64())}
  } catch {return $null}
}

function Test-WallpaperAssistantManagedSession($Expected,[switch]$RequireVisible) {
  try {
    $context=Get-WallpaperAssistantContext
    $managed=@($context.roots|Where-Object kind -CEQ 'managed')
    if($managed.Count -ne 1){return $false}
    $current=Get-WallpaperAssistantManagedSession $context $managed[0]
    return $current -and (Test-WallpaperAssistantIdentity $Expected.process $current.process) -and
      $current.browserId -ceq $Expected.browserId -and $current.window -eq $Expected.window -and
      (-not $RequireVisible -or $current.visible)
  } catch {return $false}
}

function Restore-WallpaperAssistantManagedSession($Expected) {
  # An existing verified HWND is the handoff target. Never invoke a profile,
  # protocol or new browser to manufacture a successful existing-session reuse.
  try {
    if(-not (Test-WallpaperAssistantConsent) -or -not (Test-WallpaperAssistantManagedSession $Expected)){return $false}
    $process=Get-WallpaperAssistantPinnedProcess $Expected.process
    if(-not $process){return $false}
    try {
      . (Get-WallpaperAssistantManagedEnginePath)
      if(-not (Test-WallpaperAssistantConsent)){return $false}
      if(-not (Invoke-DreamSkinOwnedWindowRestore -Window ([IntPtr]$Expected.window) -ProcessId $Expected.process.processId)){return $false}
      return Test-WallpaperAssistantManagedSession $Expected -RequireVisible
    } finally {$process.Dispose()}
  } catch {return $false}
}

function Invoke-WallpaperAssistantTakeover([int]$ProcessId, [string]$StartedAt, [ValidateRange(0,3000)][int]$GraceMilliseconds=3000, [ValidateRange(0,2000)][int]$SettleMilliseconds=1500) {
  $result = [ordered]@{schema=1;closed=$false;takenOver=$false;processId=$ProcessId;startedAt=$StartedAt;closeRequested=$false;windowRestored=$false;reusedManaged=$false}
  $mutex = Enter-WallpaperAssistantOperation
  if (-not $mutex) { $result.reason='operation_busy';return $result }
  $root=$null;$managedSession=$null
  try {
    $context = Get-WallpaperAssistantContext
    $reason = Get-WallpaperAssistantEligibility $context $ProcessId $StartedAt
    if ($reason) { $result.reason=$reason;return $result }
    $root = @($context.processes | Where-Object processId -eq $ProcessId)[0]
    # Freshness is an admission check. Once this exact new root has accepted
    # WM_CLOSE, allow a bounded cleanup rather than abandoning it when its age
    # crosses 15 seconds midway through shutdown.
    $operationDeadline=(Get-WallpaperAssistantNow).AddSeconds(20)
    $tree = @(Get-WallpaperAssistantCapturedTree $root $context.processes)
    for($stabilize=0;$stabilize -lt 3;$stabilize++){
      $previousCount=$tree.Count
      $checked=Get-WallpaperAssistantTakeoverContext $root $tree
      $context=$checked.context;$tree=@($checked.captured)
      if($checked.reason){$result.reason=$checked.reason;return $result}
      if($tree.Count -eq $previousCount){break}
      if($stabilize -eq 2){$result.reason='tree_changed';return $result}
      Wait-WallpaperAssistantDelay
    }
    $managed=@($context.roots|Where-Object kind -CEQ 'managed')
    if($managed.Count -eq 1){
      if(-not (Test-WallpaperAssistantConsent)){$result.reason='consent_revoked';return $result}
      $managedSession=Get-WallpaperAssistantManagedSession $context $managed[0]
      if(-not $managedSession -or -not (Restore-WallpaperAssistantManagedSession $managedSession)){$result.reason='managed_unavailable';return $result}
      # Managed identity discovery can take time. Recheck the new ordinary root
      # and all bystanders before its close, within the original fresh window.
      $checked=Get-WallpaperAssistantTakeoverContext $root $tree
      $context=$checked.context;$tree=@($checked.captured)
      if($checked.reason){$result.reason=$checked.reason;return $result}
    }
    if (-not (Request-WallpaperAssistantClose $root)) { $result.reason=$(if(-not (Test-WallpaperAssistantConsent)){'consent_revoked'}else{'close_refused'});return $result }
    $result.closeRequested=$true
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.ElapsedMilliseconds -lt $GraceMilliseconds) {
      $checked=Get-WallpaperAssistantTakeoverContext $root $tree $operationDeadline
      $context=$checked.context;$tree=@($checked.captured)
      if ($checked.reason) { $result.reason=$checked.reason;return $result }
      if (-not @($context.processes | Where-Object { $_.processId -in @($tree | ForEach-Object { $_.process.processId }) }).Count) { break }
      Wait-WallpaperAssistantDelay
    }
    # Stop the browser first so it cannot keep spawning children. Only exact
    # identities captured through live, verified parentage enter the stop set.
    while($true){
      $checked=Get-WallpaperAssistantTakeoverContext $root $tree $operationDeadline
      $context=$checked.context;$tree=@($checked.captured)
      if ($checked.reason) { $result.reason=$checked.reason;return $result }
      $captured=@($tree|Sort-Object depth|Where-Object { $_.process.processId -in @($context.processes|ForEach-Object processId) }|Select-Object -First 1)
      if(-not $captured.Count){break}
      $captured=$captured[0]
      $live = @($context.processes | Where-Object { $_.processId -eq $captured.process.processId })
      if ($live.Count -ne 1 -or -not (Test-WallpaperAssistantIdentity $captured.process $live[0])) { $result.reason='identity_changed';return $result }
      if (-not (Stop-WallpaperAssistantCaptured $captured.process $root $operationDeadline)) { $result.reason=$(if(-not (Test-WallpaperAssistantConsent)){'consent_revoked'}else{'stop_refused'});return $result }
      $wait=[Diagnostics.Stopwatch]::StartNew()
      do {
        $checked=Get-WallpaperAssistantTakeoverContext $root $tree $operationDeadline
        $context=$checked.context;$tree=@($checked.captured)
        if($checked.reason){$result.reason=$checked.reason;return $result}
        if(-not @($context.processes|Where-Object processId -eq $captured.process.processId).Count){break}
        if($wait.ElapsedMilliseconds -ge $SettleMilliseconds){$result.reason='still_running';return $result}
        Wait-WallpaperAssistantDelay
      }while($true)
    }
    $watch.Restart()
    do {
      $checked=Get-WallpaperAssistantTakeoverContext $root $tree $operationDeadline
      $context=$checked.context;$tree=@($checked.captured)
      if ($checked.reason) { $result.reason=$checked.reason;return $result }
      $remaining = @($context.processes | Where-Object { $_.processId -in @($tree | ForEach-Object { $_.process.processId }) })
      if (-not $remaining.Count) { $result.closed=$true;$result.takenOver=$true;return $result }
      if ($watch.ElapsedMilliseconds -ge $SettleMilliseconds) { break }
      Wait-WallpaperAssistantDelay
    } while ($true)
    $result.reason='still_running';return $result
  } catch { $result.reason='operation_failed';return $result }
  finally {
    if($result.takenOver -and $managedSession){try{$result.reusedManaged=[bool](Test-WallpaperAssistantManagedSession $managedSession -RequireVisible)}catch{}}
    if($result.closeRequested -and -not $result.takenOver -and $root){try{$result.windowRestored=[bool](Restore-WallpaperAssistantWindow $root)}catch{}}
    Exit-WallpaperAssistantOperation $mutex
  }
}

# Dot sourcing exposes pure selection/identity helpers for isolated tests only.
if ($MyInvocation.InvocationName -eq '.') { return }
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
  if ($Action -eq 'Snapshot') {
    $mutex = Enter-WallpaperAssistantOperation
    $busy = -not [bool]$mutex
    if ($mutex) { Exit-WallpaperAssistantOperation $mutex }
    $context = Get-WallpaperAssistantContext
    # Count typed descendants too: roots.Count==0 alone cannot prove that the
    # application is fully gone before a fallback launch.
    $registeredCount=Get-WallpaperAssistantRegisteredProcessCount $context
    [ordered]@{schema=1;operationBusy=$busy;registeredProcessCount=$registeredCount;roots=@($context.roots)} | ConvertTo-Json -Depth 5 -Compress
  } else {
    if ($ExpectedProcessId -le 0 -or $ExpectedStartedAt -notmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$') { throw 'A captured process identity is required.' }
    Invoke-WallpaperAssistantTakeover $ExpectedProcessId $ExpectedStartedAt | ConvertTo-Json -Depth 5 -Compress
  }
} catch { [Console]::Error.WriteLine('Assistant command failed: '+$_.Exception.Message);exit 1 }
