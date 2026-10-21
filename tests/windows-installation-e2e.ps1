param(
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$InstallerRoot,
    [string]$ReuseRoot,
    [string[]]$Versions=@('0.1.7-rc.2','0.2.0-rc.1','0.2.0-rc.2','0.2.1-rc.1'),
    [int]$Port=3196
)
$ErrorActionPreference='Stop'
if($Port -in 3080,3099){throw 'Formal/developer ports are prohibited'}
$project=Split-Path -Parent $PSScriptRoot
if($ReuseRoot){
    $root=(Resolve-Path -LiteralPath $ReuseRoot).Path
    if(-not $root.StartsWith((Join-Path $project 'testdata/reliability-matrix-'),[StringComparison]::OrdinalIgnoreCase)){throw 'Only a previous isolated matrix may be reused'}
}else{
    $root=Join-Path $project ('testdata/reliability-matrix-'+[guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $root,(Join-Path $root 'tmp') | Out-Null
}
$NodePath=(Resolve-Path -LiteralPath $NodePath).Path
$InstallerRoot=(Resolve-Path -LiteralPath $InstallerRoot).Path
$env:TEMP=Join-Path $root 'tmp';$env:TMP=$env:TEMP
$env:EDITOR_TEST_DISPOSABLE='yes';$env:EDITOR_TEST_PORT=[string]$Port
$npm=Join-Path (Split-Path -Parent $NodePath) 'node_modules/npm/bin/npm-cli.js'
if(-not(Test-Path -LiteralPath $npm)){throw 'Test runtime must include npm'}
$records=@()
function Run-Installer([string]$App,[string]$DataHome,[switch]$Remove) {
    $resultFile=Join-Path $root ('result-'+[guid]::NewGuid().ToString()+'.json')
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=Join-Path $InstallerRoot '双白DSH安装器.exe'
    $start.Arguments='-Apply -AppPath "'+$App+'" -DshHome "'+$DataHome+'" -Port '+$Port+' -NodePath "'+$NodePath+'" -NoBrowser -ResultFile "'+$resultFile+'"'
    if($Remove){$start.Arguments+=' -Uninstall'}
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $child=[Diagnostics.Process]::Start($start)
    try{
        if(-not $child.WaitForExit(90000)){throw 'Owned installer timed out; retained for diagnosis'}
        $value=Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
        if(-not $value.ok -or -not $value.healthVerified){throw ('Installer failed: '+$value.error)}
        return $value
    }finally{$child.Dispose()}
}
function Stop-OwnedService($Result) {
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($Result.processId)"
    if(-not $process){return}
    if($process.Name -ne 'node.exe' -or $process.CommandLine -notlike ('*'+$root+'*')){throw 'Refusing to stop an unowned service'}
    Stop-Process -Id $process.ProcessId
    Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
}
foreach($version in $Versions){
    if($version -notmatch '^\d+\.\d+\.\d+-rc\.\d+$'){throw 'Unexpected test version'}
    if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){throw 'QA port occupied'}
    $prefix=Join-Path $root $version
    if(-not $ReuseRoot){
        Write-Output "Installing isolated upstream DSH $version (scripts disabled)"
        & $NodePath $npm install --ignore-scripts --no-audit --no-fund --package-lock=false --loglevel=error --cache (Join-Path $root 'npm-cache') --prefix $prefix "@deepseek-ai/dsh@$version"
        if($LASTEXITCODE -ne 0){throw "npm failed for $version; no OOM attribution inferred"}
    }elseif((Get-Content -LiteralPath (Join-Path $prefix 'node_modules/@deepseek-ai/dsh/package.json') -Raw | ConvertFrom-Json).version -ne $version){throw 'Reused fixture version mismatch'}
    $app=Join-Path $prefix 'node_modules/@deepseek-ai/dsh';$dataHome=Join-Path $prefix 'qa-home'
    $managed=@('dsh-agent/lib/index.js','dsh-agent-loop/lib/index.js','dsh-api-session-controller/lib/client.js')
    $before=@{}
    foreach($name in $managed){$before[$name]=(Get-FileHash -LiteralPath (Join-Path $prefix "node_modules/@deepseek-ai/$name")).Hash}
    # A synthetic credential sentinel proves installers leave credential bytes alone.
    New-Item -ItemType Directory -Force $dataHome | Out-Null
    $credential=Join-Path $dataHome 'credentials.yaml';[IO.File]::WriteAllText($credential,'synthetic-only: preserve-me')
    $installed=Run-Installer $app $dataHome
    $liveReinstall=Run-Installer $app $dataHome;Stop-OwnedService $liveReinstall
    $env:EDITOR_TEST_APP=$app;$env:EDITOR_TEST_HOME=$dataHome
    & $NodePath (Join-Path $PSScriptRoot 'native-session-e2e.mjs')
    if($LASTEXITCODE -ne 0){throw "Native model-wire regression failed for $version"}
    $removed=Run-Installer $app $dataHome -Remove;Stop-OwnedService $removed
    foreach($name in $managed){if((Get-FileHash -LiteralPath (Join-Path $prefix "node_modules/@deepseek-ai/$name")).Hash -ne $before[$name]){throw "Host bytes not restored: $version $name"}}
    if([IO.File]::ReadAllText($credential) -ne 'synthetic-only: preserve-me'){throw 'Credential sentinel was changed'}
    $reinstalled=Run-Installer $app $dataHome;Stop-OwnedService $reinstalled
    $removedAgain=Run-Installer $app $dataHome -Remove;Stop-OwnedService $removedAgain
    $records+=@{version=$version;exeInstall=$true;defaultConfig=$true;nativeWire=$true;uninstall=$true;reinstall=$true;credentialsUnchanged=$true}
    $records | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'evidence.json') -Encoding UTF8
    Write-Output "PASS DSH $version : native requests, EXE install/uninstall/reinstall, original host bytes, credentials"
}
Write-Output ('Matrix evidence retained in '+$root)
