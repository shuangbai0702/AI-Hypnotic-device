#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, renameSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planAdapter } from "./host-adapter.mjs";

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
if (!option("--app") || !option("--home")) {
  console.error("用法: dsh-session-editor-install --app <DSH程序目录> --home <DSH_HOME> [--uninstall]\n请先停止目标 DSH 服务；支持 DSH 0.2.0-rc.2 当前构建。");
  process.exit(1);
}
const app = resolve(option("--app")), home = resolve(option("--home"));
const profile = join(home, "profiles", "web");
const target = join(profile, "node_modules", "@shuangbai", "dsh-session-editor");
const config = join(profile, "cordis.patch.yml");
const state = join(home, ".session-editor-install");
const manifestFile = join(state, "install.json");
const self = dirname(fileURLToPath(import.meta.url));

if (args.includes("--uninstall")) {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const restoreHost = planAdapter(app, true);
  const currentConfig = readFileSync(config, "utf8");
  if (currentConfig !== manifest.configAfter) throw new Error("安装后配置有其他修改，请先手动移除 session-editor 配置；未执行卸载");
  if (args.includes("--check")) { console.log("卸载预检通过；未修改文件。"); process.exit(0); }
  restoreHost();
  // Archive instead of deleting; preserve any local edits to the installed package.
  renameSync(target, join(state, `uninstalled-${Date.now()}`));
  if (manifest.hadPlugin) cpSync(join(state, "previous-plugin"), target, { recursive: true });
  writeFileSync(config, manifest.configBefore);
  console.log("已恢复宿主、配置和原有插件；卸载的包保存在安装备份目录。请重启 DSH。");
} else {
  const applyHost = planAdapter(app);
  if (resolve(target) === resolve(self)) throw new Error("请从发布包目录运行安装器，不要在目标安装目录中覆盖自身");
  if (args.includes("--check")) { console.log("DSH 构建兼容，安装预检通过；未修改文件。"); process.exit(0); }
  const before = existsSync(config) ? readFileSync(config, "utf8") : "";
  const after = before.includes('@shuangbai/dsh-session-editor') ? before : before + '\n- insert:\n    - id: session-editor\n      name: "@shuangbai/dsh-session-editor"\n      config: {}\n';
  mkdirSync(state, { recursive: true });
  if (!existsSync(manifestFile)) {
    const hadPlugin = existsSync(target);
    if (hadPlugin) cpSync(target, join(state, "previous-plugin"), { recursive: true });
    writeFileSync(manifestFile, JSON.stringify({ app, configBefore: before, configAfter: after, hadPlugin }, null, 2));
  }
  applyHost();
  mkdirSync(target, { recursive: true });
  for (const name of ["lib", "package.json", "README.md", "AGENT.md", "install.mjs", "host-adapter.mjs"]) {
    // Preserve the user's independently editable assistant instructions on upgrades.
    if (name === "AGENT.md" && existsSync(join(target, name))) continue;
    cpSync(join(self, name), join(target, name), { recursive: true });
  }
  // Resolve dependencies from the selected DSH without development junctions.
  writeFileSync(join(target, "host.json"), JSON.stringify({ app }, null, 2));
  writeFileSync(config, after);
  console.log("会话编辑器已安装（含宿主生命周期适配和备份）。请重启 DSH，在会话右侧 + 中打开“编辑器”。");
}
