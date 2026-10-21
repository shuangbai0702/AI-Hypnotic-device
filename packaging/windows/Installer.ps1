param(
    [switch]$Apply,
    [string]$AppPath,
    [string]$DshHome,
    [ValidateRange(1024,65535)][int]$Port = 3080,
    [switch]$Uninstall,
    [switch]$NoBrowser,
    [switch]$NoStart,
    [string]$ResultFile
)
$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent $PSScriptRoot

function Get-Listener([int]$SelectedPort) {
    $row = Get-NetTCPConnection -State Listen -LocalPort $SelectedPort -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($row) { return Get-CimInstance Win32_Process -Filter "ProcessId=$($row.OwningProcess)" }
}
function Get-ProcessApp($Process) {
    if (-not $Process -or $Process.Name -ne 'node.exe') { return $null }
    $match = [regex]::Match($Process.CommandLine, '(?:"(?<bin>[^"\r\n]+[\\/]lib[\\/]bin\.js)"|(?<bin>[^\s"]+[\\/]lib[\\/]bin\.js))')
    if ($match.Success) { return Split-Path -Parent (Split-Path -Parent $match.Groups['bin'].Value) }
}
function Test-DshApp([string]$Directory) {
    try { return (Test-Path -LiteralPath (Join-Path $Directory 'lib/bin.js')) -and ((Get-Content -LiteralPath (Join-Path $Directory 'package.json') -Raw | ConvertFrom-Json).name -eq '@deepseek-ai/dsh') } catch { return $false }
}
function Find-DshApp {
    $running = Get-ProcessApp (Get-Listener $Port)
    $candidates = @($running, $env:DSH_APP)
    $shim = Get-Command dsh -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($shim) { $candidates += Join-Path (Split-Path -Parent $shim.Source) 'node_modules/@deepseek-ai/dsh' }
    $candidates += Join-Path $env:APPDATA 'npm/node_modules/@deepseek-ai/dsh'
    foreach ($candidate in $candidates) { if ($candidate -and (Test-DshApp $candidate)) { return [IO.Path]::GetFullPath($candidate) } }
    return ''
}
function Invoke-Install {
    if (-not (Test-DshApp $AppPath)) { throw '未找到有效 DSH 程序目录，请选择含 lib/bin.js 的目录。' }
    $script:AppPath = (Resolve-Path -LiteralPath $AppPath).Path
    $script:DshHome = [IO.Path]::GetFullPath($DshHome)
    $listener = Get-Listener $Port
    if (-not $listener) {
        # A failed process/CIM lookup must never be interpreted as a free port.
        $probe=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,$Port)
        $probe.Server.ExclusiveAddressUse=$true
        try { $probe.Start() } catch { throw "端口 $Port 已占用且无法确认进程身份；未停止任何进程。" }
        finally { $probe.Stop() }
    }
    if ($listener) {
        $runningApp = Get-ProcessApp $listener
        if (-not $runningApp -or [IO.Path]::GetFullPath($runningApp).TrimEnd('\') -ne $AppPath.TrimEnd('\')) { throw "端口 $Port 被其他程序占用，未停止任何进程。" }
        # Restart only the ordinary web profile, preserving custom invocations.
        if ($listener.CommandLine -notmatch '(?:^|\s)web(?:\s|$)' -or $listener.CommandLine -match '--profile|--patch|--port=|--cwd') { throw '当前 DSH 使用自定义启动参数，请先手动关闭，再运行安装器；未停止进程。' }
    }
    $node = if ($listener) { $listener.ExecutablePath } else { (Get-Command node -ErrorAction Stop).Source }
    & $node -e "if(typeof require('node:zlib').zstdCompressSync!=='function')process.exit(1)"
    if ($LASTEXITCODE -ne 0) { throw '需要支持 zstd 的 Node.js，建议 Node 24。' }
    $installer = Join-Path $PackageRoot 'plugin/install.mjs'
    if ($Uninstall -and -not (Test-Path -LiteralPath (Join-Path $DshHome '.session-editor-install/install.json'))) { throw '该数据目录没有本扩展的安装记录。' }
    $checkArgs=@($installer,'--app',$AppPath,'--home',$DshHome,'--check')
    if ($Uninstall) { $checkArgs+='--uninstall' }
    & $node @checkArgs
    if ($LASTEXITCODE -ne 0) { throw '安装/卸载预检失败；未停止服务或修改目标。' }
    if ($listener) {
        # Recheck identity immediately before stopping the selected service.
        $current = Get-Listener $Port
        if (-not $current -or $current.ProcessId -ne $listener.ProcessId -or $current.CreationDate -ne $listener.CreationDate) { throw '目标服务发生变化，请重试；未停止进程。' }
        Stop-Process -Id $listener.ProcessId -ErrorAction Stop
        Wait-Process -Id $listener.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
    }
    $env:DSH_HOME = $DshHome
    New-Item -ItemType Directory -Force -Path $DshHome | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $DshHome 'profiles/web/package.json')) -and -not $Uninstall) {
        & $node (Join-Path $AppPath 'lib/bin.js') --profile web --dump-config | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '初始化 DSH web profile 失败。' }
    }
    $installArgs = @($installer, '--app', $AppPath, '--home', $DshHome)
    if ($Uninstall) { $installArgs += '--uninstall' }
    & $node @installArgs
    if ($LASTEXITCODE -ne 0) { throw '安装/卸载失败，详见日志；未启动 DSH。' }
    $serviceId = $null
    if (-not $NoStart) {
        $logs = Join-Path $DshHome 'logs/session-editor-installer'
        New-Item -ItemType Directory -Force -Path $logs | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $out = Join-Path $logs "$stamp.stdout.log"; $err = Join-Path $logs "$stamp.stderr.log"
        $bin = Join-Path $AppPath 'lib/bin.js'
        $service = Start-Process -FilePath $node -ArgumentList @(('"' + $bin + '"'),'web','--port',"$Port",'--no-open') -WorkingDirectory $env:USERPROFILE -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        $serviceId = $service.Id
        $ready = $false
        for ($i=0; $i -lt 80; $i++) {
            if ($service.HasExited) { throw "DSH 启动失败，日志位于 $err" }
            try { $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 1; $ready = $response.StatusCode -eq 200 }
            catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -in 401,403) { $ready=$true } }
            if ($ready) { $owner=Get-Listener $Port; $ready=$owner -and $owner.ProcessId -eq $serviceId }
            if ($ready) { break }; Start-Sleep -Milliseconds 250
        }
        if (-not $ready) { throw "安装完成，但服务尚未就绪。进程 $serviceId，日志位于 $logs" }
        if (-not $NoBrowser) {
            $text = Get-Content -LiteralPath $out -Raw
            $match = [regex]::Match($text, 'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_%.-]+')
            $url = if ($match.Success) { $match.Value } else { "http://127.0.0.1:$Port/" }
            Start-Process $url
        }
    }
    return @{ ok=$true; app=$AppPath; home=$DshHome; port=$Port; processId=$serviceId; uninstalled=[bool]$Uninstall }
}

