param(
    [switch]$UnsignedDevelopment,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._-]*$')]
    [string]$ReleaseDirectory,
    [string]$ElectronSqliteBinary
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$repoRoot = Resolve-Path (Join-Path $root '..')
$electronDist = Join-Path $root 'node_modules\electron\dist'
$releaseVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$outputRoot = Join-Path $root ('releases\' + $(if ($ReleaseDirectory) { $ReleaseDirectory } else { $releaseVersion }))
if ($ReleaseDirectory -and (Test-Path -LiteralPath $outputRoot)) {
    throw 'The requested release directory already exists. Choose a new directory to preserve existing releases.'
}
$appFolder = Join-Path $outputRoot ("AlignEx-Center-Server-$releaseVersion-win-unpacked")
$zipPath = Join-Path $outputRoot ("AlignEx-Center-Server-$releaseVersion-win-unpacked.zip")
$manifestPath = Join-Path $outputRoot 'release-manifest.json'
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
$signTool = $env:ALIGNEX_SIGNTOOL
$certificateThumbprint = $env:ALIGNEX_CODE_SIGNING_THUMBPRINT
$timestampUrl = $env:ALIGNEX_CODE_SIGNING_TIMESTAMP_URL
$developmentSigning = $env:ALIGNEX_DEVELOPMENT_SIGNING -eq 'true'
$unsignedDevelopment = $UnsignedDevelopment.IsPresent -or $env:ALIGNEX_ALLOW_UNSIGNED_DEVELOPMENT -eq 'true'

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

if ((-not $unsignedDevelopment) -and ((-not $developmentSigning -and (-not $signTool -or -not (Test-Path $signTool) -or -not $certificateThumbprint -or -not $timestampUrl)) -or ($developmentSigning -and -not $certificateThumbprint))) {
    throw 'Production packaging requires ALIGNEX_SIGNTOOL, ALIGNEX_CODE_SIGNING_THUMBPRINT, and ALIGNEX_CODE_SIGNING_TIMESTAMP_URL.'
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

$useNativeDevelopmentSigning = $developmentSigning -and (-not $signTool -or -not (Test-Path $signTool))
if ($unsignedDevelopment) {
    Write-Warning 'Building an explicitly unsigned development package.'
} elseif ($useNativeDevelopmentSigning) {
    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$certificateThumbprint" -ErrorAction Stop
    Set-AuthenticodeSignature -FilePath $serverExe -Certificate $certificate -HashAlgorithm SHA256 | Out-Null
    $signature = Get-AuthenticodeSignature -FilePath $serverExe
    if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne $certificateThumbprint) {
        throw 'Development signature verification failed.'
    }
} else {
    $signArguments = @('sign', '/sha1', $certificateThumbprint, '/fd', 'SHA256')
    if (-not $developmentSigning) {
        $signArguments += @('/tr', $timestampUrl, '/td', 'SHA256')
    }
    $signArguments += $serverExe
    & $signTool @signArguments
    if ($LASTEXITCODE -ne 0) { throw 'Failed to code-sign the Center Server executable.' }

    & $signTool verify /pa /v $serverExe
    if ($LASTEXITCODE -ne 0) { throw 'Center Server executable signature verification failed.' }
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

if ($ElectronSqliteBinary) {
    if (-not (Test-Path -LiteralPath $ElectronSqliteBinary -PathType Leaf)) { throw 'The supplied Electron SQLite binary was not found.' }
    Copy-Item -LiteralPath $ElectronSqliteBinary -Destination (Join-Path $appStage 'node_modules\better-sqlite3\build\Release\better_sqlite3.node') -Force
}
$previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $probe = Start-Process -FilePath $serverExe -ArgumentList @('"' + (Join-Path $PSScriptRoot 'check-electron-sqlite.cjs') + '"', '"' + $appStage + '"') -Wait -PassThru -NoNewWindow
    if ($probe.ExitCode -ne 0) { throw 'The staged SQLite or KernelBridge SDK runtime failed its Electron smoke test. See the preceding error.' }
} finally {
    $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode
}

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

$manifest = [ordered]@{
    product = 'AlignEx Center Server'
    version = $releaseVersion
    created_at = (Get-Date).ToUniversalTime().ToString('o')
    signing = [ordered]@{ mode = if ($unsignedDevelopment) { 'development-unsigned' } elseif ($developmentSigning) { 'development' } else { 'production' }; certificate_thumbprint = $certificateThumbprint; timestamped = -not $developmentSigning -and -not $unsignedDevelopment }
    executable = [ordered]@{ filename = (Split-Path $serverExe -Leaf); sha256 = (Get-FileHash -Algorithm SHA256 $serverExe).Hash.ToLowerInvariant() }
    archive = [ordered]@{ filename = (Split-Path $zipPath -Leaf); sha256 = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLowerInvariant() }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

Write-Output "Created $appFolder"
Write-Output "Executable: $(Join-Path $appFolder 'AlignEx Center Server.exe')"
Write-Output "App archive: $appAsar"
Write-Output "Archive: $zipPath"
Write-Output "Release manifest: $manifestPath"
