# 双白 DSH · 会话记忆编辑器

在 DeepSeek Harness（DSH）网页中编辑有效上下文、旧助手回复和生效摘要，用局部压缩整理记忆，并通过独立记忆助手辅助修改。

这是现有 DSH 的扩展。安装后继续使用你自己的 DSH、模型配置和聊天数据。

## 安装使用

1. 从本仓库 [Releases](https://github.com/shuangbai0702/shuangbai-dsh/releases/latest) 下载 Windows 安装包 ZIP，**完整解压**。
2. 双击 `双白DSH安装器.exe`，保留同目录的 `source/` 和 `plugin/`。
3. 核对自动识别的 **DSH 程序目录、DSH 数据目录及端口**，点击“安装并启动”。默认端口为 `3080`；自定义数据目录请选原服务使用的 `DSH_HOME`。
4. 在 DSH 网页会话右侧打开 **+ → 编辑器**。

安装器查找所选端口正在运行的 DSH，也会查找 PATH 和标准 npm 安装位置。安装会短暂重启所选服务，请先结束正在进行的生成和任务。遇到其他程序占用端口、无法识别的启动参数或不兼容构建时，安装器拒绝自动处理。使用自定义启动命令的用户应先手动停止服务，安装后继续使用原命令。

**兼容范围：Windows、Node.js 24，以及适配过的 DSH `0.2.0-rc.2` 构建。** 安装器逐文件校验宿主 SHA256；即使版本号相同，构建不同也可能拒绝安装。目前没有宣称兼容所有 DSH 版本。

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

安装器的“卸载并恢复”恢复安装前宿主及配置，归档卸下的插件；若宿主或配置后来又有修改，会拒绝覆盖。**卸载不会撤销已经完成的会话内容编辑**，对应备份保存在 `DSH_HOME/backups/`。

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

提交前执行 `npm run check:release`，检查暂存区的文件白名单和常见敏感信息。当前验证覆盖及未验收项见 [验证说明](docs/VALIDATION.md)。

## 仓库内容

- `plugins/dsh-session-editor/`：插件、提示词及宿主适配器。
- `packaging/windows/`：安装界面、EXE 入口及构建脚本。
- `tests/`：使用合成数据的回归测试。
- `scripts/check-release.mjs`：发布文件与敏感内容检查。

仓库不包含聊天记录、DSH 数据目录、密钥、浏览器配置、请求抓包或本机依赖。安装时生成的 `host.json` 只存在于目标机器，受 Git 忽略规则保护。
