[CmdletBinding()]
param(
  [ValidateSet('Install', 'Uninstall')][string]$Action = 'Install',
  [string]$PluginRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$StateRoot,
  [string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop'),
  [string]$ProgramsDirectory = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  [string]$TaskbarDirectory = (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
  [ValidatePattern('\ACodexWallpaperEngine\.[A-Za-z0-9][A-Za-z0-9._-]{0,95}\z')]
  [string]$ApplicationId = 'CodexWallpaperEngine.Codex',
  [switch]$ReplaceExisting
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$product = 'codex-wallpaper-launcher'
$shortcutName = 'Codex.lnk'
$appId = $ApplicationId

function Get-LocalAbsolutePath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '[\x00\r\n]' -or
      $Path -notmatch '^[A-Za-z]:[\\/]') {
    throw 'A local absolute directory is required.'
  }
  $absolute = [IO.Path]::GetFullPath($Path)
  if ($absolute -ieq [IO.Path]::GetPathRoot($absolute)) { throw 'A volume root cannot be an installation directory.' }
  return $absolute.TrimEnd('\', '/')
}

function Assert-PlainDirectory([string]$Path, [switch]$Create) {
  $probe = Get-LocalAbsolutePath $Path
  while ($probe) {
    if (Test-Path -LiteralPath $probe) {
      $item = Get-Item -LiteralPath $probe -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'A directory resolves through a link or is not a directory.'
      }
    }
    $parent = [IO.Path]::GetDirectoryName($probe)
    if ($parent -eq $probe) { break }
    $probe = $parent
  }
  if ($Create) { $null = [IO.Directory]::CreateDirectory($Path) }
}

function Get-BytesHash([byte[]]$Bytes) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}

function Get-PlainFileHash([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Cannot hash a linked payload file.' }
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose(); $stream.Dispose() }
}

function Get-PlainFileBytes([string]$Path, [long]$Limit = 262144) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $Limit) {
    throw 'An installation file is a link, directory, or exceeds its size limit.'
  }
  return ,([IO.File]::ReadAllBytes($Path))
}

