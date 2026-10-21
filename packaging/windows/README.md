# 双白 DSH 安装器

完整解压后，双击 **双白DSH安装器.exe**。保留同目录的 `source`、`plugin` 文件夹。

安装器自动查找正在使用默认3080端口的DSH，或PATH/标准npm安装目录中的正式DSH。核对“DSH程序”和“DSH数据”目录，点击“安装并启动”。默认网页端口为3080。数据目录优先使用DSH_HOME，未设置时使用当前用户的`.dsh`；如果原服务使用自定义DSH_HOME，请选择同一个目录。

安装会短暂重启所选DSH，请先停止正在进行的生成/任务。端口属于其他程序、DSH使用自定义启动参数或构建不兼容时拒绝自动处理。自定义启动命令请先手动关闭，安装完成后继续使用原命令。

完成后在DSH会话右侧 **+ → 编辑器** 中使用有效上下文编辑、生效摘要、局部压缩、记忆工作台和记忆助手。原有模型、API密钥和聊天不复制、不替换。记忆助手提示可直接修改安装目录内的AGENT.md，重新安装时保留现有提示文件。

“卸载并恢复”恢复适配前的宿主及安装前配置，插件归档保留。宿主或配置后来有其他修改时拒绝覆盖。会话编辑不会随卸载撤销，对应日志备份仍在DSH_HOME/backups。

支持本次适配的 **DSH 0.2.0-rc.2 构建**（安装前逐文件校验）；Node需要支持zstd，建议Node24。EXE使用Windows自带.NET Framework和Windows PowerShell，不需要另外安装.NET SDK。源码公开放在source/及plugin/，EXE仅启动安装脚本。安装包无需携带DSH或用户数据，也无需联网安装依赖。启动日志位于DSH_HOME/logs/session-editor-installer，其中可能含本机网页登录链接，请勿公开。

自动化参数（常规使用直接双击即可）：

```powershell
.\双白DSH安装器.exe -Apply -AppPath "C:\path\to\dsh" -DshHome "C:\path\to\dsh-home" -Port 3080 -ResultFile "C:\path\to\result.json"
```

可加 `-Uninstall` 卸载，`-NoStart` 仅安装/卸载，`-NoBrowser` 启动后不打开浏览器。结果JSON不包含密钥或登录token。

源码仓库中运行 `packaging/windows/Build.ps1` 可重新编译；解压包中运行 `source/Build.ps1` 会在旁边生成 `-rebuilt` 目录。无需混淆或单文件封装。
