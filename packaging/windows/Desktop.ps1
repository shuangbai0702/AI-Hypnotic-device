function Test-DesktopApp([string]$Directory) {
    try {
    if(-not $Directory -or -not (Test-Path -LiteralPath (Join-Path $Directory 'DeepSeek Harness.exe') -PathType Leaf)){return $false}
    $recoveryHome=if($DshHome){$DshHome}elseif($env:DSH_HOME){$env:DSH_HOME}else{Join-Path $env:USERPROFILE '.dsh'}
    return (Test-Path -LiteralPath (Join-Path $Directory 'resources/app.asar') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $recoveryHome '.session-editor-transactions-desktop/pending.json'))
    } catch { return $false }
}
function Start-SelectedDesktopWindow([string]$Executable,[string]$HomeDirectory) {
    $previousHome=$env:DSH_HOME
    try {
        $env:DSH_HOME=$HomeDirectory
        return Start-Process -FilePath $Executable -WindowStyle Normal -PassThru
    } finally {$env:DSH_HOME=$previousHome}
}
function Invoke-DesktopInstall {
    $script:AppPath=(Resolve-Path -LiteralPath $AppPath).Path
    if(-not $DshHome){$script:DshHome=if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path $env:USERPROFILE '.dsh'}}
    $script:DshHome=[IO.Path]::GetFullPath($DshHome)
    # Never stop an Electron process or disturb tasks in an open desktop.
    $desktopExe=Join-Path $AppPath 'DeepSeek Harness.exe'
    $filter="ExecutablePath = '"+$desktopExe.Replace('\','\\').Replace("'","\'")+"'"
    if(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop){throw '请先完全退出所选 DSH 桌面端再安装；未停止任何进程。'}
    $runtime=Find-NodeRuntime -App $AppPath -PreferredNode $NodePath
    if(-not $runtime -and -not $NoDownload){$runtime=Get-VerifiedNode24}
    if(-not $runtime){throw '未找到支持的 Node，桌面文件尚未修改。'}
    $node=$runtime.path;$installer=Join-Path $PackageRoot 'plugin/install.mjs'
    $pending=Join-Path $DshHome '.session-editor-transactions-desktop/pending.json'
    if(Test-Path -LiteralPath $pending){& $node $installer --app $AppPath --home $DshHome --recover;if($LASTEXITCODE -ne 0){throw '桌面中断事务恢复失败'}}
    $arguments=@($installer,'--app',$AppPath,'--home',$DshHome)
    if($Uninstall){$arguments+='--uninstall'}
    & $node @arguments --check
    if($LASTEXITCODE -ne 0){throw '桌面安装预检失败；未修改文件。'}
    $submitted=$false
    try {
        & $node @arguments --defer-health
        if($LASTEXITCODE -ne 0){throw '桌面文件事务失败。'}
        $submitted=$true
        $verified=$false
        if(-not $NoStart){
            $mode=if($Uninstall){'uninstalled'}else{'installed'}
            & $node (Join-Path $PackageRoot 'plugin/lib/desktop-health.mjs') $AppPath $DshHome $mode
            if($LASTEXITCODE -ne 0){throw '桌面 Host 健康验证失败；原生日志位于数据目录 logs/session-editor-installer。'}
            $verified=$true
        }
        & $node $installer --app $AppPath --home $DshHome --complete
        if($LASTEXITCODE -ne 0){throw '桌面安装事务最终确认失败。'}
        $submitted=$false
        # Native window startup is deliberately separate from Host readiness.
        # Starting the selected desktop normally preserves its original userData.
        $windowStart='not-requested'
        if(-not $NoStart -and -not $NoBrowser){
            try {
                $window=Start-SelectedDesktopWindow $desktopExe $DshHome
                try{$windowStart=if($window.WaitForExit(1200)){'exited-before-verification'}else{'started-unverified'}}finally{$window.Dispose()}
            }catch{$windowStart='launch-failed'}
        }
        return @{ok=$true;app=$AppPath;home=$DshHome;profile='desktop';uninstalled=[bool]$Uninstall;healthVerified=$verified;healthScope='desktop-host';windowVerified=$false;windowStart=$windowStart;nodeVersion=$runtime.version}
    }catch{
        $failure=$_.Exception.Message
        if($submitted){& $node $installer --app $AppPath --home $DshHome --recover;if($LASTEXITCODE -ne 0){throw ($failure+'；回滚失败，保留事务与备份。')};throw ($failure+'；已回滚本次桌面文件事务。')}
        throw
    }
}
