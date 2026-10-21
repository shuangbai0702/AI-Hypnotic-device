param(
    [Parameter(Mandatory=$true)][string]$QaRoot,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$InstallerRoot,
    [Parameter(Mandatory=$true)][string]$AppPath,
    [Parameter(Mandatory=$true)][string]$DataHome,
    [int]$Port=3197
)
$ErrorActionPreference='Stop'
$QaRoot=(Resolve-Path -LiteralPath $QaRoot).Path
$AppPath=(Resolve-Path -LiteralPath $AppPath).Path;$DataHome=(Resolve-Path -LiteralPath $DataHome).Path
$NodePath=(Resolve-Path -LiteralPath $NodePath).Path;$InstallerRoot=(Resolve-Path -LiteralPath $InstallerRoot).Path
if($Port -in 3080,3099){throw 'Protected port'}
foreach($target in @($AppPath,$DataHome)){if(-not $target.StartsWith($QaRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Only a disposable copy inside QaRoot is allowed'}}
if(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue){throw 'Test port must be free'}
$env:TEMP=Join-Path $QaRoot 'tmp';$env:TMP=$env:TEMP
function Run-Exe([string]$Package,[switch]$Remove,[switch]$ExpectFailure) {
    $file=Join-Path $QaRoot ('health-result-'+[guid]::NewGuid().ToString()+'.json')
    $start=New-Object Diagnostics.ProcessStartInfo;$start.FileName=Join-Path $Package '双白DSH安装器.exe'
    $start.Arguments='-Apply -AppPath "'+$AppPath+'" -DshHome "'+$DataHome+'" -Port '+$Port+' -NodePath "'+$NodePath+'" -NoBrowser -ResultFile "'+$file+'"'
    if($Remove){$start.Arguments+=' -Uninstall'};$start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $child=[Diagnostics.Process]::Start($start)
    try{
        if(-not $child.WaitForExit(90000)){throw 'Installer timeout; own process retained'}
        $result=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        if($ExpectFailure){if($result.ok -or $result.error -notmatch '已回滚'){throw 'Expected a reported health rollback'}}
        elseif(-not $result.ok -or -not $result.healthVerified){throw $result.error}
        return $result
    }finally{$child.Dispose()}
}
function Stop-Owned($Result) {
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($Result.processId)"
    if($p){if($p.Name -ne 'node.exe' -or $p.CommandLine -notlike ('*'+$QaRoot+'*')){throw 'Unowned process'};Stop-Process -Id $p.ProcessId;Wait-Process -Id $p.ProcessId -Timeout 10 -ErrorAction SilentlyContinue}
}
if(Test-Path -LiteralPath (Join-Path $DataHome 'profiles/web/node_modules/@shuangbai/dsh-session-editor/package.json')){$removed=Run-Exe $InstallerRoot -Remove;Stop-Owned $removed}
$env:EDITOR_TEST_APP=$AppPath
$module=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../plugins/dsh-session-editor/host-adapter.mjs')).Path
$env:QA_ADAPTER_MODULE=$module
$files=@(& $NodePath --input-type=module -e 'import {pathToFileURL} from "node:url";const {resolveHostFile}=await import(pathToFileURL(process.env.QA_ADAPTER_MODULE));for(const [pkg,file] of [["dsh-agent","index.js"],["dsh-agent-loop","index.js"],["dsh-api-session-controller","client.js"]])console.log(resolveHostFile(process.env.EDITOR_TEST_APP,`node_modules/@deepseek-ai/${pkg}/lib/${file}`));')
if($LASTEXITCODE -ne 0 -or $files.Count -ne 3){throw 'Host lookup failed'}
$before=@{};foreach($file in $files){$before[$file]=(Get-FileHash -LiteralPath $file).Hash}
$config=Join-Path $DataHome 'profiles/web/cordis.patch.yml';$configBefore=[IO.File]::ReadAllText($config)
$credential=Join-Path $DataHome 'credentials-health-test.yaml';[IO.File]::WriteAllText($credential,'synthetic-only: unchanged')
$broken=Join-Path $QaRoot ('installer-failure-'+[guid]::NewGuid().ToString());Copy-Item -LiteralPath $InstallerRoot -Destination $broken -Recurse
[IO.File]::WriteAllText((Join-Path $broken 'plugin/lib/index.js'),"throw new Error('isolated plugin initialization failure');")
$failed=Run-Exe $broken -ExpectFailure
foreach($file in $files){if((Get-FileHash -LiteralPath $file).Hash -ne $before[$file]){throw 'Host not rolled back'}}
if([IO.File]::ReadAllText($config) -ne $configBefore){throw 'Profile not rolled back'}
if([IO.File]::ReadAllText($credential) -ne 'synthetic-only: unchanged'){throw 'Credential sentinel changed'}
if(Test-Path -LiteralPath (Join-Path $DataHome '.session-editor-transactions/pending.json')){throw 'Pending transaction after successful rollback'}
if(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue){throw 'Failed own service still running'}
$installed=Run-Exe $InstallerRoot;Stop-Owned $installed
$env:EDITOR_TEST_DISPOSABLE='yes';$env:EDITOR_TEST_HOME=$DataHome;$env:EDITOR_TEST_PORT=[string]$Port
& $NodePath (Join-Path $PSScriptRoot 'native-session-e2e.mjs')
if($LASTEXITCODE -ne 0){throw 'Post-recovery native wire test failed'}
$removed=Run-Exe $InstallerRoot -Remove;Stop-Owned $removed
foreach($file in $files){if((Get-FileHash -LiteralPath $file).Hash -ne $before[$file]){throw 'Final uninstall did not restore host'}}
@{ok=$true;actualStartupHealthFailureRollback=$true;retryAndNativeWire=$true;uninstall=$true;credentialsUnchanged=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $QaRoot 'health-rollback-evidence.json') -Encoding UTF8
Write-Output 'PASS actual EXE: failed plugin health rolls back, retry/native model wire/uninstall succeed, credential sentinel preserved'
