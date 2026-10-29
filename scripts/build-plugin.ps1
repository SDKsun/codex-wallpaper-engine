[CmdletBinding()]
param(
    [string]$NodeExe,
    [string]$NodeLicense,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pluginRoot = Join-Path $repoRoot 'plugins/gpt-wallpaper'
$lock = Get-Content (Join-Path $repoRoot 'dependencies.lock.json') -Raw | ConvertFrom-Json
if (-not $IsWindows -and $PSVersionTable.PSEdition -ne 'Desktop') { throw 'The Windows manager build requires Windows x64.' }
if (-not $NodeExe) { $NodeExe = (Get-Command node -ErrorAction Stop).Source }
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
if (-not $NodeLicense) { $NodeLicense = Join-Path (Split-Path -Parent $NodeExe) 'LICENSE' }
if (-not (Test-Path -LiteralPath $NodeLicense -PathType Leaf)) { throw 'Provide -NodeLicense with the LICENSE from the same trusted Node.js distribution.' }
$NodeLicense = (Resolve-Path -LiteralPath $NodeLicense).Path
$nodeVersion = (& $NodeExe --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24 or newer is required.' }
Get-Command git,dotnet,tar -ErrorAction Stop | Out-Null
& $NodeExe (Join-Path $PSScriptRoot 'prepare-vendor.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Pinned dependency preparation failed.' }

$buildRoot = Join-Path $repoRoot 'build/source-build'
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$sourceRoot = Join-Path $buildRoot ('skin-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sourceRoot | Out-Null
& git -C $sourceRoot init -q
& git -C $sourceRoot config core.autocrlf false
& git -C $sourceRoot fetch --depth 1 $lock.skin.repository $lock.skin.commit
if ($LASTEXITCODE -ne 0) { throw 'Pinned Windows engine fetch failed.' }
& git -C $sourceRoot checkout --detach FETCH_HEAD
if ($LASTEXITCODE -ne 0 -or (& git -C $sourceRoot rev-parse HEAD).Trim() -ne $lock.skin.commit) { throw 'Windows engine commit mismatch.' }
$patchPath = Join-Path $pluginRoot 'patches/codex-scene-addon.patch'
$patchHash = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($patchHash -ne $lock.patches.'plugins/gpt-wallpaper/patches/codex-scene-addon.patch') { throw 'Windows adapter patch checksum mismatch.' }
& git -C $sourceRoot apply --check $patchPath
if ($LASTEXITCODE -ne 0) { throw 'Windows adapter patch does not apply.' }
& git -C $sourceRoot apply $patchPath
if ($LASTEXITCODE -ne 0) { throw 'Windows adapter patch failed.' }

$windowsRoot = Join-Path $sourceRoot 'windows'
foreach ($part in @('assets','scripts')) {
    $target = Join-Path $pluginRoot "engine/$part"
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Copy-Item -LiteralPath (Get-ChildItem -LiteralPath (Join-Path $windowsRoot $part) -File).FullName -Destination $target -Force
}
Copy-Item -LiteralPath (Join-Path $windowsRoot 'VERSION') -Destination (Join-Path $pluginRoot 'engine/VERSION') -Force
$managerRoot = Join-Path $pluginRoot 'manager'
New-Item -ItemType Directory -Path $managerRoot -Force | Out-Null
$project = Join-Path $windowsRoot 'app/CodexDreamSkin.Manager/CodexDreamSkin.Manager.csproj'
# Change only the disposable build copy. A CLI TargetFramework override is
# stripped by some NuGet restore paths, producing a net8/net10 assets mismatch.
$projectXml = New-Object Xml.XmlDocument
$projectXml.Load($project)
$frameworkNode = $projectXml.SelectSingleNode('/Project/PropertyGroup/TargetFramework')
if ($null -eq $frameworkNode -or $frameworkNode.InnerText -ne 'net8.0-windows') { throw 'Unexpected upstream target framework.' }
$frameworkNode.InnerText = 'net10.0-windows'
$projectXml.Save($project)
& dotnet publish $project -c Release -p:SelfContained=false -p:PublishSingleFile=false -p:PublishReadyToRun=false "-p:NodeExe=$NodeExe" "-p:NodeLicense=$NodeLicense" -o $managerRoot
if ($LASTEXITCODE -ne 0) { throw 'Manager build failed.' }
& (Join-Path $managerRoot 'CodexDreamSkinManager.exe') --self-test
if ($LASTEXITCODE -ne 0) { throw 'Manager self-test failed.' }

if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot ('dist/build-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)) }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputRoot) { throw 'Output directory already exists; choose a new path to preserve existing files.' }
if ($outputRoot.StartsWith($pluginRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Output directory must not be inside the source plugin.' }
$outputPlugin = Join-Path $outputRoot 'gpt-wallpaper'
New-Item -ItemType Directory -Path $outputPlugin -Force | Out-Null
& $NodeExe (Join-Path $PSScriptRoot 'copy-plugin.mjs') $pluginRoot $outputPlugin
if ($LASTEXITCODE -ne 0) { throw 'Plugin staging failed.' }
Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $outputPlugin 'NODE-LICENSE.txt') -Force
$catalog = Join-Path $outputRoot '.agents/plugins'
New-Item -ItemType Directory -Path $catalog -Force | Out-Null
$marketplace = @{name='codex-wallpaper-engine';interface=@{displayName='Codex Wallpaper Engine'};plugins=@(@{name='gpt-wallpaper';source=@{source='local';path='./gpt-wallpaper'};policy=@{installation='AVAILABLE';authentication='ON_INSTALL'};category='Productivity'})}
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $catalog 'marketplace.json'),($marketplace | ConvertTo-Json -Depth 8),$utf8)
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $outputRoot 'LICENSE')
Write-Output "Built and self-tested: $outputPlugin"
Write-Output "Local marketplace: $(Join-Path $catalog 'marketplace.json')"
Write-Output 'This build did not install, restart, or modify the active Codex application.'