if (-not $AppPath) { $AppPath = Find-DshApp }
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
if ($Apply) {
    try { $result = Invoke-Install; $result = $result | Select-Object -Last 1; if ($ResultFile) { $result | ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8 }; exit 0 }
    catch { if ($ResultFile) { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8 }; exit 1 }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = '双白 DSH · 会话记忆编辑器安装'; $form.Size = New-Object Drawing.Size(700,440); $form.StartPosition = 'CenterScreen'; $form.Font = New-Object Drawing.Font('Microsoft YaHei UI',10); $form.FormBorderStyle='FixedDialog'; $form.MaximizeBox=$false
function Add-Label($text,$x,$y,$width) { $control=New-Object Windows.Forms.Label; $control.Text=$text; $control.SetBounds($x,$y,$width,30); $form.Controls.Add($control) }
function Add-Field($text,$y) { $control=New-Object Windows.Forms.TextBox; $control.Text=$text; $control.SetBounds(125,$y,460,30); $form.Controls.Add($control); return $control }
Add-Label '将历史编辑、局部压缩和记忆助手安装到现有 DSH。' 22 18 640
Add-Label 'DSH 程序' 22 68 100; $appBox=Add-Field $AppPath 65
Add-Label 'DSH 数据' 22 118 100; $homeBox=Add-Field $DshHome 115
foreach ($item in @(@($appBox,65),@($homeBox,115))) {
    $button=New-Object Windows.Forms.Button; $button.Text='选择'; $button.SetBounds(593,$item[1],65,30); $button.Tag=$item[0]
    $button.Add_Click({ $dialog=New-Object Windows.Forms.FolderBrowserDialog; $dialog.SelectedPath=$this.Tag.Text; if ($dialog.ShowDialog() -eq 'OK') {$this.Tag.Text=$dialog.SelectedPath}; $dialog.Dispose() }); $form.Controls.Add($button)
}
Add-Label '网页端口' 22 168 100; $portBox=Add-Field "$Port" 165; $portBox.Width=100
Add-Label '默认 3080；安装时会重启所选 DSH，请先停止生成。' 22 215 640
Add-Label '保留原有模型、密钥和聊天。仅支持当前兼容构建；自动备份。' 22 245 640
$status=New-Object Windows.Forms.Label; $status.SetBounds(22,325,635,60); $form.Controls.Add($status)
$installButton=New-Object Windows.Forms.Button; $installButton.Text='安装并启动'; $installButton.SetBounds(125,285,190,36); $form.Controls.Add($installButton)
$removeButton=New-Object Windows.Forms.Button; $removeButton.Text='卸载并恢复'; $removeButton.SetBounds(335,285,190,36); $form.Controls.Add($removeButton)
$timer=New-Object Windows.Forms.Timer; $timer.Interval=250
$script:worker=$null; $script:workerResult=$null
function Start-Worker([bool]$Remove) {
    if ($script:worker) { return }
    $parsedPort=0
    if (-not [int]::TryParse($portBox.Text,[ref]$parsedPort) -or $parsedPort -lt 1024 -or $parsedPort -gt 65535) { $status.Text='请输入 1024–65535 的端口。'; return }
    $script:workerResult=Join-Path ([IO.Path]::GetTempPath()) ('dsh-installer-'+[guid]::NewGuid().ToString()+'.json')
    $arguments=@('-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Apply','-AppPath',('"'+$appBox.Text+'"'),'-DshHome',('"'+$homeBox.Text.TrimEnd('\')+'"'),'-Port',"$parsedPort",'-ResultFile',('"'+$script:workerResult+'"'))
    if ($Remove) { $arguments+='-Uninstall' }
    $script:worker=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $installButton.Enabled=$false; $removeButton.Enabled=$false; $status.Text='正在处理，请稍候…'; $timer.Start()
}
$installButton.Add_Click({ Start-Worker $false }); $removeButton.Add_Click({ Start-Worker $true })
$timer.Add_Tick({
    if ($script:worker -and $script:worker.HasExited) {
        $timer.Stop(); $result=$null
        if (Test-Path -LiteralPath $script:workerResult) { $result=Get-Content -LiteralPath $script:workerResult -Raw | ConvertFrom-Json; Remove-Item -LiteralPath $script:workerResult }
        $status.Text=if ($result -and $result.ok) { if ($result.uninstalled) {'卸载完成，DSH 已恢复并启动。'} else {'安装完成。已打开 DSH，在会话右侧 + 中打开“编辑器”。'} } elseif($result) { $result.error } else { '安装未完成，请检查目录权限和 Node.js 环境。' }
        $script:worker.Dispose(); $script:worker=$null; $installButton.Enabled=$true; $removeButton.Enabled=$true
    }
})
$form.Add_FormClosing({ if ($script:worker -and -not $script:worker.HasExited) { $_.Cancel=$true; $status.Text='正在安装，请等待本次操作结束。' } })
[void]$form.ShowDialog(); $timer.Dispose(); $form.Dispose()
