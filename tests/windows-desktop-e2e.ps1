param([Parameter(Mandatory=$true)][string]$QaRoot,[Parameter(Mandatory=$true)][string]$InstallerRoot,[switch]$NativeWire)
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../testdata')).Path
$QaRoot=(Resolve-Path -LiteralPath $QaRoot).Path
if(-not $QaRoot.StartsWith($workspace+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Only a disposable testdata copy is allowed'}
$InstallerRoot=(Resolve-Path -LiteralPath $InstallerRoot).Path
$app=Join-Path $QaRoot 'application';$dataHome=Join-Path $QaRoot 'install-home'
$archive=Join-Path $app 'resources/app.asar'
$manifest=Join-Path $dataHome '.session-editor-install-desktop/install.json'
$env:HOME=Join-Path $QaRoot 'user';$env:USERPROFILE=$env:HOME;$env:APPDATA=Join-Path $env:HOME 'appdata';$env:LOCALAPPDATA=Join-Path $env:HOME 'localappdata'
$script:records=@()
function Run-Exe([string]$Name,[switch]$Remove,[switch]$ExpectFailure){
    $file=Join-Path $QaRoot ($Name+'.json')
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=Join-Path $InstallerRoot '双白DSH安装器.exe'
    $start.Arguments='-Apply -AppPath "'+$app+'" -DshHome "'+$dataHome+'" -Port 3198 -NoDownload -NoBrowser -ResultFile "'+$file+'"'
    if($Remove){$start.Arguments+=' -Uninstall'}
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $child=[Diagnostics.Process]::Start($start)
    try{if(-not $child.WaitForExit(90000)){throw 'Owned desktop installer timeout'};$code=$child.ExitCode}finally{$child.Dispose()}
    $value=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if($ExpectFailure){if($code -eq 0 -or $value.ok){throw 'Unhealthy desktop incorrectly accepted'}}
    elseif($code -ne 0 -or -not $value.ok -or -not $value.healthVerified -or $value.healthScope -ne 'desktop-host' -or $value.windowVerified){throw ('Desktop result mismatch: '+$value.error)}
    if(Test-Path -LiteralPath (Join-Path $dataHome '.session-editor-transactions-desktop/pending.json')){throw 'Desktop transaction remains pending'}
    $script:records+=@{step=$Name;passed=$true;expectedFailure=[bool]$ExpectFailure;healthScope=$value.healthScope;windowVerified=$value.windowVerified}
    Write-Output ('PASS '+$Name)
}
# A prior isolated manual probe may have installed into this same owned home.
$ownerPath=Join-Path $app '.session-editor-adapter/owner.json'
if((Test-Path -LiteralPath $manifest) -and (Test-Path -LiteralPath $ownerPath)){
    $owner=Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
    if($owner.active){Run-Exe 'desktop-prepare-uninstall' -Remove}
}
$original=(Get-FileHash -LiteralPath $archive).Hash
New-Item -ItemType Directory -Force -Path $dataHome | Out-Null
$credential=Join-Path $dataHome '.credentials.yaml'
$secret=[Convert]::ToBase64String([byte[]](1..32)).TrimEnd('=').Replace('+','-').Replace('/','_')
$credentialText="version: 1`nrefs: {}`nrecords:`n  client-connection/browser-session:`n    kind: grant`n    payload:`n      version: 1`n      secret: $secret`n# synthetic-desktop-credential-preserve`n"
[IO.File]::WriteAllText($credential,$credentialText)
Run-Exe 'desktop-install'
if($NativeWire){
    $env:EDITOR_TEST_DISPOSABLE='yes';$env:EDITOR_TEST_APP=Join-Path $archive 'dsh/node_modules/@deepseek-ai/dsh';$env:EDITOR_TEST_HOME=$dataHome;$env:EDITOR_TEST_PORT='3198'
    $env:EDITOR_TEST_DESKTOP_RUNTIME=Join-Path $archive 'dsh';$env:EDITOR_TEST_PRIMARY_RUNTIME=Join-Path $app 'resources/runtime/primary-runtime';$env:ELECTRON_RUN_AS_NODE='1'
    $native=New-Object Diagnostics.ProcessStartInfo;$native.FileName=Join-Path $app 'DeepSeek Harness.exe'
    $native.Arguments='--expose-internals "'+(Join-Path $PSScriptRoot 'native-session-e2e.mjs')+'"';$native.UseShellExecute=$false;$native.CreateNoWindow=$true;$native.RedirectStandardOutput=$true;$native.RedirectStandardError=$true
    $owned=[Diagnostics.Process]::Start($native)
    try{
        $stdout=$owned.StandardOutput.ReadToEndAsync();$stderr=$owned.StandardError.ReadToEndAsync()
        if(-not $owned.WaitForExit(90000)){throw 'Owned desktop native-wire timeout'}
        $text=$stdout.GetAwaiter().GetResult()+$stderr.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $QaRoot 'desktop-native.log'),$text)
        if($owned.ExitCode -ne 0){throw 'Desktop native-wire regression failed'}
        Write-Output 'PASS desktop native model-wire regression'
    }finally{$owned.Dispose();Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue}
}
Run-Exe 'desktop-reinstall'
Run-Exe 'desktop-uninstall' -Remove
if((Get-FileHash -LiteralPath $archive).Hash -ne $original){throw 'Desktop original archive bytes not restored'}
if([IO.File]::ReadAllText($credential) -ne $credentialText){throw 'Desktop credential bytes changed'}
Run-Exe 'desktop-reinstall-after-removal'
Run-Exe 'desktop-final-uninstall' -Remove
if((Get-FileHash -LiteralPath $archive).Hash -ne $original){throw 'Final original archive bytes mismatch'}
# Native startup rejection must undo the complete archive/profile transaction.
[IO.File]::WriteAllText($credential,'synthetic-invalid-flat-layout: rejected')
$configPath=Join-Path $dataHome 'profiles/desktop/cordis.patch.yml'
$beforeConfig=if(Test-Path -LiteralPath $configPath){[IO.File]::ReadAllText($configPath)}else{$null}
Run-Exe 'desktop-health-failure-rollback' -ExpectFailure
$afterConfig=if(Test-Path -LiteralPath $configPath){[IO.File]::ReadAllText($configPath)}else{$null}
if((Get-FileHash -LiteralPath $archive).Hash -ne $original -or $afterConfig -ne $beforeConfig){throw 'Desktop health failure did not restore original files'}
if([IO.File]::ReadAllText($credential) -ne 'synthetic-invalid-flat-layout: rejected'){throw 'Failure path changed credentials'}
[IO.File]::WriteAllText($credential,$credentialText)
$script:records | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $QaRoot 'desktop-exe-matrix.json') -Encoding UTF8
Write-Output 'PASS desktop EXE matrix, exact ASAR restore, credentials and native health rollback; window remains unverified'
