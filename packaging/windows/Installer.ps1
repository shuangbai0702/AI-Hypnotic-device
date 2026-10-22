param(
    [switch]$Apply,
    [switch]$Discover,
    [switch]$NoDownload,
    [string]$NodePath,
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
. (Join-Path $PSScriptRoot 'Discovery.ps1')
. (Join-Path $PSScriptRoot 'Desktop.ps1')
if ($Discover) {
    try { $found=@(Find-DshCandidates -PreferredPort $Port); @{ok=$true;candidates=$found} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ResultFile -Encoding UTF8; exit 0 }
    catch { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8; exit 1 }
}

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

function Invoke-Install {
    if (-not $AppPath) {
        $found=@(Find-DshCandidates -PreferredPort $Port)
        $matching=@($found | Where-Object {$_.port -eq $Port -and $_.source -eq '正在运行'})
        $selected=if($matching.Count -eq 1){$matching[0]}elseif($found.Count -eq 1){$found[0]}else{$null}
        if(-not $selected){throw '自动检测到多个或未找到 DSH，请在安装界面选择检测结果。'}
        $script:AppPath=$selected.app
        if(-not $DshHome){$script:DshHome=$selected.home}
    }
    if (Test-DesktopApp $AppPath) { return Invoke-DesktopInstall }
    if (-not (Test-DshApp $AppPath)) { throw '未找到有效 DSH 程序目录，请重新自动检测或在高级选项选择目录。' }
    $script:AppPath = (Resolve-Path -LiteralPath $AppPath).Path
    if(-not $DshHome){$script:DshHome=if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path $env:USERPROFILE '.dsh'}}
    $script:DshHome = [IO.Path]::GetFullPath($DshHome)
    $listener = Get-Listener $Port
    if (-not $listener) {
        $probe=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,$Port)
        $probe.Server.ExclusiveAddressUse=$true
        try { $probe.Start() } catch { throw "端口 $Port 已占用且无法确认进程身份；未停止任何进程。" }
        finally { $probe.Stop() }
    }
    if ($listener) {
        $runningApp = Get-ProcessApp $listener
        if (-not $runningApp -or [IO.Path]::GetFullPath($runningApp).TrimEnd('\') -ne $AppPath.TrimEnd('\')) { throw "端口 $Port 被其他程序占用，未停止任何进程。" }
        if (-not (Test-StandardDshWebLaunch $listener $Port)) { throw '当前 DSH 使用自定义启动参数，请先手动关闭，再继续安装；未停止进程。' }
    }
    $preferred=if($NodePath){$NodePath}elseif($listener){$listener.ExecutablePath}else{''}
    $runtime=Find-NodeRuntime -App $AppPath -PreferredNode $preferred
    if(-not $runtime -and -not $NoDownload){$runtime=Get-VerifiedNode24}
    if(-not $runtime){throw '未找到通过能力检查的 Node 24 或更新版本，且未能下载专用运行时。'}
    $node=$runtime.path
    $installer = Join-Path $PackageRoot 'plugin/install.mjs'
    if ($Uninstall -and -not (Test-Path -LiteralPath (Join-Path $DshHome '.session-editor-install/install.json'))) { throw '该数据目录没有本扩展的安装记录。' }
    $pending=Join-Path $DshHome '.session-editor-transactions/pending.json'
    if(Test-Path -LiteralPath $pending){
        if($listener){throw '检测到中断的安装事务且 DSH 仍在运行，请先停止该目标服务后重试恢复。'}
        & $node $installer --app $AppPath --home $DshHome --recover
        if($LASTEXITCODE -ne 0){throw '中断事务恢复失败；保留备份，未继续安装。'}
    }
    $checkArgs=@($installer,'--app',$AppPath,'--home',$DshHome,'--check')
    if ($Uninstall) { $checkArgs+='--uninstall' }
    & $node @checkArgs
    if ($LASTEXITCODE -ne 0) { throw '安装/卸载预检失败；未停止服务或修改目标。' }
    $service=$null; $serviceIdentity=$null; $stopped=$false; $submitted=$false; $rolledBack=$false
    $previousHome=$env:DSH_HOME
    try {
        if ($listener) {
            $current = Get-Listener $Port
            if (-not $current -or $current.ProcessId -ne $listener.ProcessId -or $current.CreationDate -ne $listener.CreationDate) { throw '目标服务发生变化，请重试；未停止进程。' }
            Stop-Process -Id $listener.ProcessId -ErrorAction Stop
            Wait-Process -Id $listener.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
            $stopped=$true
        }
        $env:DSH_HOME = $DshHome
        New-Item -ItemType Directory -Force -Path $DshHome | Out-Null
        if (-not (Test-Path -LiteralPath (Join-Path $DshHome 'profiles/web/package.json')) -and -not $Uninstall) {
            & $node (Join-Path $AppPath 'lib/bin.js') --profile web --dump-config | Out-Null
            if ($LASTEXITCODE -ne 0) { throw '初始化 DSH web profile 失败。' }
        }
        $installArgs=@($installer,'--app',$AppPath,'--home',$DshHome)
        if($Uninstall){$installArgs+='--uninstall'}
        if(-not $NoStart){$installArgs+='--defer-health'}
        & $node @installArgs
        if($LASTEXITCODE -ne 0){throw '安装/卸载文件事务失败。'}
        $submitted=-not $NoStart
        $serviceId=$null; $verified=$false
        if(-not $NoStart){
            $logs=Join-Path $DshHome 'logs/session-editor-installer'
            New-Item -ItemType Directory -Force -Path $logs | Out-Null
            $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
            $out=Join-Path $logs "$stamp.stdout.log"; $err=Join-Path $logs "$stamp.stderr.log"
            $bin=Join-Path $AppPath 'lib/bin.js'
            $service=Start-Process -FilePath $node -ArgumentList @(('"'+$bin+'"'),'web','--port',"$Port",'--no-open') -WorkingDirectory $env:USERPROFILE -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
            $serviceIdentity=Get-CimInstance Win32_Process -Filter "ProcessId=$($service.Id)"
            $serviceId=$service.Id; $ready=$false
            for($i=0;$i -lt 100;$i++){
                if($service.HasExited){throw "DSH 启动失败，日志位于 $err"}
                try{$response=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 1;$ready=$response.StatusCode -eq 200}
                catch{if($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -in 401,403){$ready=$true}}
                if($ready){$owner=Get-Listener $Port;$ready=$owner -and $owner.ProcessId -eq $serviceId}
                if($ready){break};Start-Sleep -Milliseconds 200
            }
            if(-not $ready){throw 'DSH 启动超时'}
            $session=New-Object Microsoft.PowerShell.Commands.WebRequestSession
            $text=Get-Content -LiteralPath $out -Raw
            $tokenMatch=[regex]::Match($text,'http://127\.0\.0\.1:\d+/\?token=([A-Za-z0-9_%.-]+)')
            if($tokenMatch.Success){Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:$Port/?token="+$tokenMatch.Groups[1].Value) -WebSession $session -TimeoutSec 10 | Out-Null}
            $page=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -WebSession $session -TimeoutSec 10
            if($page.StatusCode -ne 200){throw '原生网页健康检查失败'}
            if(-not $Uninstall){
                $status=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/session-editor/status" -WebSession $session -TimeoutSec 10
                if(-not $status.ok){throw '插件未就绪'}
                foreach($key in @('connection','sessions','sessionPersistence','sessionQuery')){if($status.services.$key -ne 'ok'){throw "插件依赖未就绪：$key"}}
            }else{
                try{Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/session-editor/status" -WebSession $session -TimeoutSec 10 | Out-Null;throw '卸载后插件接口仍然可访问'}
                catch{if(-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 404){throw}}
            }
            & $node $installer --app $AppPath --home $DshHome --complete
            if($LASTEXITCODE -ne 0){throw '服务已启动但事务最终确认失败'}
            $submitted=$false; $verified=$true
            # Opening a browser is presentation after commit. Its failure must
            # never undo a healthy installation or restart another server.
            if(-not $NoBrowser){
                $url=if($tokenMatch.Success){$tokenMatch.Value}else{"http://127.0.0.1:$Port/"}
                try{Start-Process $url}catch{Write-Warning '安装成功，但未能自动打开浏览器。请手动打开所选端口的 DSH。'}
            }
        }
        return @{ok=$true;app=$AppPath;home=$DshHome;port=$Port;processId=$serviceId;uninstalled=[bool]$Uninstall;healthVerified=$verified;nodeVersion=$runtime.version}
    } catch {
        $failure=$_.Exception.Message; $rollbackFailure=$null
        if($submitted -or (Test-Path -LiteralPath $pending)){
            try{
                if($service -and -not $service.HasExited){
                    $currentService=Get-CimInstance Win32_Process -Filter "ProcessId=$($service.Id)"
                    if(-not $serviceIdentity -or -not $currentService -or $currentService.CreationDate -ne $serviceIdentity.CreationDate -or $currentService.CommandLine -ne $serviceIdentity.CommandLine){throw '进程身份已变化，拒绝停止其他进程'}
                    $owner=Get-Listener $Port
                    if($owner -and $owner.ProcessId -ne $service.Id){throw '端口拥有者已变化，拒绝停止其他进程'}
                    Stop-Process -Id $service.Id -ErrorAction Stop
                    Wait-Process -Id $service.Id -Timeout 15 -ErrorAction SilentlyContinue
                }
                & $node $installer --app $AppPath --home $DshHome --recover
                if($LASTEXITCODE -ne 0){throw '文件回滚失败，保留事务及备份'}
                $rolledBack=$true
            }catch{$rollbackFailure=$_.Exception.Message}
        }
        if($stopped -and -not $rollbackFailure){
            try{
                $restoreLog=Join-Path $DshHome 'logs/session-editor-installer'
                New-Item -ItemType Directory -Force -Path $restoreLog | Out-Null
                $bin=Join-Path $AppPath 'lib/bin.js'
                Start-Process -FilePath $listener.ExecutablePath -ArgumentList @(('"'+$bin+'"'),'web','--port',"$Port",'--no-open') -WorkingDirectory $env:USERPROFILE -WindowStyle Hidden -RedirectStandardOutput (Join-Path $restoreLog 'restored.stdout.log') -RedirectStandardError (Join-Path $restoreLog 'restored.stderr.log') | Out-Null
            }catch{$rollbackFailure='文件已回滚，但原服务重新启动失败'}
        }
        if($rollbackFailure){throw ($failure+'；'+$rollbackFailure)}
        if($rolledBack){throw ($failure+'；已回滚本次未完成的文件事务。')}
        throw $failure
    } finally {$env:DSH_HOME=$previousHome;if($service){$service.Dispose()}}
}

if ($Apply) {
    try { $result = Invoke-Install; $result = $result | Select-Object -Last 1; if ($ResultFile) { $result | ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8 }; exit 0 }
    catch { if ($ResultFile) { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8 }; exit 1 }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form=New-Object Windows.Forms.Form
$form.Text='AI Hypnotic device · 安装'; $form.Size=New-Object Drawing.Size(850,590); $form.StartPosition='CenterScreen'; $form.Font=New-Object Drawing.Font('Microsoft YaHei UI',10);$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false
function Add-Label($text,$x,$y,$width){$control=New-Object Windows.Forms.Label;$control.Text=$text;$control.SetBounds($x,$y,$width,30);$form.Controls.Add($control);return $control}
function Add-Field($text,$y){$control=New-Object Windows.Forms.TextBox;$control.Text=$text;$control.ReadOnly=$true;$control.SetBounds(125,$y,580,30);$form.Controls.Add($control);return $control}
[void](Add-Label '自动查找 DSH 和可用 Node，安装后继续使用原有模型和聊天。' 22 18 790)
$targets=New-Object Windows.Forms.ComboBox;$targets.DropDownStyle='DropDownList';$targets.SetBounds(22,60,680,32);$form.Controls.Add($targets)
$scanButton=New-Object Windows.Forms.Button;$scanButton.Text='重新检测';$scanButton.SetBounds(714,60,100,32);$form.Controls.Add($scanButton)
$hint=Add-Label '正在准备自动检测…' 22 100 790
$advanced=New-Object Windows.Forms.CheckBox;$advanced.Text='高级：手动选择目录或端口';$advanced.SetBounds(22,133,430,28);$form.Controls.Add($advanced)
[void](Add-Label 'DSH 程序' 22 180 100);$appBox=Add-Field $AppPath 176
[void](Add-Label 'DSH 数据' 22 230 100);$homeBox=Add-Field $DshHome 226
$browseButtons=@()
foreach($item in @(@($appBox,176),@($homeBox,226))){
    $button=New-Object Windows.Forms.Button;$button.Text='选择';$button.SetBounds(714,$item[1],100,30);$button.Tag=$item[0];$button.Enabled=$false
    $button.Add_Click({$dialog=New-Object Windows.Forms.FolderBrowserDialog;$dialog.SelectedPath=$this.Tag.Text;try{if($dialog.ShowDialog() -eq 'OK'){$this.Tag.Text=$dialog.SelectedPath}}finally{$dialog.Dispose()}});$form.Controls.Add($button);$browseButtons+=$button
}
[void](Add-Label '网页端口' 22 280 100);$portBox=Add-Field "$Port" 276;$portBox.Width=100
[void](Add-Label '数据目录会自动推测，请核对它属于你要安装的 DSH。' 22 321 790)
[void](Add-Label '复用可用 Node；找不到时下载校验过的专用 Node 24，不修改全局环境。' 22 351 790)
$installButton=New-Object Windows.Forms.Button;$installButton.Text='安装并启动';$installButton.SetBounds(125,398,220,40);$installButton.Enabled=$false;$form.Controls.Add($installButton)
$removeButton=New-Object Windows.Forms.Button;$removeButton.Text='卸载并恢复';$removeButton.SetBounds(370,398,220,40);$removeButton.Enabled=$false;$form.Controls.Add($removeButton)
$status=New-Object Windows.Forms.Label;$status.SetBounds(22,457,790,70);$form.Controls.Add($status)
$timer=New-Object Windows.Forms.Timer;$timer.Interval=250
$script:worker=$null;$script:workerResult=$null;$script:workerKind='';$script:detected=@()
function Update-Controls {
    $busy=$null -ne $script:worker
    $desktopTarget=Test-DesktopApp $appBox.Text
    $canInstall=-not $busy -and ($advanced.Checked -or $targets.SelectedIndex -ge 0) -and $appBox.Text -and $homeBox.Text
    $installButton.Enabled=[bool]$canInstall;$removeButton.Enabled=[bool]$canInstall;$scanButton.Enabled=-not $busy;$targets.Enabled=-not $busy;$advanced.Enabled=-not $busy
    $appBox.ReadOnly=$busy -or -not $advanced.Checked;$homeBox.ReadOnly=$busy -or -not $advanced.Checked;$portBox.ReadOnly=$busy -or -not $advanced.Checked;$portBox.Enabled=-not $desktopTarget
    foreach($button in $browseButtons){$button.Enabled=$advanced.Checked -and -not $busy}
}
function Start-Background([string]$Kind,[string[]]$Extra) {
    if($script:worker){return}
    $script:workerResult=Join-Path ([IO.Path]::GetTempPath()) ('dsh-installer-'+[guid]::NewGuid().ToString()+'.json')
    $arguments=@('-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-ResultFile',('"'+$script:workerResult+'"'))+$Extra
    $shell=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/powershell.exe'
    $script:worker=Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $script:workerKind=$Kind;Update-Controls;$status.Text=if($Kind -eq 'discovery'){'正在从运行进程、PATH、npm/npx 缓存与版本管理器自动查找…'}else{'正在检测运行时、预检、备份、安装及验证，请稍候…'};$timer.Start()
}
function Start-Discovery {Start-Background 'discovery' @('-Discover','-Port',"$Port")}
function Start-InstallWorker([bool]$Remove) {
    $parsedPort=0
    if(-not [int]::TryParse($portBox.Text,[ref]$parsedPort) -or $parsedPort -lt 1024 -or $parsedPort -gt 65535){$status.Text='端口无效。';return}
    $arguments=@('-Apply','-AppPath',('"'+$appBox.Text.TrimEnd('\')+'"'),'-DshHome',('"'+$homeBox.Text.TrimEnd('\')+'"'),'-Port',"$parsedPort")
    if($Remove){$arguments+='-Uninstall'};if($NoDownload){$arguments+='-NoDownload'};if($NodePath){$arguments+=@('-NodePath',('"'+$NodePath+'"'))}
    Start-Background 'install' $arguments
}
$targets.Add_SelectedIndexChanged({
    if($targets.SelectedIndex -ge 0 -and $targets.SelectedIndex -lt $script:detected.Count){
        $choice=$script:detected[$targets.SelectedIndex];$appBox.Text=$choice.app;$homeBox.Text=$choice.home;$portBox.Text=[string]$choice.port
        $hint.Text=if($choice.profile -eq 'desktop'){'已识别桌面端；请先完全退出。端口由桌面自动分配，下方网页端口不适用。'}else{'已识别 DSH '+$choice.version+'；核对目标后点击安装。'}
    };Update-Controls
})
$advanced.Add_CheckedChanged({Update-Controls})
$appBox.Add_TextChanged({Update-Controls});$homeBox.Add_TextChanged({Update-Controls})
$scanButton.Add_Click({Start-Discovery});$installButton.Add_Click({Start-InstallWorker $false});$removeButton.Add_Click({Start-InstallWorker $true})
$timer.Add_Tick({
    if($script:worker -and $script:worker.HasExited){
        $timer.Stop();$result=$null
        try{if(Test-Path -LiteralPath $script:workerResult){$result=Get-Content -LiteralPath $script:workerResult -Raw | ConvertFrom-Json;Remove-Item -LiteralPath $script:workerResult}}
        catch{$status.Text='无法读取检测结果，请重试。'}
        $kind=$script:workerKind;$script:worker.Dispose();$script:worker=$null
        if($kind -eq 'discovery'){
            $targets.Items.Clear();$script:detected=@()
            if($result -and $result.ok){
                $script:detected=@($result.candidates)
                foreach($candidate in $script:detected){[void]$targets.Items.Add($candidate.label)}
                if($script:detected.Count -eq 1){$targets.SelectedIndex=0;$status.Text='自动检测完成。'}
                elseif($script:detected.Count -gt 1){$hint.Text='发现多个 DSH，请从上方列表选择目标。';$status.Text='不会自动修改其他 DSH。'}
                else{$hint.Text='未找到 DSH，可重新检测或展开高级选项。';$status.Text='已自动重试。请确认 DSH 已安装或正在运行。'}
            }else{$status.Text=if($result){$result.error}else{'自动检测未完成，请重试。'}}
        }else{
            $status.Text=if($result -and $result.ok){if($result.profile -eq 'desktop'){if($result.windowStart -in @('exited-before-verification','launch-failed')){'桌面文件和 Host 验证成功，但窗口启动失败；不能判定整体可用。'}elseif($result.uninstalled){'桌面卸载及 Host 验证完成；窗口仍需另行核对。'}else{'桌面安装及 Host 验证完成；窗口仍需另行核对。'}}elseif($result.uninstalled){'卸载和网页健康验证完成。'}else{'安装和插件健康验证完成。已打开 DSH，在会话右侧 + 中打开编辑器。'}}elseif($result){$result.error}else{'安装未完成，未收到结果。请检查日志和待恢复事务。'}
        };Update-Controls
    }
})
$form.Add_Shown({Start-Discovery})
$form.Add_FormClosing({if($script:worker -and -not $script:worker.HasExited){$_.Cancel=$true;$status.Text='正在检测或安装，请等待当前操作结束。'}})
[void]$form.ShowDialog();$timer.Dispose();$form.Dispose()
