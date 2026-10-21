import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const hash = (s) => createHash("sha256").update(s).digest("hex");
function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error("DSH 接口结构不兼容，未应用适配");
  return text.replace(before, after);
}

export function planAdapter(app, restore = false) {
  const backup = join(app, ".session-editor-adapter");
  const manifestPath = join(backup, "manifest.json");
  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
  if (restore && previous.length) {
    const changes = previous.map((m) => {
      const file = join(app, m.path);
      const current = readFileSync(file, "utf8");
      if (hash(current) !== m.patched && hash(current) !== m.original) throw new Error(`宿主已有其他修改，拒绝覆盖: ${m.path}`);
      return { file, path: m.path, before: current,
        after: readFileSync(join(backup, m.original), "utf8") };
    });
    return () => { for (const c of changes) writeFileSync(c.file, c.after); };
  }
  if (restore) throw new Error("没有宿主适配备份");
  const specs = [
    { pkg: "dsh-agent", original: "7b9aa39474de83115cf890dd7f8904cf0d59df0811cb335ab85565a04f1aac93", patch: (s) => replaceOnce(s,
      '\tget(id) {\n\t\treturn this.store.get(id)?.agent;\n\t}',
      '\tget(id) {\n\t\treturn this.store.get(id)?.agent;\n\t}\n\t/** Session editor adapter: release through the original lifecycle owner. */\n\tasync releaseIdle(id) {\n\t\tconst agent = this.get(id);\n\t\tif (agent === void 0) return false;\n\t\tconst { target } = this.requireFactory();\n\t\tif (typeof target.releaseIdle !== "function") throw new Error("agent factory does not support idle release");\n\t\treturn target.releaseIdle(agent);\n\t}') },
    { pkg: "dsh-agent-loop", original: "00c4814d63f3d1e2754eb09144832d19b30499d6ea444730473f740b587948c2", patch: (s) => {
      s = replaceOnce(s, '\truntime;\n\tconstructor(ctx, config) {', '\truntime;\n\teditorHandles = new WeakMap();\n\tasync releaseIdle(agent) {\n\t\tconst dispose = this.editorHandles.get(agent);\n\t\tif (!dispose || this.runtime.ctx.agents.get(agent.id) !== agent) throw new Error("agent lifecycle is not available");\n\t\tif (agent.status === "running") throw new Error("会话正在生成，请先停止生成");\n\t\tif (this.runtime.ctx.agents.list().some((child) => this.runtime.ctx.agents.isOwnedBy(child.id, agent))) throw new Error("会话仍持有子任务，请等待子任务结束");\n\t\tawait dispose();\n\t\treturn true;\n\t}\n\tconstructor(ctx, config) {');
      s = replaceOnce(s, '\t\t\t\tuntrack();\n\t\t\t\tif (!ownerTriggered)', '\t\t\t\tif (machine) this.editorHandles.delete(machine);\n\t\t\t\tuntrack();\n\t\t\t\tif (!ownerTriggered)');
      return replaceOnce(s, '\t\t\t\t\t\treturn {\n\t\t\t\t\t\t\tagent,\n\t\t\t\t\t\t\tdispose', '\t\t\t\t\t\tthis.editorHandles.set(agent, dispose);\n\t\t\t\t\t\treturn {\n\t\t\t\t\t\t\tagent,\n\t\t\t\t\t\t\tdispose');
    } },
    { pkg: "dsh-api-session-controller", file: "client.js", original: "60ec6a006443b40e5ab718f3fa53c301559c5c28427ca650c3851127ce370d43", patch: (s) => replaceOnce(s,
      '\t\t\t\tawait this.open();\n\t\t\t}\n\t\t\t/**',
      '\t\t\t\tawait this.open();\n\t\t\t\t// Session editor: a successful reopen restores the resident conversation.\n\t\t\t\tif (this.openState === "open") {\n\t\t\t\t\tthis.removed = false;\n\t\t\t\t\tthis.notifier.markDirty();\n\t\t\t\t}\n\t\t\t}\n\t\t\t/**') },
  ];
  const changes = specs.map((spec) => {
    const path = `node_modules/@deepseek-ai/${spec.pkg}/lib/${spec.file ?? "index.js"}`;
    const file = join(app, path);
    const before = readFileSync(file, "utf8");
    const old = previous.find((m) => m.path === path);
    if (old && hash(before) !== old.original && hash(before) !== old.patched) throw new Error(`宿主已有其他修改，拒绝覆盖: ${path}`);
    const originalText = old ? readFileSync(join(backup, old.original), "utf8") : before;
    if (hash(originalText) !== spec.original) throw new Error(`尚未支持此 DSH 构建: ${spec.pkg}。未修改任何文件。`);
    return { file, path, before, originalText, after: spec.patch(originalText), original: spec.original };
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
