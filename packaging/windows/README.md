# AI Hypnotic device 安装器

完整解压后，双击 **双白DSH安装器.exe**。保留同目录的 `source`、`plugin` 文件夹。

默认自动查找运行中的 DSH、PATH、npm/pnpm、npx 缓存及常见 Node 版本管理器；未找到会有界重试，找到多个时让用户选择。手动目录是高级兜底选项。默认网页端口为3080，运行中服务的端口会随目标识别。数据目录优先使用上次安装记录，否则推测 DSH_HOME 或当前用户的 `.dsh`；自定义目录仍须核对。

安装会短暂重启所选DSH，请先停止正在进行的生成/任务。端口属于其他程序、DSH使用自定义启动参数或构建不兼容时拒绝自动处理。自定义启动命令请先手动关闭，安装完成后继续使用原命令。

完成后在DSH会话右侧 **+ → 编辑器** 中使用有效上下文编辑、生效摘要、局部压缩、记忆工作台和记忆助手。原有模型、API密钥和聊天不复制、不替换。记忆助手提示可直接修改安装目录内的AGENT.md，重新安装时保留现有提示文件。

“卸载并恢复”恢复适配前的宿主及安装前配置，插件归档保留。宿主或配置后来有其他修改时拒绝覆盖。会话编辑不会随卸载撤销，对应日志备份仍在DSH_HOME/backups。

本轮源码提供五个官方构建的适配：0.1.7-rc.2、0.2.0-rc.1、0.2.0-rc.2、0.2.1-rc.1、0.2.1-rc.2，仍逐文件校验 SHA256，未知构建拒绝写入。具体实测层级以仓库可靠性验证为准。

Node 需要 24 或更新版本并通过能力检查。优先复用目标 DSH 的 Node，再查找程序旁的运行时、PATH、版本管理器及专用缓存；没有可用版本时自动下载官方 Node 24 并校验 SHA256，不改全局 PATH。安装包无需携带 DSH 或用户数据；运行时兜底下载需要联网。EXE 使用 Windows 自带 .NET Framework 和 Windows PowerShell，不需要 .NET SDK。源码公开放在 source/ 及 plugin/，EXE 仅启动安装脚本。

安装采用持久事务：准备、备份、替换、原生网页及插件健康验证，全部成功后才完成。失败自动回滚；中断事务须先停止目标服务再恢复，回滚冲突会保留备份并拒绝覆盖。重装保留现有 AGENT.md。启动日志位于 DSH_HOME/logs/session-editor-installer，其中可能含本机网页登录链接，请勿公开。

自动化参数（常规使用直接双击即可）：

```powershell
.\双白DSH安装器.exe -Apply -AppPath "C:\path\to\dsh" -DshHome "C:\path\to\dsh-home" -Port 3080 -ResultFile "C:\path\to\result.json"
```

可加 `-Uninstall` 卸载，`-NoStart` 仅提交文件（结果会明确 healthVerified=false），`-NoBrowser` 启动后不打开浏览器，`-NoDownload` 禁止兜底下载，`-NodePath` 指定优先验证的运行时。`-Discover -ResultFile ...` 只读输出自动检测结果。结果 JSON 不包含密钥或登录 token，但包含本机目录，分享前仍需脱敏。

源码仓库中运行 `packaging/windows/Build.ps1` 可重新编译；解压包中运行 `source/Build.ps1` 会在旁边生成 `-rebuilt` 目录。无需混淆或单文件封装。
