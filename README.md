# AI Hypnotic device

在 DeepSeek Harness（DSH）网页中编辑有效上下文、旧助手回复和生效摘要，用局部压缩整理记忆，并通过独立记忆助手辅助修改。

这是现有 DSH 的扩展。安装后继续使用你自己的 DSH、模型配置和聊天数据。

**0.3.2 修复“移出上下文后续聊”导致轮次错误的问题，以及保存后连续操作的版本冲突。0.3.1 不建议用于正式会话。** 已在本地网页完成真实模型验证；原五版本测试没有覆盖移出之后继续请求模型，本次新增验证与边界见 [可靠性验证](docs/RELIABILITY-VALIDATION.md)。

## 安装使用

1. 从本仓库 [Releases](https://github.com/shuangbai0702/AI-Hypnotic-device/releases/latest) 下载 Windows 安装包 ZIP，**完整解压**。
2. 双击 `双白DSH安装器.exe`，保留同目录的 `source/` 和 `plugin/`。
3. 核对自动识别的 **DSH 程序目录、DSH 数据目录及端口**，点击“安装并启动”。默认端口为 `3080`；自定义数据目录请选原服务使用的 `DSH_HOME`。
4. 在 DSH 网页会话右侧打开 **+ → 编辑器**。

安装器默认从运行进程、PATH、npm/pnpm、npx 缓存及常见版本管理器查找 DSH，并在未找到时有界重试；有多个候选时由你选择，不会批量安装。手动填写目录放在高级选项。已安装目标优先复用上次确认的数据目录，其他自定义 `DSH_HOME` 仍需核对。

安装会短暂重启所选服务，请先结束正在进行的生成和任务。遇到其他程序占用端口、无法识别的启动参数或不兼容构建时，安装器拒绝自动处理。使用自定义启动命令的用户应先手动停止服务，安装后继续使用原命令。

源码增加了 DSH `0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-rc.1`、`0.2.1-rc.2` 官方构建的适配。安装器仍逐文件校验宿主 SHA256 和唯一结构锚点；同版本重新构建也可能拒绝。各版本的实测层级见验证说明，不宣称支持全部 DSH。

运行时要求 Node.js 24 或更新版本通过能力检查，当前实测为 24.16.0 和 24.22.1。优先复用目标 DSH 正在使用的 Node，再找随程序放置的运行时、PATH 和版本管理器；找不到时从 Node 官方下载专用 Node 24、核对 SHA256，缓存于本机用户目录，不修改全局 PATH。首次下载需要联网。npm 分发的 DSH 通常依赖已安装的 Node，并不随包附带 Node，可参考 [DSH 官方运行说明](https://github.com/deepseek-ai/deepseek-harness#run)。

## 能做什么

| 入口 | 用途 |
| --- | --- |
| 有效上下文 | 搜索、编辑仍然有效的消息及助手逐块思考，预览修改后保存；同步左侧聊天 |
| 生效摘要 | 修改当前摘要，保留 DSH 原生压缩事务关系 |
| 记忆工作台 | 局部压缩、候选前后对比、工具结果裁剪、原件检索及候选快照字段恢复 |
| 移出上下文 | 消息退出后续上下文，保留原始聊天记录 |
| 记忆助手 | 独立 DSH 会话，只提供固定目标会话的 9 个记忆工具 |
| 更多工具 | 查看覆盖关系、原始事件及手动同步 |

**已压缩的归档原文只读，承接它的生效摘要仍可编辑。** 修改摘要不会自动修改其他仍有效的旧回复。如果旧正文或思考仍与摘要矛盾，可继续编辑这些回复，或将整条消息移出上下文。思考是否回传由 DSH 的模型适配器决定。

编辑框支持 `Ctrl+Enter` 保存和 `Esc` 取消。保存前可检查正文与思考的变化；版本冲突时拒绝覆盖并保留草稿。其他已打开的标签页需要同步或刷新。

记忆助手的独立提示词在安装后的插件根目录 [`AGENT.md`](plugins/dsh-session-editor/AGENT.md)。可自行修改；重新安装保留现有文件。重新打开助手会重新读取提示词。助手复用你配置的模型，调用模型仍可能产生费用。

## 安装如何改动 DSH

安装器复制插件并注册 web profile，同时适配三处宿主构建文件：`dsh-agent`、`dsh-agent-loop`、`dsh-api-session-controller`。这些适配让编辑器通过原生命周期 Owner 释放空闲会话，并在重开后恢复聊天状态。它不是完全零宿主修改的插件；DSH 升级后需重新检查兼容性。

编辑前检查生成状态和内容版本，取得独占写租约，校验完整日志，备份后原子替换。生成中或仍持有子任务的会话拒绝编辑。安装前仍建议自行备份重要数据。

安装先在临时目录准备和验证 YAML、宿主适配及插件，再备份和提交；网页和插件服务健康通过后才确认成功。失败自动回滚；进程中断留下持久事务，下次安装可在目标服务停止后恢复。未知的后续文件修改会阻止自动回滚并保留备份。同一程序目录同时只能绑定一个安装数据目录。

安装器的“卸载并恢复”恢复安装前宿主及配置，卸下的插件保存在事务备份中；若宿主或配置后来又有修改，会拒绝覆盖。**卸载不会撤销已经完成的会话内容编辑**，对应备份保存在 `DSH_HOME/backups/`。旧 `log-rewrite.mjs` 现在仅允许 `inspect` 只读诊断，停止提供绕过原生写租约的物理修改及贪婪修复命令。

“已登录 DeepSeek，账号资料暂不可用”是 DSH 原生账号界面的状态：凭据已存储，但资料请求未得到可用结果。仅凭这行文字不能判断凭据损坏或归因于插件。安装事务不修改凭据文件；不要据此直接删除账号文件。应结合账号接口结果和服务日志定位。

## 从源码构建

Windows 自带的 .NET Framework C# 编译器生成 EXE 入口；入口调用 Windows PowerShell 安装脚本。无需 .NET SDK，也不打包整套 DSH。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/windows/Build.ps1
```

输出位于 `dist/`，完整目录包含 EXE、公开源码、插件和文件散列清单。EXE 不能脱离其余文件单独使用。详细参数见 [安装器说明](packaging/windows/README.md)，插件的命令行安装和卸载见 [插件说明](plugins/dsh-session-editor/README.md)。

## 开发与验证

测试依赖兼容 DSH 的原生模块，仓库不复制 DSH 源码和依赖。在一个新的源码检出目录中，将 `app/` 指向本机 DSH 程序目录，将插件的依赖目录指向该 DSH 的 `node_modules/`。以下示例对应标准 npm 安装位置，路径不同时请先调整变量；已有目录时不要覆盖：

```powershell
$dshApp = Join-Path $env:APPDATA 'npm/node_modules/@deepseek-ai/dsh'
New-Item -ItemType Junction -Path app -Target $dshApp
New-Item -ItemType Junction -Path plugins/dsh-session-editor/node_modules -Target (Join-Path $dshApp 'node_modules')
npm test
```

回归测试使用合成消息、临时目录及本机 mock HTTP 服务，不需要真实 API 密钥。安装回归只改动自己的临时宿主文件副本，不在所链接 DSH 上安装或启动插件。不要把会修改会话的手工实验指向正式数据。

上面的链接示例要求宿主自己的 `node_modules` 存在。若 npm 将依赖提升到上级，请在独立测试目录建立测试用 `app` 容器，将它的 `node_modules` 指向实际依赖根，并提供对应 `package.json` 和适配备份；不要通过已有的 `app` 链接向原 DSH 内添加测试文件。安装器本身使用宿主模块解析，支持提升布局。

可用 `tests/windows-discovery.ps1 -NodePath ...` 测试只读发现。`tests/windows-installation-e2e.ps1 -NodePath ... -InstallerRoot ...` 会创建新的隔离 DSH，逐版本执行 EXE 安装、模型请求、卸载及重装；只使用显式指定的测试端口，禁止 3080/3099。`native-session-e2e.mjs` 还需显式设置 `EDITOR_TEST_DISPOSABLE=yes`、`EDITOR_TEST_APP/HOME/PORT`，仅允许在可丢弃副本上运行。它使用本地模型服务，临时改写并最终恢复测试 profile。

提交前执行 `npm run check:release`，检查暂存区的文件白名单和常见敏感信息。当前验证覆盖及未验收项见 [验证说明](docs/VALIDATION.md)。

## 仓库内容

- `plugins/dsh-session-editor/`：插件、提示词及宿主适配器。
- `packaging/windows/`：安装界面、EXE 入口及构建脚本。
- `tests/`：使用合成数据的回归测试。
- `scripts/check-release.mjs`：发布文件与敏感内容检查。

仓库不包含聊天记录、DSH 数据目录、密钥、浏览器配置、请求抓包或本机依赖。安装时生成的 `host.json` 只存在于目标机器，受 Git 忽略规则保护。
