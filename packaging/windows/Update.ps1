# Updates are optional presentation work. They never touch the selected DSH.
function Compare-ReleaseVersion([string]$Left,[string]$Right) {
    # Public updater follows stable releases only. Core installer additionally
    # supports prereleases through its strict semantic-version implementation.
    if($Left.Length -gt 128 -or $Right.Length -gt 128 -or $Left -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z' -or $Right -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z'){throw '更新版本号格式不受支持'}
    $a=$Left.Split('.');$b=$Right.Split('.')
    for($i=0;$i -lt 3;$i++){
        if($a[$i].Length -ne $b[$i].Length){return [Math]::Sign($a[$i].Length-$b[$i].Length)}
        $order=[string]::CompareOrdinal($a[$i],$b[$i]);if($order){return [Math]::Sign($order)}
    };return 0
}
function Test-ReleaseAssetUrl([string]$Url,[string]$Tag,[string]$Name) {
    return $Url -ceq ('https://github.com/shuangbai0702/AI-Hypnotic-device/releases/download/'+$Tag+'/'+$Name)
}
function Expand-VerifiedUpdate([string]$ZipPath,[string]$Destination,[string]$Version) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $prefix='AI-Hypnotic-device-Setup-'+$Version+'-windows/'
    $root=[IO.Path]::GetFullPath($Destination).TrimEnd('\')+[IO.Path]::DirectorySeparatorChar
    $zip=[IO.Compression.ZipFile]::OpenRead($ZipPath);$names=@{};$total=[long]0
    try {
        if($zip.Entries.Count -gt 512){throw '更新文件数量异常'}
        foreach($entry in $zip.Entries){
            $name=$entry.FullName.Replace('\','/');$total+=$entry.Length
            if(-not $name.StartsWith($prefix,[StringComparison]::Ordinal) -or $name.Contains(':') -or $total -gt 33554432 -or $names.ContainsKey($name)){throw '更新包结构异常'}
            $names[$name]=$true
            $target=[IO.Path]::GetFullPath((Join-Path $Destination $name))
            if(-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw '更新包包含越界路径'}
            $segments=$name.TrimEnd('/').Split('/')
            if(@($segments | Where-Object {$_ -in '.','..' -or $_.TrimEnd(' ','.') -ne $_}).Count){throw '更新包路径无效'}
            if((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw '更新包不允许符号链接'}
        }
    } finally {$zip.Dispose()}
    [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath,$Destination)
    $package=Join-Path $Destination $prefix.TrimEnd('/')
    $manifest=Get-Content -LiteralPath (Join-Path $package 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $pkg=Get-Content -LiteralPath (Join-Path $package 'plugin/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if($manifest.release -cne $Version -or $pkg.version -cne $Version -or $pkg.name -cne '@shuangbai/dsh-session-editor'){throw '更新包版本或标识不一致'}
    $listed=@{}
    foreach($file in $manifest.files){
        $path=[IO.Path]::GetFullPath((Join-Path $package $file.path))
        if(-not $path.StartsWith($package.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or $listed.ContainsKey($path) -or $file.sha256 -notmatch '^[a-f0-9]{64}$'){throw '更新清单路径或哈希无效'}
        if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256){throw '更新文件校验失败'}
        $listed[$path]=$true
    }
    foreach($file in Get-ChildItem -LiteralPath $package -File -Recurse){if($file.FullName -ne (Join-Path $package 'manifest.json') -and -not $listed.ContainsKey($file.FullName)){throw '更新包包含清单外文件'}}
    foreach($required in @('source/Installer.ps1','plugin/install.mjs','双白DSH安装器.exe')){if(-not $listed.ContainsKey([IO.Path]::GetFullPath((Join-Path $package $required)))){throw '更新包缺少必要文件'}}
    return (Join-Path $package '双白DSH安装器.exe')
}
function Get-InstallerUpdate([string]$CurrentVersion,[string]$CacheRoot) {
    [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if(-not $CacheRoot){$CacheRoot=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AI-Hypnotic-device/updates'}
    $work=$null;$keep=$false
    try {
        $release=$null;$failure=$null
        for($attempt=0;$attempt -lt 2;$attempt++){
            try{$release=Invoke-RestMethod -Uri 'https://api.github.com/repos/shuangbai0702/AI-Hypnotic-device/releases/latest' -Headers @{'User-Agent'='AI-Hypnotic-device-installer';'Accept'='application/vnd.github+json'} -TimeoutSec 12;break}catch{$failure=$_}
        }
        if(-not $release){throw $failure}
        $version=([string]$release.tag_name) -creplace '^v',''
        if($release.draft -or $release.prerelease){throw '更新来源不是稳定发布'}
        if((Compare-ReleaseVersion $version $CurrentVersion) -le 0){return @{ok=$true;updated=$false;message=('当前安装包 v'+$CurrentVersion+' 已是最新或更新版本。')}}
        $name='AI-Hypnotic-device-Setup-'+$version+'-windows.zip'
        $assets=@($release.assets | Where-Object {$_.name -ceq $name})
        if($assets.Count -ne 1 -or -not (Test-ReleaseAssetUrl $assets[0].browser_download_url $release.tag_name $name) -or $assets[0].size -le 0 -or $assets[0].size -gt 8388608 -or $assets[0].digest -cnotmatch '^sha256:[a-f0-9]{64}$'){throw '新版发布附件缺失或缺少可信校验值'}
        $work=Join-Path $CacheRoot ('update-'+[guid]::NewGuid().ToString());New-Item -ItemType Directory -Path $work -Force | Out-Null
        $archive=Join-Path $work 'release.zip'
        Invoke-WebRequest -UseBasicParsing -Uri $assets[0].browser_download_url -OutFile $archive -TimeoutSec 45 | Out-Null
        if((Get-Item -LiteralPath $archive).Length -ne $assets[0].size -or ('sha256:'+(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $assets[0].digest){throw '新版下载不完整或 SHA256 校验失败'}
        $exe=Expand-VerifiedUpdate $archive (Join-Path $work 'package') $version
        $keep=$true
        return @{ok=$true;updated=$true;version=$version;executable=$exe;message=('新版 v'+$version+' 已下载并校验。')}
    } catch {return @{ok=$false;updated=$false;message=('自动更新暂不可用，仍可使用当前安装包：'+$_.Exception.Message)}}
    finally {
        if($work -and -not $keep){$absolute=[IO.Path]::GetFullPath($work);if($absolute.StartsWith([IO.Path]::GetFullPath($CacheRoot).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $absolute -Leaf) -like 'update-*'){Remove-Item -LiteralPath $absolute -Recurse -Force -ErrorAction SilentlyContinue}}
    }
}
