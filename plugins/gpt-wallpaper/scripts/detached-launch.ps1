[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$createdProcessId = $null
$verifiedCreationStamp = $null
$identityVerified = $false
try {
  $inputBuilder = New-Object System.Text.StringBuilder
  $inputBuffer = New-Object char[] 1024
  while (($readCount = [Console]::In.Read($inputBuffer, 0, $inputBuffer.Length)) -gt 0) {
    if ($inputBuilder.Length + $readCount -gt 131072) { throw 'Launch input exceeds limit.' }
    [void]$inputBuilder.Append($inputBuffer, 0, $readCount)
  }
  $request = $inputBuilder.ToString() | ConvertFrom-Json -ErrorAction Stop
  foreach ($property in $request.PSObject.Properties.Name) {
    if ($property -notin @('executable','args','cwd','showWindow','env')) { throw 'Unexpected launch property.' }
  }
  foreach ($value in @($request.executable,$request.cwd) + @($request.args)) {
    if ($value -isnot [string] -or $value.Length -gt 32760 -or $value -match '[\x00\r\n]') { throw 'Invalid launch argument.' }
  }
  if ($request.executable -notmatch '^[A-Za-z]:[\\/]' -or $request.cwd -notmatch '^[A-Za-z]:[\\/]') { throw 'Launch paths must be absolute local paths.' }
  if ($request.showWindow -isnot [bool] -or @($request.args).Count -gt 256) { throw 'Invalid launch options.' }
  $allowedEnvironment = @('SystemRoot','WINDIR','SystemDrive','PATH','PATHEXT','TEMP','TMP',
    'USERPROFILE','APPDATA','LOCALAPPDATA','USERNAME','USERDOMAIN','HOMEDRIVE','HOMEPATH',
    'COMSPEC','ProgramFiles','ProgramFiles(x86)','PROGRAMDATA','PROCESSOR_ARCHITECTURE',
    'OS','NUMBER_OF_PROCESSORS','CODEX_DREAM_SKIN_LOCAL_APPDATA')
  if ($null -eq $request.env -or $request.env -isnot [pscustomobject]) { throw 'Invalid launch environment.' }
  $environmentBlock = @()
  foreach ($property in $request.env.PSObject.Properties) {
    if ($property.Name -notin $allowedEnvironment -or $property.Name -match '[=\x00]' -or
        $property.Value -isnot [string] -or $property.Value.Length -gt 32760 -or
        $property.Value.Contains([char]0)) { throw 'Invalid or disallowed launch environment variable.' }
    $environmentBlock += ($property.Name + '=' + $property.Value)
  }
  $expectedExecutable = [IO.Path]::GetFullPath($request.executable)
  $workingDirectory = [IO.Path]::GetFullPath($request.cwd)
  if (-not (Test-Path -LiteralPath $expectedExecutable -PathType Leaf) -or -not (Test-Path -LiteralPath $workingDirectory -PathType Container)) { throw 'Launch target or working directory does not exist.' }

  # Windows argv quoting, not shell quoting: there is no cmd.exe/-Command hop.
  function ConvertTo-IndependentArgument([string]$Value) {
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
      if ($character -eq [char]92) { $slashes++; continue }
      if ($character -eq [char]34) {
        [void]$builder.Append(('\' * ($slashes * 2 + 1)))
        [void]$builder.Append('"')
      } else {
        if ($slashes) { [void]$builder.Append(('\' * $slashes)) }
        [void]$builder.Append($character)
      }
      $slashes = 0
    }
    if ($slashes) { [void]$builder.Append(('\' * ($slashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
  }
  $commandParts = @((ConvertTo-IndependentArgument $expectedExecutable))
  foreach ($argument in @($request.args)) { $commandParts += (ConvertTo-IndependentArgument $argument) }
  $commandLine = $commandParts -join ' '
  if ($commandLine.Length -gt 32760) { throw 'Windows command line exceeds limit.' }

  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CodexIndependentJobCheck {
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr data,uint length,out uint returned);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool Thread32First(IntPtr snapshot,ref ThreadEntry entry);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool Thread32Next(IntPtr snapshot,ref ThreadEntry entry);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenThread(uint access,bool inherit,uint id);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exitCode);
  public static bool UserCodeMayHaveRun = false;
  [StructLayout(LayoutKind.Sequential)] struct ThreadEntry {public uint Size,Usage,ThreadId,OwnerPid;public int BasePriority,DeltaPriority;public uint Flags;}
  public static bool InJob(int pid) {
    IntPtr handle=OpenProcess(0x1000,false,pid);
    if(handle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {bool result;if(!IsProcessInJob(handle,IntPtr.Zero,out result))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return result;}
    finally {CloseHandle(handle);}
  }
  public static string CurrentFlags() {
    uint size=IntPtr.Size==8?144u:112u;IntPtr data=Marshal.AllocHGlobal((int)size);
    try {uint returned;if(!QueryInformationJobObject(IntPtr.Zero,9,data,size,out returned))return null;return "0x"+Marshal.ReadInt32(data,16).ToString("X");}
    finally {Marshal.FreeHGlobal(data);}
  }
  public static string ImagePath(int pid) {
    IntPtr handle=OpenProcess(0x1000,false,pid);
    if(handle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {uint length=32768;var text=new StringBuilder((int)length);if(!QueryFullProcessImageName(handle,0,text,ref length))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return text.ToString();}
    finally {CloseHandle(handle);}
  }
  public static long CreationStamp(int pid) {
    IntPtr handle=OpenProcess(0x1000,false,pid);
    if(handle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {long creation,exit,kernel,user;if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return creation;}
    finally {CloseHandle(handle);}
  }
  public static bool CleanupSuspended(int pid,long expectedCreation) {
    if(UserCodeMayHaveRun)return false;
    IntPtr handle=OpenProcess(0x1001,false,pid);
    if(handle==IntPtr.Zero)return false;
    try {long creation,exit,kernel,user;if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user)||creation!=expectedCreation)return false;return TerminateProcess(handle,1);}
    finally {CloseHandle(handle);}
  }
  public static void ResumeVerifiedProcess(int pid) {
    IntPtr snapshot=CreateToolhelp32Snapshot(4,0);
    if(snapshot==new IntPtr(-1))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    uint threadId=0;int count=0;
    try {
      var entry=new ThreadEntry();entry.Size=(uint)Marshal.SizeOf(typeof(ThreadEntry));
      if(!Thread32First(snapshot,ref entry))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      do {if(entry.OwnerPid==(uint)pid){threadId=entry.ThreadId;count++;}}while(Thread32Next(snapshot,ref entry));
    } finally {CloseHandle(snapshot);}
    if(count!=1)throw new InvalidOperationException("Suspended launch did not have exactly one primary thread.");
    IntPtr thread=OpenThread(2,false,threadId);
    if(thread==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {uint previous=ResumeThread(thread);if(previous==UInt32.MaxValue)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());UserCodeMayHaveRun=previous<=1;if(previous!=1)throw new InvalidOperationException("Unexpected primary thread suspension count.");}
    finally {CloseHandle(thread);}
  }
}
'@
  $callerSession = (Get-Process -Id $PID).SessionId
  $callerFlags = [CodexIndependentJobCheck]::CurrentFlags()
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
    ShowWindow = [uint16]$(if ($request.showWindow) { 1 } else { 0 })
    # Verify independence before any user code can create its own legitimate job.
    CreateFlags = [uint32]0x01000004
    EnvironmentVariables = [string[]]$environmentBlock
  }
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $commandLine
    CurrentDirectory = $workingDirectory
    ProcessStartupInformation = $startup
  }
  if ($created.ReturnValue -ne 0 -or $created.ProcessId -le 0) { throw ('WMI process creation failed: ' + $created.ReturnValue) }
  $createdProcessId = [int]$created.ProcessId
  $launched = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $createdProcessId) -ErrorAction Stop
  if ($null -eq $launched -or
      -not [string]::Equals([IO.Path]::GetFullPath([CodexIndependentJobCheck]::ImagePath($createdProcessId)), $expectedExecutable, [StringComparison]::OrdinalIgnoreCase)) { throw 'New process identity could not be verified.' }
  if ([int]$launched.SessionId -ne $callerSession) { throw 'New process is not in the current Windows session.' }
  $verifiedCreationStamp = [CodexIndependentJobCheck]::CreationStamp($createdProcessId)
  $identityVerified = $true
  if ([CodexIndependentJobCheck]::InJob($createdProcessId)) { throw 'New process is still associated with a job; independent lifetime is not verified.' }
  [CodexIndependentJobCheck]::ResumeVerifiedProcess($createdProcessId)
  [ordered]@{ok=$true;pid=$createdProcessId;independent=$true;verifiedBeforeResume=$true;sessionId=[int]$launched.SessionId;callerJobFlags=$callerFlags} | ConvertTo-Json -Compress
  exit 0
} catch {
  # Only clean up this exact newly created process while its primary user code
  # has never run. PID reuse is rejected by the native creation timestamp check.
  $launchError = $_.Exception.Message
  $cleanedBeforeRun = $false
  if ($identityVerified -and $null -ne $verifiedCreationStamp) {
    try { $cleanedBeforeRun = [CodexIndependentJobCheck]::CleanupSuspended($createdProcessId, $verifiedCreationStamp) } catch { }
  }
  [ordered]@{ok=$false;pid=$createdProcessId;independent=$false;cleanedBeforeRun=$cleanedBeforeRun;error=$launchError} | ConvertTo-Json -Compress
  exit 1
}
