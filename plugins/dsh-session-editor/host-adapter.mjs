import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export function resolveHostFile(app, relative) {
  const match = /^node_modules\/@deepseek-ai\/(dsh-agent|dsh-agent-loop|dsh-api-session-controller)\/lib\/(index|client)\.js$/.exec(relative);
  if (!match) throw new Error('未授权的宿主文件路径');
  const legacy = join(app, relative);
  if (existsSync(legacy)) return legacy;
  const entry = createRequire(join(app, 'package.json')).resolve('@deepseek-ai/' + match[1]);
  return join(dirname(entry), match[2] + '.js');
}

const hash = (s) => createHash("sha256").update(s).digest("hex");
function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error("DSH 接口结构不兼容，未应用适配");
  return text.replace(before, after);
}

export function planAdapter(app, restore = false, { readFile = readFileSync, exists = existsSync, resolveFile = resolveHostFile } = {}) {
  const backup = join(app, ".session-editor-adapter");
  const manifestPath = join(backup, "manifest.json");
  const previous = exists(manifestPath) ? JSON.parse(readFile(manifestPath, "utf8")) : [];
  if (!Array.isArray(previous) || previous.some(entry => !/^[a-f0-9]{64}$/.test(entry.original) || !/^[a-f0-9]{64}$/.test(entry.patched))) throw new Error('宿主适配备份清单无效');
  if (restore && previous.length) {
    const changes = previous.map((m) => {
      const file = resolveFile(app, m.path);
      const current = readFile(file, "utf8");
      if (hash(current) !== m.patched && hash(current) !== m.original) throw new Error(`宿主已有其他修改，拒绝覆盖: ${m.path}`);
      const after = readFile(join(backup, m.original), "utf8");
      if (hash(after) !== m.original) throw new Error(`宿主原件备份校验失败: ${m.path}`);
      return { file, path: m.path, before: current, after };
    });
    return () => { for (const c of changes) writeFileSync(c.file, c.after); };
  }
  if (restore) throw new Error("没有宿主适配备份");
  const specs = [
    { pkg: "dsh-agent", original: ["7b9aa39474de83115cf890dd7f8904cf0d59df0811cb335ab85565a04f1aac93", "7b59cf82c2784c25bdce4e3e24e5e5303b02b9f1003efacf50255492d17baf8b"], patch: (s) => replaceOnce(s,
      '\tget(id) {\n\t\treturn this.store.get(id)?.agent;\n\t}',
      '\tget(id) {\n\t\treturn this.store.get(id)?.agent;\n\t}\n\t/** Session editor adapter: release through the original lifecycle owner. */\n\tasync releaseIdle(id) {\n\t\tconst agent = this.get(id);\n\t\tif (agent === void 0) return false;\n\t\tconst { target } = this.requireFactory();\n\t\tif (typeof target.releaseIdle !== "function") throw new Error("agent factory does not support idle release");\n\t\treturn target.releaseIdle(agent);\n\t}') },
    { pkg: "dsh-agent-loop", original: ["00c4814d63f3d1e2754eb09144832d19b30499d6ea444730473f740b587948c2", "459deb380d431f98a9250d77b05a77268eda51f096b07be65080097a1683ffda", "cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033"], patch: (s) => {
      s = replaceOnce(s, '\truntime;\n\tconstructor(ctx, config) {', '\truntime;\n\teditorHandles = new WeakMap();\n\tasync releaseIdle(agent) {\n\t\tconst dispose = this.editorHandles.get(agent);\n\t\tif (!dispose || this.runtime.ctx.agents.get(agent.id) !== agent) throw new Error("agent lifecycle is not available");\n\t\tif (agent.status === "running") throw new Error("会话正在生成，请先停止生成");\n\t\tif (this.runtime.ctx.agents.list().some((child) => this.runtime.ctx.agents.isOwnedBy(child.id, agent))) throw new Error("会话仍持有子任务，请等待子任务结束");\n\t\tawait dispose();\n\t\treturn true;\n\t}\n\tconstructor(ctx, config) {');
      s = s.includes('\t\t\t\tif (!ownerTriggered)')
        ? replaceOnce(s, '\t\t\t\tuntrack();\n\t\t\t\tif (!ownerTriggered)', '\t\t\t\tif (machine) this.editorHandles.delete(machine);\n\t\t\t\tuntrack();\n\t\t\t\tif (!ownerTriggered)')
        : replaceOnce(s, '\t\t\t\tuntrack();\n\t\t\t}\n\t\t\tthrowCollectedFailures', '\t\t\t\tif (machine) this.editorHandles.delete(machine);\n\t\t\t\tuntrack();\n\t\t\t}\n\t\t\tthrowCollectedFailures');
      return replaceOnce(s, '\t\t\t\t\t\treturn {\n\t\t\t\t\t\t\tagent,\n\t\t\t\t\t\t\tdispose', '\t\t\t\t\t\tthis.editorHandles.set(agent, dispose);\n\t\t\t\t\t\treturn {\n\t\t\t\t\t\t\tagent,\n\t\t\t\t\t\t\tdispose');
    } },
    { pkg: "dsh-api-session-controller", file: "client.js", original: ["60ec6a006443b40e5ab718f3fa53c301559c5c28427ca650c3851127ce370d43", "301b3a1aa6391b2992ed05a036908c164ff990615afd744e1e310d3cfb5173f7", "82f2301c18f0e51340c1eedf8ecdfb939e873b3770a80632e438b86e82887d0e"], patch: (s) => replaceOnce(s,
      '\t\t\t\tawait this.open();\n\t\t\t}\n\t\t\t/**',
      '\t\t\t\tawait this.open();\n\t\t\t\t// Session editor: a successful reopen restores the resident conversation.\n\t\t\t\tif (this.openState === "open") {\n\t\t\t\t\tthis.removed = false;\n\t\t\t\t\tthis.notifier.markDirty();\n\t\t\t\t}\n\t\t\t}\n\t\t\t/**') },
  ];
  const changes = specs.map((spec) => {
    const path = `node_modules/@deepseek-ai/${spec.pkg}/lib/${spec.file ?? "index.js"}`;
    const file = resolveFile(app, path);
    const before = readFile(file, "utf8");
    const old = previous.find((m) => m.path === path);
    if (old && hash(before) !== old.original && hash(before) !== old.patched) throw new Error(`宿主已有其他修改，拒绝覆盖: ${path}`);
    const originalText = old ? readFile(join(backup, old.original), "utf8") : before;
    if (old && hash(originalText) !== old.original) throw new Error(`宿主原件备份校验失败: ${path}`);
    if (!spec.original.includes(hash(originalText))) throw new Error(`尚未支持此 DSH 构建: ${spec.pkg}。未修改任何文件。`);
    return { file, path, before, originalText, after: spec.patch(originalText), original: hash(originalText) };
  });
  return () => {
    mkdirSync(backup, { recursive: true });
    const manifest = changes.map((c) => {
      const patched = hash(c.after);
      writeFileSync(join(backup, c.original), c.originalText);
      writeFileSync(join(backup, patched), c.after);
      return { path: c.path, original: c.original, patched };
    });
    try { for (const c of changes) writeFileSync(c.file, c.after); writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)); }
    catch (e) { for (const c of changes) writeFileSync(c.file, c.before); throw e; }
  };
}
