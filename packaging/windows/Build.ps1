param([string]$OutputDirectory)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$packagedRoot=Split-Path -Parent $PSScriptRoot
$packaged=Test-Path -LiteralPath (Join-Path $packagedRoot 'plugin/install.mjs')
$plugin=if($packaged){Join-Path $packagedRoot 'plugin'}else{Join-Path $project 'plugins/dsh-session-editor'}
$version=(Get-Content -LiteralPath (Join-Path $plugin 'package.json') -Raw | ConvertFrom-Json).version
if (-not $OutputDirectory) { $OutputDirectory=if($packaged){$packagedRoot+'-rebuilt'}else{Join-Path $project ("dist/AI-Hypnotic-device-Setup-$version-windows")} }
$release=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $release,(Join-Path $release 'source'),(Join-Path $release 'plugin/lib') | Out-Null
foreach($name in @('package.json','README.md','AGENT.md','install.mjs','host-adapter.mjs')) { Copy-Item -LiteralPath (Join-Path $plugin $name) -Destination (Join-Path $release "plugin/$name") -Force }
foreach($file in Get-ChildItem -LiteralPath (Join-Path $plugin 'lib') -File) { if($file.Extension -in '.js','.mjs') { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $release 'plugin/lib') -Force } }
foreach($name in @('Installer.ps1','Build.ps1','Discovery.ps1')) { [IO.File]::WriteAllText((Join-Path $release "source/$name"),[IO.File]::ReadAllText((Join-Path $PSScriptRoot $name)),(New-Object Text.UTF8Encoding($true))) }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Launcher.cs') -Destination (Join-Path $release 'source/Launcher.cs') -Force
$readme=if($packaged){Join-Path $packagedRoot '使用说明.md'}else{Join-Path $PSScriptRoot 'README.md'}
Copy-Item -LiteralPath $readme -Destination (Join-Path $release '使用说明.md') -Force
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /r:System.Windows.Forms.dll ("/out:"+(Join-Path $release '双白DSH安装器.exe')) (Join-Path $PSScriptRoot 'Launcher.cs')
if($LASTEXITCODE -ne 0) { throw 'EXE 编译失败' }
$manifest=@{ release=$version; defaultPort=3080; discovery='running DSH / PATH / standard npm install'; files=@(Get-ChildItem -LiteralPath $release -File -Recurse | Where-Object {$_.Name -ne 'manifest.json'} | ForEach-Object { @{ path=$_.FullName.Substring($release.Length+1).Replace('\','/').Replace([char]92,[char]47); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } }) }
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $release 'manifest.json') -Encoding UTF8
Write-Output $release
