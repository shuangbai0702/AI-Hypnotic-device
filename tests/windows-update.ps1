param([Parameter(Mandatory=$true)][string]$PackageZip)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../packaging/windows/Update.ps1')
function Assert-Update($Value,$Message){if(-not $Value){throw $Message}}
$root=Join-Path ([IO.Path]::GetTempPath()) ('dsh-update-'+[guid]::NewGuid().ToString())
$cache=Join-Path $root 'cache with spaces'
$script:zip=(Resolve-Path -LiteralPath $PackageZip).Path
$script:requests=0;$script:offline=$false;$script:downloadBreak=$false
$version='0.4.2';$name='AI-Hypnotic-device-Setup-'+$version+'-windows.zip'
$script:release=@{tag_name=('v'+$version);draft=$false;prerelease=$false;assets=@(@{name=$name;browser_download_url=('https://github.com/shuangbai0702/AI-Hypnotic-device/releases/download/v'+$version+'/'+$name);size=(Get-Item $script:zip).Length;digest=('sha256:'+(Get-FileHash $script:zip -Algorithm SHA256).Hash.ToLowerInvariant())})}
function Invoke-RestMethod {param($Uri,$Headers,$TimeoutSec);$script:requests++;if($script:offline){throw 'synthetic offline'};return $script:release}
function Invoke-WebRequest {param([switch]$UseBasicParsing,$Uri,$OutFile,$TimeoutSec);if($script:downloadBreak){throw 'synthetic interrupted download'};Copy-Item -LiteralPath $script:zip -Destination $OutFile}
function Assert-Refused($Message){$r=Get-InstallerUpdate '0.4.1' $cache;Assert-Update (-not $r.ok -and -not $r.updated) $Message;Assert-Update (@(Get-ChildItem $cache -Directory -ErrorAction SilentlyContinue).Count -eq 1) 'Failed updates must clean their own temporary files'}
try {
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Assert-Update ((Compare-ReleaseVersion '0.10.0' '0.9.99') -eq 1) 'Numeric version ordering'
    Assert-Update ((Compare-ReleaseVersion '99999999999999999999.0.0' '9999999999999999999.0.0') -eq 1) 'No integer overflow'
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../packaging/windows/Installer.ps1'),[ref]$tokens,[ref]$errors)
    Assert-Update ($errors.Count -eq 0) 'Installer syntax'
    $function=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-InstallPreflight'},$true)
    . ([scriptblock]::Create($function.Extent.Text))
    $nodePath=(Get-Command node.exe).Source;$encoding=[Console]::OutputEncoding
    Invoke-InstallPreflight $nodePath @('-e',"console.log('preflight success')")
    try{Invoke-InstallPreflight $nodePath @('-e',"console.error('synthetic preflight failure');process.exit(7)");throw 'Expected preflight refusal'}catch{if($_.Exception.Message -notlike '*synthetic preflight failure*'){throw}}
    try{Invoke-InstallPreflight (Join-Path $root 'absent-node.exe') @('--version');throw 'Expected missing runtime refusal'}catch{if($_.Exception.Message -eq 'Expected missing runtime refusal'){throw}}
    Assert-Update ([Console]::OutputEncoding.CodePage -eq $encoding.CodePage) 'Preflight restores console encoding'
    foreach($bad in @('01.0.0','1.0','1.0.0-rc.1')){try{Compare-ReleaseVersion $bad '1.0.0';throw 'Expected invalid version'}catch{if($_.Exception.Message -eq 'Expected invalid version'){throw}}}
    $r=Get-InstallerUpdate '0.4.2' $cache;Assert-Update ($r.ok -and -not $r.updated -and -not (Test-Path $cache)) 'Equal version does not download'
    $r=Get-InstallerUpdate '0.5.0' $cache;Assert-Update ($r.ok -and -not $r.updated) 'Older release does not download'
    $r=Get-InstallerUpdate '0.4.1' $cache;Assert-Update ($r.ok -and $r.updated -and (Test-Path -LiteralPath $r.executable)) ('Verified update extraction: '+$r.message)
    $original=$script:release.assets[0].digest;$script:release.assets[0].digest='sha256:'+('0'*64);Assert-Refused 'Checksum mismatch refuses update';$script:release.assets[0].digest=$original
    $original=$script:release.assets[0].browser_download_url;$script:release.assets[0].browser_download_url='https://example.invalid/payload.zip';Assert-Refused 'Untrusted URL refuses update';$script:release.assets[0].browser_download_url=$original
    $original=$script:release.assets[0].digest;$script:release.assets[0].digest=$null;Assert-Refused 'Missing trusted checksum refuses update';$script:release.assets[0].digest=$original
    $script:downloadBreak=$true;Assert-Refused 'Download interruption safely returns current package';$script:downloadBreak=$false
    $script:offline=$true;$before=$script:requests;Assert-Refused 'Offline failure returns current package';Assert-Update (($script:requests-$before) -eq 2) 'Bounded network retries';$script:offline=$false
    $script:release.prerelease=$true;Assert-Refused 'Prerelease is not auto-installed';$script:release.prerelease=$false
    foreach($badPath in @('../escape.txt','AI-Hypnotic-device-Setup-0.4.2-windows/../../escape.txt','AI-Hypnotic-device-Setup-0.4.2-windows/source/trailing. /bad','AI-Hypnotic-device-Setup-0.4.2-windows/source/a:bad')){
        $badZip=Join-Path $root ([guid]::NewGuid().ToString()+'.zip');$z=[IO.Compression.ZipFile]::Open($badZip,[IO.Compression.ZipArchiveMode]::Create)
        try{[void]$z.CreateEntry($badPath)}finally{$z.Dispose()}
        try{Expand-VerifiedUpdate $badZip (Join-Path $root ([guid]::NewGuid().ToString())) '0.4.2';throw 'Expected unsafe ZIP refusal'}catch{if($_.Exception.Message -eq 'Expected unsafe ZIP refusal'){throw}}
    }
    # Same release checksum cannot excuse a corrupt internal manifest.
    $stage=Join-Path $root 'tampered';[IO.Compression.ZipFile]::ExtractToDirectory($script:zip,$stage)
    $file=Get-ChildItem $stage -Filter 'Installer.ps1' -File -Recurse | Select-Object -First 1
    [IO.File]::AppendAllText($file.FullName,'# altered')
    $badZip=Join-Path $root 'tampered.zip';[IO.Compression.ZipFile]::CreateFromDirectory($stage,$badZip)
    try{Expand-VerifiedUpdate $badZip (Join-Path $root 'tampered-extract') '0.4.2';throw 'Expected inner checksum refusal'}catch{if($_.Exception.Message -eq 'Expected inner checksum refusal'){throw}}
    Write-Output 'PASS updates: stable ordering, verified download, manifest validation, offline retry, interruption, invalid URLs/checksums and ZIP traversal'
} finally {
    $absolute=[IO.Path]::GetFullPath($root);$parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($absolute.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $absolute -Leaf) -like 'dsh-update-*'){Remove-Item -LiteralPath $absolute -Recurse -Force}
}
