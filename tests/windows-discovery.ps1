param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../packaging/windows/Discovery.ps1')
. (Join-Path $PSScriptRoot '../packaging/windows/Desktop.ps1')
$NodePath=(Resolve-Path -LiteralPath $NodePath).Path
$root=Join-Path ([IO.Path]::GetTempPath()) ('dsh-discovery-'+[guid]::NewGuid().ToString())
$root=[IO.Path]::GetFullPath($root)
$app=Join-Path $root 'host with spaces';$dataHome=Join-Path $root 'recorded-home'
$script:fakeProcesses=@();$script:fakeListeners=@();$script:managerRoot=Join-Path $root 'manager'
$names=@('DSH_APP','DSH_HOME','APPDATA','LOCALAPPDATA','USERPROFILE','NPM_CONFIG_PREFIX');$saved=@{}
foreach($name in $names){$saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
# Replace read-only discovery sources with deterministic fixtures; never query
# or mutate the actual installed DSHs or their listening processes.
function Get-NodeProcesses {return $script:fakeProcesses}
function Get-NetTCPConnection {param([string]$State,$ErrorAction);return $script:fakeListeners}
function Get-Command {param($Name,[switch]$All,$ErrorAction);return @()}
function Get-CommonNodeDirectories {return $script:managerRoot}
function Assert-True($Value,$Message){if(-not $Value){throw $Message}}
try{
    $choices=@(@{source='正在运行';profile='web';port=3099},@{source='正在运行';profile='web';port=3080},@{source='桌面安装目录';profile='desktop';port=3080})
    Assert-True ((Get-PreferredDshIndex $choices) -eq 1) 'Default release must prefer actual running web DSH on 3080 over developer and desktop targets'
    Assert-True ((Get-PreferredDshIndex $choices 3099) -eq 0) 'Explicit custom port remains supported'
    Assert-True ((Get-PreferredDshIndex @($choices[0],$choices[2])) -eq -1) 'No preferred web listener means manual selection'
    Assert-True ((Get-PreferredDshIndex @($choices[1],$choices[1])) -eq -1) 'Ambiguous preferred listener means manual selection'
    Assert-True ((Get-PreferredDshIndex @()) -eq -1) 'Empty detection cannot select a target'
    foreach($directory in @("$app/lib","$dataHome/profiles/web","$app/.session-editor-adapter",$script:managerRoot)){New-Item -ItemType Directory -Force $directory | Out-Null}
    [IO.File]::WriteAllText((Join-Path $app 'package.json'),'{"name":"@deepseek-ai/dsh","version":"0.2.1-rc.2"}')
    [IO.File]::WriteAllText((Join-Path $app 'lib/bin.js'),'// synthetic discovery only')
    [IO.File]::WriteAllText((Join-Path $dataHome 'profiles/web/package.json'),'{}')
    @{active=$true;home=$dataHome} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $app '.session-editor-adapter/owner.json') -Encoding UTF8
    $env:DSH_APP=$app;$env:DSH_HOME=Join-Path $root 'inherited-home'
    $env:APPDATA=$root;$env:LOCALAPPDATA=$root;$env:USERPROFILE=$root;$env:NPM_CONFIG_PREFIX=$root
    $found=@(Find-DshCandidates -Attempts 1)
    Assert-True ($found.Count -eq 1) 'Expected unique environment fixture'
    Assert-True ($found[0].home -eq $dataHome) 'Recorded home must override unrelated inherited home'
    $script:fakeProcesses=@([pscustomobject]@{Name='node.exe';ProcessId=123456;ExecutablePath=$NodePath;CommandLine=('"'+$NodePath+'" "'+(Join-Path $app 'lib/bin.js')+'" web --port 45678')})
    $script:fakeListeners=@([pscustomobject]@{OwningProcess=123456;LocalPort=45678})
    $running=@(Find-DshCandidates -PreferredPort 3080 -Attempts 1)
    Assert-True ($running.Count -eq 1 -and $running[0].port -eq 45678 -and $running[0].source -eq '正在运行') 'Running process provenance, deduplication and custom port'
    Assert-True ((Get-ProcessDshApp $script:fakeProcesses[0]) -eq $app) 'Quoted path with spaces'
    Assert-True (Test-StandardDshWebLaunch $script:fakeProcesses[0] 45678) 'Known launch arguments'
    Assert-True (-not (Test-StandardDshWebLaunch $script:fakeProcesses[0] 45679)) 'Mismatched port rejected'
    foreach($option in @('--host 0.0.0.0','--cwd custom','--profile custom','--port=45678','--sandbox custom')){
        $custom=[pscustomobject]@{Name='node.exe';CommandLine=($script:fakeProcesses[0].CommandLine+' '+$option)}
        Assert-True (-not (Test-StandardDshWebLaunch $custom 45678)) 'Custom launch must not be silently replaced'
    }
    Assert-True ($null -eq (Get-ProcessDshApp @{Name='unrelated.exe';CommandLine=$script:fakeProcesses[0].CommandLine})) 'Unrelated process must not match'
    $runtime=Find-NodeRuntime -App $app -PreferredNode $NodePath -Attempts 1
    Assert-True ($runtime.path -eq $NodePath -and $runtime.version -like 'v24.*') 'Preferred owned runtime capability probe'
    $script:fakeProcesses=@()
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $script:managerRoot 'node.exe')
    $managed=Find-NodeRuntime -App $app -PreferredNode (Join-Path $root 'missing.exe') -Attempts 1
    Assert-True ($managed.path -eq (Join-Path $script:managerRoot 'node.exe')) 'Version manager fallback without PATH'
    Assert-True ($null -eq (Test-NodeRuntime (Join-Path $root 'missing.exe'))) 'Missing runtime must be rejected'
    $desktop=Join-Path $root 'desktop';New-Item -ItemType Directory -Force -Path (Join-Path $desktop 'resources/runtime/primary-runtime/dependencies/node/bin') | Out-Null
    [IO.File]::WriteAllText((Join-Path $desktop 'resources/app.asar'),'synthetic-discovery-only')
    [IO.File]::WriteAllText((Join-Path $desktop 'DeepSeek Harness.exe'),'synthetic-discovery-only')
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $desktop 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe')
    $env:DSH_APP=$desktop;$script:managerRoot=Join-Path $root 'missing-manager'
    $desktopFound=@(Find-DshCandidates -Attempts 1)
    Assert-True ($desktopFound.Count -eq 1 -and $desktopFound[0].profile -eq 'desktop') 'Desktop layout discovery'
    $bundled=Find-NodeRuntime -App $desktop -Attempts 1
    Assert-True ($bundled.path -eq (Join-Path $desktop 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe')) 'Desktop bundled Node reuse'
    $script:capturedHome=$null;$script:launchFails=$false
    function Start-Process {param($FilePath,$WindowStyle,[switch]$PassThru)
        $script:capturedHome=$env:DSH_HOME
        if($script:launchFails){throw 'synthetic launch failure'}
        return @{executable=$FilePath;windowStyle=$WindowStyle}
    }
    $inheritedHome=$env:DSH_HOME
    $launched=Start-SelectedDesktopWindow 'synthetic-desktop.exe' $dataHome
    Assert-True ($script:capturedHome -eq $dataHome -and $launched.windowStyle -eq 'Normal') 'Desktop launch must inherit selected home and show the window'
    Assert-True ($env:DSH_HOME -eq $inheritedHome) 'Successful launch restores installer environment'
    $script:launchFails=$true
    try{Start-SelectedDesktopWindow 'synthetic-desktop.exe' $dataHome;throw 'Expected launch failure'}catch{if($_.Exception.Message -ne 'synthetic launch failure'){throw}}
    Assert-True ($env:DSH_HOME -eq $inheritedHome) 'Failed launch restores installer environment'
    Write-Output 'PASS discovery: quoted processes, deduplication, selected port/home, runtime capability and manager fallback'
}finally{
    foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')}
    $absolute=[IO.Path]::GetFullPath($root);$expected=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($absolute.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $absolute -Leaf) -like 'dsh-discovery-*'){Remove-Item -LiteralPath $absolute -Recurse -Force}
}
