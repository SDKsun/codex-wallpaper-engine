[CmdletBinding()]
param(
  [ValidateSet('Install','Uninstall')][string]$Action='Install',
  [string]$StateRoot,
  [string]$RegistryPath='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
)
$ErrorActionPreference='Stop'
$assistantUtf8=New-Object Text.UTF8Encoding($false)
$assistantValueName='CodexWallpaperStartupAssistant'

function Resolve-AssistantDirectory([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[\x00\r\n]') { throw 'A local absolute assistant directory is required.' }
  $absolute=[IO.Path]::GetFullPath($Path).TrimEnd('\','/')
  if ($absolute.Length -le 3) { throw 'A volume root is not an assistant directory.' }
  $probe=$absolute
  while($probe) {
    if(Test-Path -LiteralPath $probe) { $item=Get-Item -LiteralPath $probe -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Assistant directories cannot contain links.'} }
    $probe=[IO.Path]::GetDirectoryName($probe)
  }
  return $absolute
}
function Read-AssistantBytes([string]$Path,[long]$Maximum=65536) {
  $item=Get-Item -LiteralPath $Path -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $Maximum){throw 'Invalid assistant state file.'}
  return ,([IO.File]::ReadAllBytes($Path))
}
function Get-AssistantHash([byte[]]$Bytes) {
  $hash=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
}
function Get-AssistantRecordHash($Record) { return Get-AssistantHash ($assistantUtf8.GetBytes(($Record|ConvertTo-Json -Depth 8 -Compress))) }
function Write-AssistantAtomic([string]$Path,[byte[]]$Bytes,$ExpectedHash) {
  $null=Resolve-AssistantDirectory ([IO.Path]::GetDirectoryName($Path))
  if(Test-Path -LiteralPath $Path) { if($null -eq $ExpectedHash -or (Get-AssistantHash (Read-AssistantBytes $Path 262144)) -cne $ExpectedHash){throw 'Assistant state changed; current data was preserved.'} }
  elseif($null -ne $ExpectedHash){throw 'Assistant state was removed; current data was preserved.'}
  $temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  try {
    [IO.File]::WriteAllBytes($temporary,$Bytes)
    if(Test-Path -LiteralPath $Path){[IO.File]::Replace($temporary,$Path,[Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($temporary,$Path)}
  }finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
}
function Get-AssistantRunRecord([string]$SubKey) {
  $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey,$false)
  if(-not $key){return [ordered]@{exists=$false;kind=$null;value=$null}}
  try {
    if($assistantValueName -notin $key.GetValueNames()){return [ordered]@{exists=$false;kind=$null;value=$null}}
    $kind=$key.GetValueKind($assistantValueName).ToString()
    $value=$key.GetValue($assistantValueName,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if($kind -eq 'Binary'){$value=[Convert]::ToBase64String($value)}
    elseif($kind -eq 'QWord'){$value=$value.ToString([Globalization.CultureInfo]::InvariantCulture)}
    if($kind -notin @('String','ExpandString','DWord','QWord','MultiString','Binary')){throw 'Unsupported existing assistant Run value type.'}
    $record=[ordered]@{exists=$true;kind=$kind;value=$value}
    if($assistantUtf8.GetByteCount(($record|ConvertTo-Json -Depth 5 -Compress)) -gt 32768){throw 'Existing assistant Run value exceeds its backup limit.'}
    return $record
  }finally{$key.Dispose()}
}
function Set-AssistantRunRecord([string]$SubKey,$Record,[string]$ExpectedHash) {
  if((Get-AssistantRecordHash (Get-AssistantRunRecord $SubKey)) -cne $ExpectedHash){throw 'Assistant Run value changed; it was preserved.'}
  $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKey,$true)
  try {
    if(-not $Record.exists){$key.DeleteValue($assistantValueName,$false);return}
    $kind=[Enum]::Parse([Microsoft.Win32.RegistryValueKind],[string]$Record.kind)
    $value=$Record.value
    switch($Record.kind){
      'Binary' {$value=[Convert]::FromBase64String($value)}
      'QWord' {$value=[long]::Parse($value,[Globalization.CultureInfo]::InvariantCulture)}
      'DWord' {$value=[int]$value}
      'MultiString' {$value=[string[]]@($value)}
      'String' {$value=[string]$value}
      'ExpandString' {$value=[string]$value}
    }
    $key.SetValue($assistantValueName,$value,$kind)
  }finally{$key.Dispose()}
}
function Test-AssistantSettings($Settings,[string]$InstalledRoot) {
  if(-not $Settings -or @($Settings.PSObject.Properties).Count -ne 4 -or $Settings.schema -ne 1 -or
      $Settings.enabled -isnot [bool] -or $Settings.paused -isnot [bool] -or $Settings.launcherPath -isnot [string]){return $false}
  foreach($property in $Settings.PSObject.Properties){if($property.Name -cnotin @('schema','enabled','paused','launcherPath')){return $false}}
  $prefix=$InstalledRoot.TrimEnd('\')+'\'
  if(-not $Settings.launcherPath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){return $false}
  $relative=$Settings.launcherPath.Substring($prefix.Length)
  return $relative -cmatch '^[a-f0-9]{64}\\manager\\CodexDreamSkinManager\.exe$'
}
function Test-AssistantRunBackup($Record) {
  if(-not $Record -or @($Record.PSObject.Properties).Count -ne 3 -or $Record.exists -isnot [bool]){return $false}
  foreach($property in $Record.PSObject.Properties){if($property.Name -cnotin @('exists','kind','value')){return $false}}
  if(-not $Record.exists){return $null -eq $Record.kind -and $null -eq $Record.value}
  if($Record.kind -cnotin @('String','ExpandString','DWord','QWord','MultiString','Binary')){return $false}
  if($assistantUtf8.GetByteCount(($Record|ConvertTo-Json -Depth 5 -Compress)) -gt 32768){return $false}
  switch($Record.kind){
    {$_ -in @('String','ExpandString')} {return $Record.value -is [string]}
    'DWord' {return $Record.value -is [int] -or $Record.value -is [long]}
    'QWord' {return $Record.value -is [string] -and $Record.value -match '^-?\d{1,19}$'}
    'MultiString' {return $Record.value -is [array] -and -not @($Record.value|Where-Object {$_ -isnot [string]}).Count}
    'Binary' {try{$null=[Convert]::FromBase64String($Record.value);return $true}catch{return $false}}
  }
  return $false
}

function Invoke-AssistantInstallation {
  $defaultRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\wallpaper-local'
  if(-not $StateRoot){$StateRoot=$env:CODEX_DREAM_SKIN_LOCAL_APPDATA;if(-not $StateRoot){$StateRoot=$defaultRoot}}
  $StateRoot=Resolve-AssistantDirectory $StateRoot
  $productionRegistry='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if($RegistryPath -cne $productionRegistry){
    if($RegistryPath -cnotmatch '^HKCU:\\Software\\CodexWallpaperEngine\\Tests\\StartupAssistant\\[a-f0-9]{32}$' -or $StateRoot -ieq $defaultRoot){throw 'Custom registry paths require an isolated assistant test key and state root.'}
  }elseif($StateRoot -ine $defaultRoot){throw 'Production autostart requires the default shared state root.'}
  $subKey=$RegistryPath.Substring(6)
  $directory=Join-Path $StateRoot 'GPTWallpaper'
  $null=Resolve-AssistantDirectory $directory
  $null=[IO.Directory]::CreateDirectory($directory)
  $configPath=Join-Path $directory 'startup-assistant.json'
  $journalPath=Join-Path $directory 'startup-assistant-install.json'
  $installedRoot=Join-Path $directory 'installed'
  $journal=$null;$journalHash=$null
  if(Test-Path -LiteralPath $journalPath){
    $bytes=Read-AssistantBytes $journalPath;$journalHash=Get-AssistantHash $bytes;$journal=$assistantUtf8.GetString($bytes)|ConvertFrom-Json
    if($journal.schema -ne 1 -or $journal.product -cne 'codex-wallpaper-startup-assistant' -or $journal.active -isnot [bool] -or $journal.registrySubKey -cne $subKey -or
      $journal.ownedConfigSha256 -cnotmatch '^[a-f0-9]{64}$' -or $journal.ownedRun.exists -ne $true -or $journal.ownedRun.kind -cne 'String') {throw 'Invalid assistant installation journal.'}
    $ownedCommand=[regex]::Match([string]$journal.ownedRun.value,'^"([^"\r\n]+)" --assistant$')
    $ownedSettings=if($ownedCommand.Success){[pscustomobject]@{schema=1;enabled=$true;paused=$false;launcherPath=$ownedCommand.Groups[1].Value}}else{$null}
    if(-not (Test-AssistantSettings $ownedSettings $installedRoot) -or -not (Test-AssistantRunBackup $journal.previousRun) -or
      $journal.previousConfig.exists -isnot [bool]){throw 'Invalid assistant ownership or backup record.'}
    if($journal.previousConfig.exists){
      $old=[Convert]::FromBase64String($journal.previousConfig.bytesBase64)
      if($old.Length -gt 8192 -or (Get-AssistantHash $old) -cne $journal.previousConfig.sha256){throw 'Assistant configuration backup hash mismatch.'}
    }elseif($null -ne $journal.previousConfig.bytesBase64 -or $null -ne $journal.previousConfig.sha256){throw 'Invalid absent assistant configuration backup.'}
  }
  $runBefore=Get-AssistantRunRecord $subKey
  $configBefore=$null;$configBeforeHash=$null
  if(Test-Path -LiteralPath $configPath){$configBefore=Read-AssistantBytes $configPath 8192;$configBeforeHash=Get-AssistantHash $configBefore}
  if($Action -eq 'Uninstall'){
    $removedRun=$false;$restoredConfig=$false;$preserved=@()
    if($journal){
      # Revoke live authority before cleanup, including when private settings
      # must remain byte-identical. Existing bridge children recheck this gate.
      if($journal.active){$journal.active=$false;$inactive=$assistantUtf8.GetBytes(($journal|ConvertTo-Json -Depth 8 -Compress));Write-AssistantAtomic $journalPath $inactive $journalHash;$journalHash=Get-AssistantHash $inactive}
      if((Get-AssistantRecordHash $runBefore) -ceq (Get-AssistantRecordHash $journal.ownedRun)){
        Set-AssistantRunRecord $subKey $journal.previousRun (Get-AssistantRecordHash $runBefore);$removedRun=$true
      }elseif((Get-AssistantRecordHash $runBefore) -cne (Get-AssistantRecordHash $journal.previousRun)){$preserved+='registry'}
      if($configBeforeHash -ceq $journal.ownedConfigSha256){
        if($journal.previousConfig.exists){Write-AssistantAtomic $configPath ([Convert]::FromBase64String($journal.previousConfig.bytesBase64)) $configBeforeHash}
        else {if((Get-AssistantHash (Read-AssistantBytes $configPath 8192)) -cne $configBeforeHash){throw 'Assistant configuration changed before removal.'};Remove-Item -LiteralPath $configPath -Force}
        $restoredConfig=$true
      }elseif($null -ne $configBefore){$preserved+='configuration'}
      if(-not $preserved.Count){if((Get-AssistantHash (Read-AssistantBytes $journalPath)) -cne $journalHash){throw 'Assistant installation journal changed.'};Remove-Item -LiteralPath $journalPath -Force}
    }
    return [ordered]@{ok=$true;action='uninstall';removedRun=$removedRun;restoredConfig=$restoredConfig;preserved=$preserved}
  }
  $launcherManifest=$assistantUtf8.GetString((Read-AssistantBytes (Join-Path $directory 'launcher-install.json') 262144))|ConvertFrom-Json
  if($launcherManifest.schema -ne 1 -or $launcherManifest.product -cne 'codex-wallpaper-launcher' -or $launcherManifest.contentId -cnotmatch '^[a-f0-9]{64}$'){throw 'A verified stable launcher installation is required.'}
  $expectedRoot=Join-Path $installedRoot $launcherManifest.contentId
  if($launcherManifest.installedPath -cne $expectedRoot){throw 'The launcher must use its stable installed payload.'}
  $null=Resolve-AssistantDirectory $expectedRoot
  $launcher=Join-Path $expectedRoot 'manager\CodexDreamSkinManager.exe'
  foreach($file in @($launcher,(Join-Path $expectedRoot 'scripts\assistant-command.ps1'))){$null=Resolve-AssistantDirectory ([IO.Path]::GetDirectoryName($file));$null=Read-AssistantBytes $file 1073741824}
  if($journal){
    $expectedRun=if($journal.active){$journal.ownedRun}else{$journal.previousRun}
    if((Get-AssistantRecordHash $runBefore) -cne (Get-AssistantRecordHash $expectedRun)){throw 'Assistant Run value was privately edited; it was preserved.'}
  }
  if($configBefore){$settings=$assistantUtf8.GetString($configBefore)|ConvertFrom-Json;if(-not (Test-AssistantSettings $settings $installedRoot)){throw 'Private assistant configuration was preserved.'}}
  $config=[ordered]@{schema=1;enabled=$true;paused=$false;launcherPath=$launcher}
  $configBytes=$assistantUtf8.GetBytes(($config|ConvertTo-Json -Compress))
  $ownedRun=[ordered]@{exists=$true;kind='String';value=('"'+$launcher+'" --assistant')}
  $previousConfig=if($journal){$journal.previousConfig}elseif($configBefore){[ordered]@{exists=$true;bytesBase64=[Convert]::ToBase64String($configBefore);sha256=$configBeforeHash}}else{[ordered]@{exists=$false;bytesBase64=$null;sha256=$null}}
  $next=[ordered]@{schema=1;product='codex-wallpaper-startup-assistant';active=$true;registrySubKey=$subKey;
    previousRun=$(if($journal){$journal.previousRun}else{$runBefore});previousConfig=$previousConfig;ownedRun=$ownedRun;ownedConfigSha256=(Get-AssistantHash $configBytes)}
  $nextBytes=$assistantUtf8.GetBytes(($next|ConvertTo-Json -Depth 8 -Compress))
  if($nextBytes.Length -gt 65536){throw 'Assistant installation journal exceeds its limit.'}
  $runWritten=$false;$configWritten=$false
  try {
    Set-AssistantRunRecord $subKey $ownedRun (Get-AssistantRecordHash $runBefore);$runWritten=$true
    Write-AssistantAtomic $configPath $configBytes $configBeforeHash;$configWritten=$true
    Write-AssistantAtomic $journalPath $nextBytes $journalHash
  }catch{
    if($configWritten){try{if((Get-AssistantHash (Read-AssistantBytes $configPath 8192)) -ceq (Get-AssistantHash $configBytes)){if($configBefore){Write-AssistantAtomic $configPath $configBefore (Get-AssistantHash $configBytes)}else{Remove-Item -LiteralPath $configPath -Force}}}catch{}}
    if($runWritten){try{Set-AssistantRunRecord $subKey $runBefore (Get-AssistantRecordHash $ownedRun)}catch{}}
    throw
  }
  return [ordered]@{ok=$true;action='install';enabled=$true;paused=$false;launcherPath=$launcher;registryPath=$RegistryPath;valueName=$assistantValueName;configurationPath=$configPath}
}

if($MyInvocation.InvocationName -eq '.'){return}
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {Invoke-AssistantInstallation|ConvertTo-Json -Depth 6 -Compress}catch{[Console]::Error.WriteLine('Assistant installation failed: '+$_.Exception.Message);exit 1}
