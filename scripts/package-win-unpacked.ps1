$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$repoRoot = Resolve-Path (Join-Path $root '..')
$electronDist = Join-Path $root 'node_modules\electron\dist'
$releaseVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$outputRoot = Join-Path $root ('releases\' + $releaseVersion)
$appFolder = Join-Path $outputRoot 'AlignEx-Center-Server-win-unpacked'
$zipPath = Join-Path $outputRoot 'AlignEx-Center-Server-win-unpacked.zip'
$resourcesFolder = Join-Path $appFolder 'resources'
$appStage = Join-Path $outputRoot 'app-stage'
$appAsar = Join-Path $resourcesFolder 'app.asar'
$distFolder = if ($env:ALIGNEX_SERVER_DIST_PATH) { Resolve-Path $env:ALIGNEX_SERVER_DIST_PATH } else { Join-Path $root 'dist' }
$iconPath = Join-Path $root 'public\images\logo.ico'
$asarCli = @(
    (Join-Path $root 'node_modules\.bin\asar.cmd'),
    (Join-Path $repoRoot 'offline-candidate-browser\node_modules\.bin\asar.cmd')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$rcedit = @(
    (Join-Path $root 'node_modules\rcedit\bin\rcedit.exe'),
    (Join-Path $root 'node_modules\electron-winstaller\vendor\rcedit.exe'),
    (Join-Path $repoRoot 'offline-candidate-browser\node_modules\rcedit\bin\rcedit.exe'),
    (Join-Path $repoRoot 'offline-candidate-browser\node_modules\electron-winstaller\vendor\rcedit.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not (Test-Path (Join-Path $electronDist 'electron.exe'))) {
    throw 'Electron runtime was not found. Run npm install inside offline-server first.'
}

if (-not (Test-Path (Join-Path $electronDist 'ffmpeg.dll'))) {
    throw 'Electron ffmpeg.dll was not found. Run npm install inside offline-server again.'
}

if (-not (Test-Path (Join-Path $distFolder 'electron\main.js'))) {
    throw "Built server files were not found at $distFolder. Run npm run build first."
}

if (-not (Test-Path (Join-Path $distFolder 'renderer\index.html'))) {
    throw "Built renderer files were not found at $distFolder. Run npm run build first."
}

if (-not $asarCli) {
    throw 'ASAR packer was not found. Run npm install inside offline-candidate-browser or add asar to offline-server dev dependencies.'
}

if (-not (Test-Path $iconPath)) {
    throw "Center server icon was not found at $iconPath."
}

if (-not $rcedit) {
    throw 'Windows resource editor was not found. Run npm install inside offline-candidate-browser so rcedit is available.'
}

$resolvedOutput = [System.IO.Path]::GetFullPath($outputRoot).TrimEnd('\')
$allowedReleaseRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'releases')).TrimEnd('\') + '\'
if (-not $resolvedOutput.StartsWith($allowedReleaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Release output must stay within the server releases directory.' }
foreach ($targetPath in @($appFolder, $appStage, $zipPath)) {
    $resolvedTarget = [System.IO.Path]::GetFullPath($targetPath)
    if (-not $resolvedTarget.StartsWith($resolvedOutput + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Packaging target escaped the release directory.' }
    if ((Test-Path -LiteralPath $targetPath) -and ((Get-Item -LiteralPath $targetPath -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Packaging refuses linked targets.' }
}
New-Item -ItemType Directory -Force $outputRoot | Out-Null

if (Test-Path $appFolder) {
    Remove-Item -LiteralPath $appFolder -Recurse -Force
}

if (Test-Path $appStage) {
    Remove-Item -LiteralPath $appStage -Recurse -Force
}

if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

Copy-Item -LiteralPath $electronDist -Destination $appFolder -Recurse
Rename-Item -LiteralPath (Join-Path $appFolder 'electron.exe') -NewName 'AlignEx Center Server.exe'
$serverExe = Join-Path $appFolder 'AlignEx Center Server.exe'

& $rcedit $serverExe --set-icon $iconPath --set-file-version $releaseVersion --set-product-version $releaseVersion

if ($LASTEXITCODE -ne 0) {
    throw 'Failed to apply the AlignEx icon to the center server executable.'
}

if (-not (Test-Path $serverExe)) {
    throw 'Packaged center server executable was not created.'
}

if (-not (Test-Path (Join-Path $appFolder 'ffmpeg.dll'))) {
    throw 'Packaged center server is missing ffmpeg.dll.'
}

New-Item -ItemType Directory -Force $appStage | Out-Null

Copy-Item -LiteralPath $distFolder -Destination (Join-Path $appStage 'dist') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination (Join-Path $appStage 'package.json')
Copy-Item -LiteralPath (Join-Path $root '.env.example') -Destination (Join-Path $appStage '.env.example')
& node (Join-Path $PSScriptRoot 'stage-runtime.cjs') $root $appStage
if ($LASTEXITCODE -ne 0) { throw 'Runtime dependency staging failed.' }

& $asarCli pack $appStage $appAsar --unpack "*.node"

if ($LASTEXITCODE -ne 0) {
    throw 'ASAR packaging failed.'
}

Remove-Item -LiteralPath $appStage -Recurse -Force

if (-not (Test-Path $appAsar) -or (Get-Item $appAsar).Length -le 0) {
    throw 'Packaged app.asar was not created.'
}

if (Test-Path (Join-Path $resourcesFolder 'app')) {
    throw 'Packaged app source folder is exposed. Expected app.asar instead.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $appFolder,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Fastest,
    $true
)

if (-not (Test-Path $zipPath) -or (Get-Item $zipPath).Length -le 0) {
    throw 'Offline server archive was not created.'
}

Write-Output "Created $appFolder"
Write-Output "Executable: $(Join-Path $appFolder 'AlignEx Center Server.exe')"
Write-Output "App archive: $appAsar"
Write-Output "Archive: $zipPath"
