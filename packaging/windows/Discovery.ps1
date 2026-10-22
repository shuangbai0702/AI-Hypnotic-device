# Discovery is read-only. Never start/stop DSH or install packages while probing.
function Test-DshDirectory([string]$Directory) {
    if (-not $Directory) { return $false }
    try { return ((Test-Path -LiteralPath (Join-Path $Directory 'lib/bin.js')) -and ((Get-Content -LiteralPath (Join-Path $Directory 'package.json') -Raw | ConvertFrom-Json).name -eq '@deepseek-ai/dsh')) -or ((Test-Path -LiteralPath (Join-Path $Directory 'resources/app.asar')) -and (Test-Path -LiteralPath (Join-Path $Directory 'DeepSeek Harness.exe'))) } catch { return $false }
}
function Get-NodeProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
}
function Get-PreferredDshIndex([object[]]$Candidates,[int]$PreferredPort=3080) {
    if($Candidates.Count -eq 1){return 0}
    $matches=@(for($i=0;$i -lt $Candidates.Count;$i++){
        if($Candidates[$i].source -eq '正在运行' -and $Candidates[$i].profile -eq 'web' -and $Candidates[$i].port -eq $PreferredPort){$i}
    })
    if($matches.Count -eq 1){return [int]$matches[0]}
    return -1
}
function Get-ProcessDshApp($Process) {
    if (-not $Process -or $Process.Name -ne 'node.exe') { return $null }
    $match = [regex]::Match($Process.CommandLine, '(?:"(?<bin>[^"\r\n]+[\\/]lib[\\/]bin\.js)"|(?<bin>[^\s"]+[\\/]lib[\\/]bin\.js))')
    if ($match.Success) { return Split-Path -Parent (Split-Path -Parent $match.Groups['bin'].Value) }
}
function Test-StandardDshWebLaunch($Process,[int]$SelectedPort) {
    if(-not (Get-ProcessDshApp $Process)){return $false}
    $bin=[regex]::Match($Process.CommandLine,'(?:"[^"\r\n]+[\\/]lib[\\/]bin\.js"|[^\s"]+[\\/]lib[\\/]bin\.js)')
    $tail=$Process.CommandLine.Substring($bin.Index+$bin.Length).Trim()
    if($tail -notmatch '^web(?:\s+(?:--no-open|--port\s+\d+))*$'){return $false}
    $ports=[regex]::Matches($tail,'--port\s+(\d+)')
    if($ports.Count -gt 1){return $false}
    if($ports.Count -eq 1){return [int]$ports[0].Groups[1].Value -eq $SelectedPort}
    return $SelectedPort -eq 3080
}
function Get-CommonNodeDirectories {
    $roots=@($env:NVM_HOME,$env:NVM_SYMLINK,$env:FNM_DIR,$env:VOLTA_HOME,$env:NODE_HOME)
    foreach ($base in @($env:APPDATA,$env:LOCALAPPDATA,$env:ProgramFiles,${env:ProgramFiles(x86)},$env:USERPROFILE)) {
        if ($base) { foreach ($relative in @('nodejs','nvm','fnm/node-versions','Volta/tools/image/node','scoop/apps/nodejs/current','scoop/apps/nodejs-lts/current','.volta/tools/image/node','.nvm/versions/node')) { $roots+=Join-Path $base $relative } }
    }
    foreach ($root in $roots) {
        if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $root
        foreach ($child in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Select-Object -First 60)) {
            $child.FullName
            Join-Path $child.FullName 'installation'
        }
    }
}
function Find-DshCandidates([int]$PreferredPort=3080,[int]$Attempts=3) {
    for ($attempt=0; $attempt -lt $Attempts; $attempt++) {
        $paths=New-Object 'System.Collections.Generic.List[object]'
        $processes=Get-NodeProcesses
        $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
        foreach ($process in $processes) {
            $app=Get-ProcessDshApp $process
            if ($app) {
                $ports=@($listeners | Where-Object {$_.OwningProcess -eq $process.ProcessId} | Select-Object -ExpandProperty LocalPort -Unique)
                $selectedPort=if ($ports -contains $PreferredPort) {$PreferredPort} elseif($ports.Count -eq 1){$ports[0]} else {$PreferredPort}
                $paths.Add(@{path=$app;source='正在运行';process=$process;port=$selectedPort})
            }
        }
        if ($env:DSH_APP) { $paths.Add(@{path=$env:DSH_APP;source='DSH_APP';port=$PreferredPort}) }
        foreach($base in @($env:LOCALAPPDATA,$env:ProgramFiles,${env:ProgramFiles(x86)})) {
            if($base){foreach($folder in @('DeepSeek Harness','Programs/DeepSeek Harness','DSH','Programs/DSH')){$paths.Add(@{path=(Join-Path $base $folder);source='桌面安装目录';port=0})}}
        }
        $prefixes=@()
        foreach ($command in @(Get-Command dsh,dsh.cmd,npm,npm.cmd -All -ErrorAction SilentlyContinue)) { if($command.Source){$prefixes+=Split-Path -Parent $command.Source} }
        if ($env:APPDATA) { $prefixes+=Join-Path $env:APPDATA 'npm' }
        if ($env:LOCALAPPDATA) { $prefixes+=Join-Path $env:LOCALAPPDATA 'pnpm/global/5' }
        if ($env:NPM_CONFIG_PREFIX) { $prefixes+=$env:NPM_CONFIG_PREFIX }
        $npmrc=Join-Path $env:USERPROFILE '.npmrc'
        if(Test-Path -LiteralPath $npmrc){foreach($line in Get-Content -LiteralPath $npmrc){if($line -match '^\s*prefix\s*=\s*(.+?)\s*$'){$prefixes+=[Environment]::ExpandEnvironmentVariables($matches[1].Trim('"',"'"))}}}
        $prefixes+=@(Get-CommonNodeDirectories)
        foreach ($prefix in $prefixes) { if($prefix){$paths.Add(@{path=(Join-Path $prefix 'node_modules/@deepseek-ai/dsh');source='命令/PATH/npm/版本管理器';port=$PreferredPort})} }
        foreach($base in @($env:LOCALAPPDATA,$env:APPDATA)) {
            if(-not $base){continue}
            $cache=Join-Path $base 'npm-cache/_npx'
            if(Test-Path -LiteralPath $cache){foreach($dir in @(Get-ChildItem -LiteralPath $cache -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 60)){$paths.Add(@{path=(Join-Path $dir.FullName 'node_modules/@deepseek-ai/dsh');source='npx 缓存';port=$PreferredPort})}}
        }
        $seen=@{}; $found=@()
        foreach ($entry in $paths) {
            if (-not (Test-DshDirectory $entry.path)) { continue }
            $full=[IO.Path]::GetFullPath($entry.path).TrimEnd('\')
            if($seen.ContainsKey($full.ToLowerInvariant())){continue}; $seen[$full.ToLowerInvariant()]=$true
            $isDesktop=Test-Path -LiteralPath (Join-Path $full 'resources/app.asar')
            $meta=if($isDesktop){@{version=(Get-Item -LiteralPath (Join-Path $full 'DeepSeek Harness.exe')).VersionInfo.ProductVersion}}else{Get-Content -LiteralPath (Join-Path $full 'package.json') -Raw | ConvertFrom-Json}
            $detectedHome=if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path $env:USERPROFILE '.dsh'}
            $adjacent=Join-Path (Split-Path -Parent $full) 'home'
            if(-not $env:DSH_HOME -and (Test-Path -LiteralPath (Join-Path $adjacent 'profiles/web/package.json'))){$detectedHome=$adjacent}
            # A previous successful install records the selected data home. It
            # is stronger evidence than the installer's inherited environment.
            $ownerPath=Join-Path $full '.session-editor-adapter/owner.json'
            if(Test-Path -LiteralPath $ownerPath){
                try{
                    $owner=Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
                    if($owner.active -and $owner.home){$detectedHome=$owner.home}
                }catch{}
            }
            $found+=@{app=$full;home=$detectedHome;version=$meta.version;source=$entry.source;port=$(if($isDesktop){$PreferredPort}else{$entry.port});profile=$(if($isDesktop){'desktop'}else{'web'});node=$(if($entry.process){$entry.process.ExecutablePath}else{''});label=("DSH "+$meta.version+' · '+$entry.source+' · '+$full)}
        }
        if($found.Count){return $found}
        if($attempt+1 -lt $Attempts){Start-Sleep -Milliseconds (200*($attempt+1))}
    }
    return @()
}
function Test-NodeRuntime([string]$Path) {
    if(-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)){return $null}
    $process=$null
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=$Path; $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $start.Arguments='-e "const z=require(''node:zlib'');if(Number(process.versions.node.split(''.'')[0])<24||typeof Promise.withResolvers!==''function'')process.exit(2);const b=Buffer.from(''runtime-probe'');if(!z.zstdDecompressSync(z.zstdCompressSync(b)).equals(b))process.exit(3);console.log(JSON.stringify({version:process.version,arch:process.arch}));"'
    try {
        $process=[Diagnostics.Process]::Start($start)
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(5000)){try{$process.Kill()}catch{};return $null}
        if($process.ExitCode -ne 0){return $null}
        $data=$stdout.GetAwaiter().GetResult() | ConvertFrom-Json
        return @{path=[IO.Path]::GetFullPath($Path);version=$data.version;arch=$data.arch}
    } catch { return $null } finally { if($process){$process.Dispose()} }
}
function Find-NodeRuntime([string]$App,[string]$PreferredNode,[int]$Attempts=2) {
    # Fast paths avoid unrelated process discovery when the selected runtime
    # or the desktop's own Node already satisfies the capability contract.
    foreach($direct in @($PreferredNode,$(if($App){Join-Path $App 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe'}))) {
        $runtime=Test-NodeRuntime $direct;if($runtime){return $runtime}
    }
    $candidates=@($PreferredNode)
    foreach($process in @(Get-NodeProcesses)) {if((Get-ProcessDshApp $process) -eq $App){$candidates+=$process.ExecutablePath}}
    if($App){foreach($relative in @('resources/runtime/primary-runtime/dependencies/node/bin/node.exe','node.exe','bin/node.exe','runtime/node.exe','node/node.exe','../../node.exe','../../../node.exe','../../../../node.exe')){$candidates+=Join-Path $App $relative}}
    foreach($command in @(Get-Command node.exe -All -ErrorAction SilentlyContinue)){if($command.Source){$candidates+=$command.Source}}
    foreach($directory in @(Get-CommonNodeDirectories)){$candidates+=Join-Path $directory 'node.exe'}
    if($env:LOCALAPPDATA){$cache=Join-Path $env:LOCALAPPDATA 'AI-Hypnotic-device/runtimes';if(Test-Path -LiteralPath $cache){foreach($dir in @(Get-ChildItem -LiteralPath $cache -Directory -ErrorAction SilentlyContinue)){$candidates+=Join-Path $dir.FullName 'node.exe'}}}
    $unique=@($candidates | Where-Object {$_} | ForEach-Object {[IO.Path]::GetFullPath($_)} | Select-Object -Unique)
    for($attempt=0;$attempt -lt $Attempts;$attempt++){
        foreach($candidate in $unique){$runtime=Test-NodeRuntime $candidate;if($runtime){return $runtime}}
        if($attempt+1 -lt $Attempts){Start-Sleep -Milliseconds 250}
    }
    return $null
}
function Get-VerifiedNode24([string]$CacheRoot) {
    if(-not $CacheRoot){$CacheRoot=Join-Path $env:LOCALAPPDATA 'AI-Hypnotic-device/runtimes'}
    $architecture=if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64'){'arm64'}else{'x64'}
    $base='https://nodejs.org/dist/latest-v24.x/'
    $lastError=$null
    for($attempt=0;$attempt -lt 3;$attempt++){
        $downloadRoot=Join-Path $CacheRoot ('download-'+[guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
        try {
            $checks=(Invoke-WebRequest -UseBasicParsing -Uri ($base+'SHASUMS256.txt') -TimeoutSec 30).Content
            $match=[regex]::Match($checks, '(?m)^([a-f0-9]{64})\s+(node-v24\.\d+\.\d+-win-'+$architecture+'\.zip)\s*$')
            if(-not $match.Success){throw '官方校验清单没有所需 Windows Node 24'}
            $name=$match.Groups[2].Value; $zipPath=Join-Path $downloadRoot $name
            Invoke-WebRequest -UseBasicParsing -Uri ($base+$name) -OutFile $zipPath -TimeoutSec 60
            if((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value){throw 'Node 下载校验失败'}
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
            try{foreach($entry in $zip.Entries){$absolute=[IO.Path]::GetFullPath((Join-Path $downloadRoot $entry.FullName));if(-not $absolute.StartsWith([IO.Path]::GetFullPath($downloadRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Node ZIP 包含越界路径'}}}finally{$zip.Dispose()}
            Expand-Archive -LiteralPath $zipPath -DestinationPath $downloadRoot
            $folder=$name.Substring(0,$name.Length-4); $destination=Join-Path $CacheRoot $folder
            if(Test-Path -LiteralPath $destination){$runtime=Test-NodeRuntime (Join-Path $destination 'node.exe');if($runtime){return $runtime};throw '已有 Node 缓存无效，请检查缓存目录'}
            Move-Item -LiteralPath (Join-Path $downloadRoot $folder) -Destination $destination
            $runtime=Test-NodeRuntime (Join-Path $destination 'node.exe');if(-not $runtime){throw '下载的 Node 未通过能力检查'}
            return $runtime
        } catch {$lastError=$_.Exception.Message} finally {
            $absolute=[IO.Path]::GetFullPath($downloadRoot);$parent=[IO.Path]::GetFullPath($CacheRoot)+[IO.Path]::DirectorySeparatorChar
            if($absolute.StartsWith($parent,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $absolute -Leaf) -like 'download-*'){Remove-Item -LiteralPath $absolute -Recurse -Force -ErrorAction SilentlyContinue}
        }
    }
    throw ('未找到合适的本机 Node，自动下载也未完成：'+$lastError)
}