function Write-AtomicBytes([string]$Path, [byte[]]$Bytes, [AllowNull()][object]$ExpectedHash) {
  $parent = [IO.Path]::GetDirectoryName($Path)
  Assert-PlainDirectory $parent
  $exists = Test-Path -LiteralPath $Path
  if ($null -eq $ExpectedHash) {
    if ($exists) { throw 'A destination appeared during installation; it was preserved.' }
  } elseif (-not $exists -or (Get-BytesHash (Get-PlainFileBytes $Path)) -cne $ExpectedHash) {
    throw 'A destination changed during installation; it was preserved.'
  }
  $temporary = Join-Path $parent ('.launcher-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllBytes($temporary, $Bytes)
    if ($exists) { [IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $Path) }
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

if (-not $StateRoot) {
  $StateRoot = $env:CODEX_DREAM_SKIN_LOCAL_APPDATA
  if (-not $StateRoot) {
    $normal = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Local'
    $StateRoot = if ($env:LOCALAPPDATA -and
      -not ([IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') -ieq $normal.TrimEnd('\'))) {
      $env:LOCALAPPDATA
    } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\wallpaper-local' }
  }
}
$StateRoot = Get-LocalAbsolutePath $StateRoot
$DesktopDirectory = Get-LocalAbsolutePath $DesktopDirectory
$ProgramsDirectory = Get-LocalAbsolutePath $ProgramsDirectory
$TaskbarDirectory = Get-LocalAbsolutePath $TaskbarDirectory
$libraryRoot = Join-Path $StateRoot 'GPTWallpaper'
$installedRoot = Join-Path $libraryRoot 'installed'
$manifestPath = Join-Path $libraryRoot 'launcher-install.json'
Assert-PlainDirectory $libraryRoot -Create
Assert-PlainDirectory $DesktopDirectory -Create
Assert-PlainDirectory $ProgramsDirectory -Create
Assert-PlainDirectory $TaskbarDirectory
if ($TaskbarDirectory -iin @($DesktopDirectory, $ProgramsDirectory)) { throw 'The taskbar directory must be distinct from shortcut creation folders.' }
$folders = @($DesktopDirectory, $ProgramsDirectory) | Select-Object -Unique
$operationMutex = New-Object Threading.Mutex($false, ('Local\CodexWallpaperInstaller-' + (Get-BytesHash ($utf8.GetBytes($StateRoot.ToLowerInvariant())))))
$operationLocked = $false
try {
  try { $operationLocked = $operationMutex.WaitOne(10000) }
  catch [Threading.AbandonedMutexException] { $operationLocked = $true }
  if (-not $operationLocked) { throw 'Another launcher installation is still running.' }
$previous = $null
$manifestHash = $null
if (Test-Path -LiteralPath $manifestPath) {
  $manifestBytes = Get-PlainFileBytes $manifestPath
  $manifestHash = Get-BytesHash $manifestBytes
  $previous = $utf8.GetString($manifestBytes) | ConvertFrom-Json
  $previousAppId = if ([string]::IsNullOrEmpty("$($previous.applicationId)")) { 'CodexWallpaperEngine.Codex' } else { "$($previous.applicationId)" }
  if ($previous.schema -ne 1 -or $previous.product -cne $product -or
      $previousAppId -cne $appId -or
      $previous.contentId -cnotmatch '^[a-f0-9]{64}$' -or @($previous.links).Count -lt 1 -or
      @($previous.links).Count -gt 32 -or
      $previous.installedPath -cne (Join-Path $installedRoot $previous.contentId)) {
    throw 'Invalid launcher installation manifest; no shortcut was changed.'
  }
  $seen = @{}
  foreach ($link in @($previous.links)) {
    $linkPath = Get-LocalAbsolutePath "$($link.path)"
    $isTaskbarPath = [IO.Path]::GetDirectoryName($linkPath) -ieq $TaskbarDirectory
    $validLocation = if ($isTaskbarPath) {
      $link.kind -ceq 'taskbar' -and [IO.Path]::GetFileName($linkPath) -match '^[^\\/:*?"<>|\x00-\x1f]{1,128}\.lnk$'
    } else {
      $folders -icontains [IO.Path]::GetDirectoryName($linkPath) -and
        [IO.Path]::GetFileName($linkPath) -cin @($shortcutName, 'ChatGPT.lnk') -and $link.kind -cne 'taskbar'
    }
    if (-not $validLocation -or
        $link.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $seen.ContainsKey($linkPath)) {
      throw 'Invalid launcher shortcut record; no shortcut was changed.'
    }
    $seen[$linkPath] = $true
    if ($null -ne $link.originalBase64) {
      if ($link.originalBase64.Length -gt 87384 -or $link.originalSha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Invalid launcher shortcut backup.'
      }
      $original = [Convert]::FromBase64String($link.originalBase64)
      if ((Get-BytesHash $original) -cne $link.originalSha256) { throw 'Launcher shortcut backup hash mismatch.' }
    } elseif ($null -ne $link.originalSha256) { throw 'Invalid absent shortcut backup.' }
  }
}

if ($Action -eq 'Uninstall') {
  $restored = @()
  $preserved = @()
  $taskbarRetained = @()
  foreach ($link in @($previous.links | Where-Object { $null -ne $_ })) {
    if (-not (Test-Path -LiteralPath $link.path)) { continue }
    $actual = Get-BytesHash (Get-PlainFileBytes $link.path 65536)
    if ($actual -cne $link.sha256) { $preserved += $link.path; continue }
    if ($link.kind -ceq 'taskbar') { $taskbarRetained += $link.path; continue }
    if ($null -ne $link.originalBase64) {
      Write-AtomicBytes $link.path ([Convert]::FromBase64String($link.originalBase64)) $actual
    } else {
      # Compare immediately before deleting only the owned, non-recursive link.
      if ((Get-BytesHash (Get-PlainFileBytes $link.path 65536)) -cne $actual) { throw 'Shortcut changed before removal.' }
      Remove-Item -LiteralPath $link.path -Force
    }
    $restored += $link.path
  }
  if ($previous) {
    if ($preserved.Count -eq 0 -and $taskbarRetained.Count -eq 0) {
      if ((Get-BytesHash (Get-PlainFileBytes $manifestPath)) -cne $manifestHash) { throw 'Installation manifest changed before removal.' }
      Remove-Item -LiteralPath $manifestPath -Force
    } else {
      $remaining = [ordered]@{schema=1; product=$product; applicationId=$appId; contentId=$previous.contentId;
        installedPath=$previous.installedPath; links=@($previous.links | Where-Object { $_.path -in @($preserved + $taskbarRetained) })}
      $remainingText = $remaining | ConvertTo-Json -Depth 6 -Compress
      Write-AtomicBytes $manifestPath ($utf8.GetBytes($remainingText)) $manifestHash
    }
  }
  # Payloads are retained: an already running manager may still use this version.
  # Editing the .lnk alone does not unpin an item from Explorer's Taskband.
  [ordered]@{ok=$true; action='uninstall'; restored=$restored; preserved=$preserved;
    taskbarRetained=$taskbarRetained; taskbarMessage='Use Explorer to unpin retained taskbar entries.'} | ConvertTo-Json -Depth 5 -Compress
  return
}

$PluginRoot = Get-LocalAbsolutePath $PluginRoot
Assert-PlainDirectory $PluginRoot
$required = @('manager\CodexDreamSkinManager.exe', 'manager\CodexDreamSkinManager.dll',
  'scripts\server.mjs', 'engine\scripts\start-dream-skin.ps1')
foreach ($name in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $PluginRoot $name) -PathType Leaf)) {
    throw "The built plugin is incomplete: $name"
  }
}
$allowedFolders = @('manager', 'scripts', 'engine', 'ui', 'vendor', 'skills')
$allowedFiles = @('plugin.json', 'mcp.json', 'LICENSE', 'LICENSE-UPSTREAM', 'NODE-LICENSE.txt',
  'README.md', 'THIRD-PARTY-NOTICES.md', 'Start.cmd', 'Stop-Rotation.cmd')
$excludedDirectories = @('.git', 'node_modules', 'tests', 'test-state', 'state', 'logs', 'config', 'configs', 'user-data')
$entries = New-Object 'System.Collections.Generic.List[object]'
$totalBytes = 0L
function Add-PayloadDirectory([string]$Directory) {
  foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The built payload contains a linked file or directory.' }
    if ($item.PSIsContainer) {
      if ($item.Name -notin $excludedDirectories) { Add-PayloadDirectory $item.FullName }
    } else {
      if ($item.Name -match '(?i)\.(?:log|tmp|pdb)$' -or $item.Name -match '(?i)^(?:settings|preferences|state|config|scene|dsh-native|rotation)\.json$') { continue }
      $relative = $item.FullName.Substring($PluginRoot.Length + 1).Replace('\', '/')
      $script:totalBytes += $item.Length
      if ($entries.Count -ge 10000 -or $script:totalBytes -gt 1073741824) { throw 'The built payload exceeds the installation limit.' }
      $entries.Add([pscustomobject]@{relative=$relative; length=$item.Length; sha256=(Get-PlainFileHash $item.FullName)})
    }
  }
}
foreach ($name in $allowedFolders) {
  $source = Join-Path $PluginRoot $name
  if (Test-Path -LiteralPath $source) { Assert-PlainDirectory $source; Add-PayloadDirectory $source }
}
foreach ($name in $allowedFiles) {
  $source = Join-Path $PluginRoot $name
  if (Test-Path -LiteralPath $source) {
    $bytes = Get-PlainFileBytes $source 10485760
    $totalBytes += $bytes.Length
    $entries.Add([pscustomobject]@{relative=$name; length=$bytes.Length; sha256=(Get-BytesHash $bytes)})
  }
}
$entries = @($entries | Sort-Object relative)
$identity = (($entries | ForEach-Object { "$($_.relative)`t$($_.length)`t$($_.sha256)`n" }) -join '')
$contentId = Get-BytesHash ($utf8.GetBytes($identity))
Assert-PlainDirectory $installedRoot -Create
$destination = Join-Path $installedRoot $contentId
$managerPath = Join-Path $destination 'manager\CodexDreamSkinManager.exe'

$official = @()
$icon = $managerPath + ',0'
foreach ($package in @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue)) {
  if ("$($package.SignatureKind)" -ine 'Store' -or $package.PackageFamilyName -cne 'OpenAI.Codex_2p2nqsd0c76g0') { continue }
  $executable = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
  if (Test-Path -LiteralPath $executable -PathType Leaf) {
    $official += [pscustomobject]@{executable=$executable; appId=($package.PackageFamilyName + '!App')}
    $icon = $executable + ',0'
  }
}
$shell = New-Object -ComObject WScript.Shell
if (-not ('CodexWallpaper.ShortcutIdentity' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace CodexWallpaper {
  public static class ShortcutIdentity {
    [StructLayout(LayoutKind.Sequential)] private struct Key { public Guid Format; public uint Id; }
    [StructLayout(LayoutKind.Explicit, Size=24)] private struct Value {
      [FieldOffset(0)] public ushort Type;
      [FieldOffset(8)] public IntPtr Text;
    }
    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface Store {
      void GetCount(out uint count);
      void GetAt(uint index, out Key key);
      void GetValue(ref Key key, out Value value);
      void SetValue(ref Key key, ref Value value);
      void Commit();
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
    private static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr binding, uint flags, ref Guid id, out Store store);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref Value value);
    public static string Get(string path) {
      Guid id = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
      Store store;
      SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 0, ref id, out store);
      Value value = new Value();
      try {
        Key key = new Key { Format=new Guid("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3"), Id=5 };
        store.GetValue(ref key, out value);
        return value.Type == 31 && value.Text != IntPtr.Zero ? Marshal.PtrToStringUni(value.Text) : null;
      } finally { PropVariantClear(ref value); Marshal.FinalReleaseComObject(store); }
    }
    public static void Set(string path, string appId) {
      Guid id = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
      Store store;
      SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref id, out store);
      Value value = new Value { Type=31, Text=Marshal.StringToCoTaskMemUni(appId) };
      try {
        Key key = new Key { Format=new Guid("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3"), Id=5 };
        store.SetValue(ref key, ref value);
        store.Commit();
      } finally { Marshal.FreeCoTaskMem(value.Text); Marshal.FinalReleaseComObject(store); }
    }
  }
}
'@
}
$planned = @()
$replaceable = @{}
$adoptedTaskbar = @{}
foreach ($folder in $folders) {
  $planned += Join-Path $folder $shortcutName
  if ($ReplaceExisting) {
    foreach ($name in @('Codex.lnk', 'ChatGPT.lnk')) {
      $candidate = Join-Path $folder $name
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
      $owned = @($previous.links | Where-Object { $_.path -ieq $candidate })
      if ($owned.Count -eq 1) { $planned += $candidate; continue }
      $null = Get-PlainFileBytes $candidate 65536
      $existing = $shell.CreateShortcut($candidate)
      $isOfficial = $false
      foreach ($identity in $official) {
        if ($existing.TargetPath -ieq $identity.executable -and [string]::IsNullOrWhiteSpace($existing.Arguments)) { $isOfficial = $true }
        if ([IO.Path]::GetFileName($existing.TargetPath) -ieq 'explorer.exe' -and
            $existing.Arguments.Trim('"') -ceq ('shell:AppsFolder\' + $identity.appId)) { $isOfficial = $true }
      }
      if ($isOfficial) { $planned += $candidate; $replaceable[$candidate] = $true }
    }
  }
}
# Explorer creates pinned shortcuts independently after installation. Adopt only
# an existing link to this exact previous payload, with our argument and AppID.
# This updates links on upgrades; it never creates a pin or edits Taskband.
if ($previous -and (Test-Path -LiteralPath $TaskbarDirectory -PathType Container)) {
  $previousManager = Join-Path $previous.installedPath 'manager\CodexDreamSkinManager.exe'
  foreach ($candidate in @(Get-ChildItem -LiteralPath $TaskbarDirectory -Filter '*.lnk' -File -Force)) {
    if ($candidate.Name -notmatch '^[^\\/:*?"<>|\x00-\x1f]{1,128}\.lnk$') { continue }
    try {
      $candidateBytes = Get-PlainFileBytes $candidate.FullName 65536
      $existing = $shell.CreateShortcut($candidate.FullName)
      if ($existing.TargetPath -ine $previousManager -or $existing.Arguments -cne '--launch' -or
          [CodexWallpaper.ShortcutIdentity]::Get($candidate.FullName) -cne $appId) { continue }
      $planned += $candidate.FullName
      $adoptedTaskbar[$candidate.FullName] = Get-BytesHash $candidateBytes
    } catch {
      # Unknown, private, oversized, or linked taskbar entries remain untouched.
    }
  }
}
# Preserve replacement entries when updating an existing installation.
$planned = @($planned + @($previous.links | Where-Object {
    $_.kind -cne 'taskbar' -or (Test-Path -LiteralPath $_.path -PathType Leaf)
  } | ForEach-Object { $_.path }) | Where-Object { $_ } | Select-Object -Unique)
if ($planned.Count -gt 32) { throw 'Too many launcher shortcuts; no shortcut was changed.' }
$linkRecords = @()
foreach ($linkPath in $planned) {
  $owned = @($previous.links | Where-Object { $_.path -ieq $linkPath })
  $beforeBytes = $null
  $beforeHash = $null
  $originalBase64 = $null
  $originalHash = $null
  if (Test-Path -LiteralPath $linkPath) {
    $beforeBytes = Get-PlainFileBytes $linkPath 65536
    $beforeHash = Get-BytesHash $beforeBytes
    if ($owned.Count -eq 1) {
      if ($owned[0].sha256 -cne $beforeHash) { throw 'An installed shortcut was edited; it was preserved.' }
      $originalBase64 = $owned[0].originalBase64
      $originalHash = $owned[0].originalSha256
    } elseif ($adoptedTaskbar.ContainsKey($linkPath)) {
      # This is an independently pinned copy of our own launcher, not a private
      # shortcut being replaced; uninstallation leaves the pin for Explorer.
      if ($beforeHash -cne $adoptedTaskbar[$linkPath]) { throw 'A taskbar shortcut changed during discovery; it was preserved.' }
    } elseif (-not $replaceable.ContainsKey($linkPath)) {
      throw 'A private shortcut already uses the launcher name; it was preserved.'
    } else {
      $originalBase64 = [Convert]::ToBase64String($beforeBytes)
      $originalHash = $beforeHash
    }
  } elseif ($owned.Count -eq 1) {
    $originalBase64 = $owned[0].originalBase64
    $originalHash = $owned[0].originalSha256
  }
  $kind = if ([IO.Path]::GetDirectoryName($linkPath) -ieq $TaskbarDirectory) { 'taskbar' } else { 'shortcut' }
  $linkRecords += [pscustomobject]@{path=$linkPath; kind=$kind; sha256=''; originalBase64=$originalBase64;
    originalSha256=$originalHash; beforeBytes=$beforeBytes; beforeHash=$beforeHash}
}

if (-not (Test-Path -LiteralPath $destination)) {
  $stage = Join-Path $installedRoot ('.stage-' + [Guid]::NewGuid().ToString('N'))
  $null = [IO.Directory]::CreateDirectory($stage)
  foreach ($entry in $entries) {
    $source = Join-Path $PluginRoot $entry.relative
    $target = Join-Path $stage $entry.relative
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    [IO.File]::Copy($source, $target, $false)
    if ((Get-PlainFileHash $target) -cne $entry.sha256) {
      throw 'The payload changed while copying; no shortcut was changed.'
    }
  }
  [IO.Directory]::Move($stage, $destination)
} else { Assert-PlainDirectory $destination }
foreach ($entry in $entries) {
  $target = Join-Path $destination $entry.relative
  Assert-PlainDirectory ([IO.Path]::GetDirectoryName($target))
  $item = Get-Item -LiteralPath $target -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $item.Length -ne $entry.length -or (Get-PlainFileHash $target) -cne $entry.sha256) {
    throw 'The installed payload does not match its content identity; no shortcut was changed.'
  }
}

$changed = @()
try {
  foreach ($record in $linkRecords) {
    $temporaryLink = Join-Path ([IO.Path]::GetDirectoryName($record.path)) ('.launcher-' + [Guid]::NewGuid().ToString('N') + '.lnk')
    try {
      $shortcut = $shell.CreateShortcut($temporaryLink)
      $shortcut.TargetPath = $managerPath
      $shortcut.Arguments = '--launch'
      $shortcut.WorkingDirectory = $destination
      $shortcut.Description = '启动 Codex 并自动恢复已保存的壁纸与玻璃装扮'
      $shortcut.IconLocation = $icon
      $shortcut.Save()
      [CodexWallpaper.ShortcutIdentity]::Set($temporaryLink, $appId)
      $bytes = Get-PlainFileBytes $temporaryLink 65536
      $record.sha256 = Get-BytesHash $bytes
      Write-AtomicBytes $record.path $bytes $record.beforeHash
      $changed += $record
    } finally {
      if (Test-Path -LiteralPath $temporaryLink) { Remove-Item -LiteralPath $temporaryLink -Force }
    }
  }
  $manifest = [ordered]@{schema=1; product=$product; applicationId=$appId; contentId=$contentId; installedPath=$destination;
    links=@($linkRecords | Select-Object path,kind,sha256,originalBase64,originalSha256)}
  $manifestText = $manifest | ConvertTo-Json -Depth 6 -Compress
  if ($utf8.GetByteCount($manifestText) -gt 262144) { throw 'Launcher manifest exceeds its fixed size limit.' }
  Write-AtomicBytes $manifestPath ($utf8.GetBytes($manifestText)) $manifestHash
} catch {
  foreach ($record in $changed) {
    try {
      if ((Get-BytesHash (Get-PlainFileBytes $record.path 65536)) -cne $record.sha256) { continue }
      if ($null -ne $record.beforeBytes) { Write-AtomicBytes $record.path $record.beforeBytes $record.sha256 }
      else { Remove-Item -LiteralPath $record.path -Force }
    } catch { Write-Warning 'A shortcut changed during rollback; its current value was preserved.' }
  }
  throw
}
[ordered]@{ok=$true; action='install'; contentId=$contentId; installedPath=$destination;
  managerPath=$managerPath; applicationId=$appId; shortcuts=@($linkRecords.path); manifestPath=$manifestPath;
  files=$entries.Count; bytes=$totalBytes} | ConvertTo-Json -Depth 5 -Compress
} finally {
  if ($operationLocked) { $operationMutex.ReleaseMutex() }
  $operationMutex.Dispose()
}
