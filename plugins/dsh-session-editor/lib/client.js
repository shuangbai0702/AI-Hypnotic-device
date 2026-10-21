// lib/client.js — shuangbai session-editor: client half
// 挂载 sidebar.right.pane.tab：上下文/历史/摘要 三视图 + 即时刷新。
// 手写 __ModuleLoader__ factory（无构建链），仅 require react。
window.__ModuleLoader__.load({
  id: "@shuangbai/dsh-session-editor",
  factory: (require) => {
    const { createElement: h, useState, useCallback, useEffect, useRef } = require("react");

    const API = "/api/session-editor";
    let hostSessions;
    let hostUiSession;

    // Presentation only: never replace a native renderer or alter its messages.
    // Coverage is message-level. Thinking is a secondary indication, never
    // a false partially-covered state.
    const coverageVisual = {
      "summary-covered": {
        label: "整条已被摘要替代", color: "#475467", background: "#F2F4F7",
        explanation: "这整条消息已被压缩摘要替代；原正文、思考和其他块不会作为原消息自动发送。",
      },
      "retained-with-thinking": {
        label: "整条未被摘要覆盖", color: "#067647", background: "#ECFDF3",
        explanation: "正文和思考均未被摘要替代；思考是否实际回传由当前模型适配器决定。",
      },
      retained: {
        label: "整条未被摘要覆盖", color: "#067647", background: "#ECFDF3",
        explanation: "这整条消息仍在有效上下文中；本条没有思考块。",
      },
      "summary-active": {
        label: "当前生效的压缩摘要", color: "#175CD3", background: "#EFF8FF",
        explanation: "这条摘要承接被压缩的历史消息；摘要正文会进入有效上下文。",
      },
      replaced: {
        label: "已被其他内容替代", color: "#6941C6", background: "#F4F3FF",
        explanation: "这条原消息已被其他消息替代，不再作为原消息自动发送。",
      },
      removed: {
        label: "已移出上下文", color: "#B42318", background: "#FEF3F2",
        explanation: "原始聊天记录仍保留，但这条消息已被移出后续模型上下文。",
      },
      unknown: {
        label: "上下文状态未知", color: "#475467", background: "#F2F4F7",
        explanation: "当前无法从 DSH 的 surface 替换记录确认这条消息的状态。",
      },
    };
    const visualFor = (item) => {
      const state = item?.coverageState ?? (item?.status === 'active'
        ? item.checkpoint ? 'summary-active' : item.thoughtCount > 0 ? 'retained-with-thinking' : 'retained'
        : item?.status === 'covered' ? 'summary-covered' : item?.status);
      return coverageVisual[state] ?? coverageVisual.unknown;
    };

    function installChatCoverage(ctx) {
      let disposed = false, generation = 0, timer, request, stopChat = () => {};
      let sessionId, binding, chat, coverage = new Map();
      const badges = new Set();
      const clear = () => { for (const badge of badges) badge.remove(); badges.clear(); };
      const paint = () => {
        if (disposed) return;
        const snapshot = chat?.getSnapshot();
        for (const row of document.querySelectorAll('[data-chat-node-key]')) {
          const node = snapshot?.nodes.get(row.dataset.chatNodeKey);
          if (row.closest('[data-conversation-session]')?.dataset.conversationSession !== sessionId) continue;
          const seq = node?.kind === 'assistant-step' ? node.data.finalNode?.seq
            : ['user', 'steering', 'context'].includes(node?.kind) ? node.data.seq : undefined;
          const item = coverage.get(seq);
          let badge = [...row.children].find(e => e.hasAttribute('data-session-editor-coverage'));
          if (!item) { if (badge) { badges.delete(badge); badge.remove(); } continue; }
          const visual = visualFor(item);
          const thought = item.thoughtState === 'retained' && item.thoughtCount > 0;
          const text = `● ${visual.label} · #${seq}`;
          const thoughtText = thought ? `含 ${item.thoughtCount} 个保留思考块` : '';
          const title = visual.explanation + (item.chain.length ? ` 替代路径：#${seq} → ${item.chain.map(n => '#' + n).join(' → ')}` : '');
          if (!badge) {
            badge = document.createElement('div');
            badge.setAttribute('data-session-editor-coverage', '');
            badges.add(badge);
            row.prepend(badge);
          }
          if (badge.dataset.label !== text || badge.dataset.thought !== thoughtText) {
            badge.dataset.label = text; badge.dataset.thought = thoughtText;
            badge.replaceChildren(document.createTextNode(text));
            if (thought) {
              const chip = document.createElement('span');
              chip.textContent = thoughtText;
              chip.style.cssText = 'margin-left:6px;padding:1px 5px;border-radius:4px;color:#B54708;background:#FFFAEB;';
              badge.append(chip);
            }
          }
          if (badge.title !== title) badge.title = title;
          badge.setAttribute('aria-label', `${text}${thoughtText ? ' · ' + thoughtText : ''}。${title}`);
          badge.style.cssText = `display:table;margin:4px 0;padding:3px 8px;border-radius:6px;font:11px/1.5 system-ui;color:${visual.color};background:${visual.background};border-left:3px solid ${visual.color};`;
        }
        for (const badge of badges) if (!badge.isConnected) badges.delete(badge);
      };
      const schedule = () => { clearTimeout(timer); timer = setTimeout(update, 120); };
      async function refresh() {
        request?.abort();
        const controller = request = new AbortController(), stamp = ++generation, target = sessionId;
        coverage.clear(); clear();
        if (!target) return;
        try {
          const data = await api('/coverage?id=' + encodeURIComponent(target), { signal: controller.signal });
          if (disposed || stamp !== generation || sessionId !== target || ctx.sessions.binding(target) !== binding) return;
          coverage = new Map(data.items.map(item => [item.seq, item])); paint();
        } catch (error) { if (error.name !== 'AbortError' && !disposed && stamp === generation) { coverage.clear(); clear(); } }
      }
      function update() {
        if (disposed) return;
        const next = ctx.uiSession.current.value.key;
        const owner = next ? ctx.sessions.binding(next) : undefined;
        if (next !== sessionId || owner !== binding) {
          stopChat(); sessionId = next; binding = owner;
          chat = owner ? ctx.uiConversation.binding(owner).target('chat') : undefined;
          stopChat = chat?.subscribe(() => { schedule(); clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 300); }) ?? (() => {});
          refresh();
        }
        paint();
      }
      let refreshTimer;
      const observer = new MutationObserver(records => {
        if (records.some(r => !r.target.closest?.('[data-session-editor-coverage]') &&
          [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && !n.hasAttribute('data-session-editor-coverage')))) schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const stopCurrent = ctx.uiSession.current.subscribe(update);
      window.addEventListener('session-editor:changed', refresh);
      update();
      return () => {
        disposed = true; ++generation; request?.abort(); stopCurrent(); stopChat(); observer.disconnect();
        clearTimeout(timer); clearTimeout(refreshTimer); window.removeEventListener('session-editor:changed', refresh); clear();
      };
    }

    async function refreshConversation(sessionId) {
      const session = hostSessions?.binding(sessionId)?.session;
      if (session) {
        await session.resync();
        const state = session.getSnapshot();
        if (state.openError || state.removed) throw new Error(state.openError?.message ?? "会话尚未恢复，请重试同步");
      }
    }

    async function api(path, opts) {
      const r = await fetch(API + path, opts);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      return j;
    }
    const post = (path, body) => api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    function editedBlocks(blocks, text, clearThoughts = false, thoughts = {}) {
      let replaced = false;
      const next = blocks.flatMap((b, index) => {
        if (["reasoning", "thinking"].includes(b.type)) {
          if (clearThoughts) return [];
          if (Object.prototype.hasOwnProperty.call(thoughts, index)) {
            return [{ ...b, [b.type === "thinking" ? "thinking" : "text"]: thoughts[index] }];
          }
          return [b];
        }
        if (b.type !== "text") return [b];
        if (replaced) return [];
        replaced = true;
        return [{ ...b, text }];
      });
      if (!replaced) next.push({ type: "text", text });
      return next;
    }

    function editChanges(message, editing) {
      const changes = [];
      const before = editing.originalText ?? message.editText;
      if (before !== editing.text) changes.push({ label: message.checkpoint ? '摘要正文' : '消息正文', before, after: editing.text });
      (editing.blocks ?? []).forEach((block, index) => {
        if (!['reasoning', 'thinking'].includes(block.type)) return;
        const before = block.text ?? block.thinking ?? '';
        const after = editing.clearThoughts ? '' : editing.thoughts?.[index] ?? before;
        if (before !== after || editing.clearThoughts) changes.push({ label: `思考块 ${index + 1}${editing.clearThoughts ? ' · 清除' : ''}`, before, after });
      });
      return changes;
    }

    function ChangePreview({ message, editing, revision }) {
      const changes = editChanges(message, editing);
      return h('div', null,
        revision !== editing.revision && h('div', { style: sty.err, role: 'alert' }, '会话已变化，草稿已保留。当前保存会被版本校验拒绝；请复制草稿后取消，重新读取并核对。'),
        h('details', { style: sty.details }, h('summary', null, `保存前检查 · ${changes.length} 项改动`),
          changes.length ? changes.map((change, index) => h('div', { key: index, style: sty.card },
            h('div', { style: sty.cardHead }, change.label),
            h('div', { style: sty.help }, '修改前'), h('pre', { style: sty.pre }, change.before || '（空）'),
            h('div', { style: sty.help }, '保存后'), h('pre', { style: sty.pre }, change.after || '（空）')))
            : h('div', { style: sty.help }, '尚未修改正文或思考。'),
          h('div', { style: sty.help }, '只在点击保存后写入；取消会丢弃本次草稿。未改动的思考、附件和工具块保留。')));
    }

    function useLifetime() {
      const alive = useRef(false);
      useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
      return alive;
    }

    function MessageBody({ message }) {
      const thoughts = message.blocks.filter((b) => b.type === "reasoning" || b.type === "thinking")
        .map((b) => b.text ?? b.thinking ?? "").join("\n");
      const other = message.blocks.filter((b) => !["text", "reasoning", "thinking"].includes(b.type));
      const content = h("div", null, h("pre", { style: sty.pre }, message.editText || "（无文本正文）"),
        thoughts && h("details", { style: sty.details }, h("summary", null, "思考内容 · 由模型适配器决定是否回传"), h("pre", { style: sty.pre }, thoughts)),
        other.length > 0 && h("div", { style: sty.dim }, `另有 ${other.length} 个工具或附件块，编辑正文时保留。`));
      return message.role === "system" || ["runtime-context", "skill-catalog"].includes(message.source) ? h("details", { style: sty.details },
        h("summary", null, message.role === "system" ? "查看系统指令（DSH 每轮自动构建）" : "查看 DSH 自动附加内容"), content) : content;
    }

    const messageLabel = (m) => m.checkpoint ? "压缩记忆" : m.source === "runtime-context" ? "运行环境" : m.source === "skill-catalog" ? "技能目录" :
      ({ system: "系统指令", user: "用户消息", assistant: "助手回复", developer: "开发者指令", tool: "工具结果" }[m.role] ?? m.role);

    /* ---------------- 上下文视图 ---------------- */
    function ContextView({ sessionId, reloadKey, onChanged, focusSeq, onCoverage }) {
      const [data, setData] = useState(null);
      const [err, setErr] = useState("");
      const [editing, setEditing] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState("");
      const [search, setSearch] = useState(focusSeq == null ? "" : String(focusSeq));
      const alive = useLifetime();
      const saving = useRef(false);

      useEffect(() => { setSearch(focusSeq == null ? "" : String(focusSeq)); }, [focusSeq]);
      useEffect(() => {
        let alive = true;
        setErr("");
        api("/context?id=" + encodeURIComponent(sessionId))
          .then((j) => { if (alive) setData(j); })
          .catch((e) => { if (alive) setErr(e.message); });
        return () => { alive = false; };
      }, [sessionId, reloadKey]);

      const save = useCallback(async () => {
        if (!editing || saving.current || !editChanges({ editText: editing.originalText, checkpoint: editing.checkpoint }, editing).length) return;
        saving.current = true;
        setBusy(true);
        try {
          setErr(""); setNotice("");
          if (editing.checkpoint) await post("/summary/edit", { id: sessionId, seq: editing.seq, text: editing.text, expectRevision: editing.revision });
          else await post("/edit", { id: sessionId, seq: editing.seq, blocks: editedBlocks(editing.blocks, editing.text, editing.clearThoughts, editing.thoughts), physical: true, expectRevision: editing.revision });
          if (!alive.current) return;
          setEditing(null);
          onChanged();
          try {
            await refreshConversation(sessionId);
            if (alive.current) setNotice("已保存，上下文与左侧会话已更新");
          } catch (e) {
            if (alive.current) setErr("内容已保存，左侧同步失败；请点“同步左侧”重试：" + e.message);
          }
        } catch (e) { if (alive.current) setErr(e.message); }
        finally { saving.current = false; if (alive.current) setBusy(false); }
      }, [editing, sessionId, onChanged, data]);

      const del = useCallback(async (seq) => {
        if (saving.current) return;
        saving.current = true; setBusy(true); setErr(''); setNotice('');
        try { await post("/delete-node", { id: sessionId, seq, expectRevision: data.contentRevision }); if (alive.current) { onChanged(); setNotice("已从模型上下文移除，原始聊天记录仍保留"); } }
        catch (e) { if (alive.current) setErr(e.message); }
        finally { saving.current = false; if (alive.current) setBusy(false); }
      }, [sessionId, onChanged, data]);

      if (err && !data) return h("div", { style: sty.err }, err);
      if (!data) return h("div", { style: sty.dim }, "载入中…");
      const visible = data.messages.filter((m) => m.seq === editing?.seq || !search ||
        `${m.seq} ${messageLabel(m)} ${m.editText} ${m.blocks.map((b) => b.text ?? b.thinking ?? "").join("\n")}`.toLowerCase().includes(search.toLowerCase()));
      return h("div", null,
        err && h("div", { style: sty.err }, err),
        notice && h("div", { style: sty.success, role: "status" }, notice),
        h("div", { style: sty.row },
          h("span", { style: sty.dim }, `${data.messageCount} 条有效消息 · 约 ${data.totalTokens} tokens（估算）`)),
        h("input", { style: sty.input, placeholder: "搜索内容、类型或 #编号", "aria-label": "搜索上下文", value: search,
          onChange: (e) => setSearch(e.target.value.replace(/^#/, "")) }),
        search && h("div", { style: sty.dim }, `找到 ${visible.length} 条消息`),
        visible.map((m) => h("div", { key: m.seq, style: sty.card },
          h("div", { style: sty.cardHead },
            h("span", { style: { ...sty.tag, background: m.checkpoint ? "#B4690E" : roleColor(m.role) } }, messageLabel(m)),
            h("span", { style: sty.dim, title: "日志事件编号，不代表上下文排序" }, `#${m.seq} · 约 ${m.tokens} tokens`),
            h("span", { style: sty.spacer }),
            ["user", "assistant", "developer"].includes(m.role) && h("button", {
              style: sty.btn, onClick: () => { setErr(""); setNotice(""); setEditing({ seq: m.seq, text: m.editText, originalText: m.editText, revision: data.contentRevision, blocks: m.blocks, checkpoint: m.checkpoint, clearThoughts: false, thoughts: {} }); }, disabled: busy || editing !== null,
            }, m.checkpoint ? "编辑摘要" : "编辑"),
            !m.checkpoint && ["user", "assistant", "developer"].includes(m.role) && h("button", {
              style: sty.btn, onClick: () => { if (confirm("从后续模型上下文移除这条消息？原始聊天记录会保留。")) del(m.seq); }, disabled: busy || editing !== null,
            }, "移出上下文")),
          h("div", { style: { ...sty.help, padding: '6px 8px', color: visualFor(m).color, background: visualFor(m).background } }, m.checkpoint
            ? `摘要正在生效 · 承接 ${m.coverage?.coveredSeqs?.length ?? 0} 条历史消息，原文不再自动发送。`
            : `${visualFor(m).label}${m.thoughtCount > 0 ? ` · 含 ${m.thoughtCount} 个保留思考块；是否回传由模型适配器决定。` : ' · 本条无思考块。'}`),
          m.checkpoint && h("button", { style: sty.btn, onClick: () => onCoverage(m.seq) }, "查看覆盖的原文"),
          editing && editing.seq === m.seq
            ? h("div", null,
                !m.checkpoint && h("div", { style: sty.help }, "正文、思考可分别编辑，默认保留未修改内容。旧思考可能回传并影响回答；也可清除本条全部思考。附件和工具块保留。"),
                m.role === "assistant" && m.blocks.some((b) => ["reasoning", "thinking"].includes(b.type)) && h("label", { style: sty.help },
                  h("input", { type: "checkbox", checked: editing.clearThoughts, disabled: busy,
                    onChange: (e) => setEditing({ ...editing, clearThoughts: e.target.checked }) }), "同时清除本条旧思考（附件和工具块保留）"),
                h("textarea", { style: sty.ta, value: editing.text, autoFocus: true, "aria-label": m.checkpoint ? "摘要正文" : "消息正文", disabled: busy,
                  onKeyDown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); } else if (e.key === "Escape" && !busy) setEditing(null); },
                  onChange: (e) => setEditing({ ...editing, text: e.target.value }), rows: 6 }),
                m.role === "assistant" && m.blocks.map((b, index) => ["reasoning", "thinking"].includes(b.type) && h("div", { key: index },
                  h("div", { style: sty.help }, `思考块 ${index + 1}（由模型适配器决定是否回传）`),
                  h("textarea", { style: sty.ta, "aria-label": `思考块 ${index + 1}`, rows: 6,
                    disabled: busy || editing.clearThoughts, value: editing.thoughts[index] ?? b.text ?? b.thinking ?? "",
                    onChange: (e) => setEditing({ ...editing, thoughts: { ...editing.thoughts, [index]: e.target.value } }),
                    onKeyDown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); } else if (e.key === "Escape" && !busy) setEditing(null); } }))),
                h(ChangePreview, { message: m, editing, revision: data.contentRevision }),
                h("div", { style: sty.row },
                  h("button", { style: sty.primary, onClick: save, disabled: busy || !editChanges(m, editing).length }, busy ? "保存中…" : "保存"),
                  h("button", { style: sty.btn, onClick: () => setEditing(null), disabled: busy }, "取消"),
                  h("span", { style: sty.dim }, "Ctrl+Enter 保存 · Esc 取消")))
            : h(MessageBody, { message: m }))));
    }

    /* ---------------- 摘要视图 ---------------- */
    function SummaryView({ sessionId, reloadKey, onChanged }) {
      const [data, setData] = useState(null);
      const [err, setErr] = useState("");
      const [editing, setEditing] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState("");
      const alive = useLifetime();
      const saving = useRef(false);

      useEffect(() => {
        let alive = true;
        setErr("");
        api("/summary?id=" + encodeURIComponent(sessionId))
          .then((j) => { if (alive) setData(j); })
          .catch((e) => { if (alive) setErr(e.message); });
        return () => { alive = false; };
      }, [sessionId, reloadKey]);

      const save = useCallback(async () => {
        if (!editing || saving.current || editing.text === editing.originalText) return;
        saving.current = true;
        setBusy(true);
        try {
          setErr(""); setNotice("");
          await post("/summary/edit", { id: sessionId, seq: editing.seq, text: editing.text, expectRevision: editing.revision });
          if (!alive.current) return;
          setEditing(null); onChanged();
          try {
            await refreshConversation(sessionId);
            if (alive.current) setNotice("摘要已保存，左侧会话已更新");
          } catch (e) {
            if (alive.current) setErr("摘要已保存，左侧同步失败；请点“同步左侧”重试：" + e.message);
          }
        } catch (e) { if (alive.current) setErr(e.message); }
        finally { saving.current = false; if (alive.current) setBusy(false); }
      }, [editing, sessionId, onChanged, data]);

      if (err && !data) return h("div", { style: sty.err }, err);
      if (!data) return h("div", { style: sty.dim }, "载入中…");
      if (!data.summaries.length) return h("div", { style: sty.dim }, "此会话没有压缩摘要");
      return h("div", null,
        err && h("div", { style: sty.err }, err),
        notice && h("div", { style: sty.success, role: "status" }, notice),
        data.summaries.map((s) => h("div", { key: s.seq, style: sty.card },
          h("div", { style: sty.cardHead },
            h("span", { style: { ...sty.tag, background: "#B4690E" } }, "生效摘要 · 可编辑"),
            h("span", { style: sty.dim }, `覆盖 ${s.coverage?.coveredSeqs.length ?? 0} 条历史消息 · 用户 ${s.coverage?.userCount ?? 0} · 助手 ${s.coverage?.assistantCount ?? 0}`),
            h("span", { style: sty.dim }, `#${s.seq} · ${s.tokens} tok`),
            h("span", { style: sty.spacer }),
            h("button", { style: sty.btn, onClick: () => { setErr(''); setNotice(''); setEditing({ seq: s.seq, text: s.editText, originalText: s.editText, revision: data.contentRevision }); }, disabled: busy || editing !== null }, "编辑")),
          editing && editing.seq === s.seq
            ? h("div", null,
                h("textarea", { style: { ...sty.ta, minHeight: 240 }, value: editing.text, autoFocus: true, "aria-label": "摘要正文", disabled: busy,
                  onKeyDown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); save(); } else if (e.key === "Escape" && !busy) setEditing(null); },
                  onChange: (e) => setEditing({ ...editing, text: e.target.value }), rows: 8 }),
                h(ChangePreview, { message: { ...s, checkpoint: true }, editing, revision: data.contentRevision }),
                h("div", { style: sty.row },
                  h("button", { style: sty.primary, onClick: save, disabled: busy || editing.text === editing.originalText }, busy ? "保存中…" : "保存摘要"),
                  h("button", { style: sty.btn, onClick: () => setEditing(null), disabled: busy }, "取消"),
                  h("span", { style: sty.dim }, "Ctrl+Enter 保存 · Esc 取消")))
            : h("pre", { style: sty.pre }, s.editText))));
    }

    /* ---------------- 历史视图 ---------------- */
    const coverageLabel = { active: "当前有效", covered: "已由摘要替代", replaced: "已被其他消息替换", removed: "已移出上下文", unknown: "未进入当前上下文" };
    function CoverageView({ sessionId, reloadKey, summarySeq, onOpen }) {
      const [data, setData] = useState(null);
      const [err, setErr] = useState("");
      const [filter, setFilter] = useState(summarySeq == null ? "all" : "covered");
      const [query, setQuery] = useState("");
      useEffect(() => {
        let alive = true;
        api("/coverage?id=" + encodeURIComponent(sessionId)).then(j => { if (alive) setData(j); })
          .catch(e => { if (alive) setErr(e.message); });
        return () => { alive = false; };
      }, [sessionId, reloadKey]);
      if (err) return h("div", { style: sty.err }, err);
      if (!data) return h("div", { style: sty.dim }, "载入覆盖关系…");
      const rows = data.items.filter(i => (filter === "all" || i.status === filter) &&
        (summarySeq == null || i.finalSeq === summarySeq && i.seq !== summarySeq) &&
        (!query || `${i.seq} ${i.text}`.toLowerCase().includes(query.toLowerCase())));
      return h("div", null,
        h("div", { style: sty.help }, "以 DSH 当前有效上下文为准。已由摘要替代的原文不会自动发送；摘要不保证逐句保留。左侧聊天仍可显示完整历史。"),
        h("div", { style: sty.row }, `当前有效 ${data.counts.active} · 摘要替代 ${data.counts.covered} · 其他替换 ${data.counts.replaced} · 移出 ${data.counts.removed}`),
        summarySeq != null && h("div", { style: sty.success }, `正在查看摘要 #${summarySeq} 承接的历史`, h("button", { style: sty.btn, onClick: () => onOpen(summarySeq) }, "编辑这条摘要")),
        h("div", { style: sty.row }, ["all", "active", "covered", "replaced", "removed"].map(status => h("button", {
          key: status, style: { ...sty.btn, ...(filter === status ? sty.tabOn : {}) }, onClick: () => setFilter(status)
        }, status === "all" ? "全部消息" : coverageLabel[status]))),
        h("input", { style: sty.input, value: query, "aria-label": "搜索历史消息", placeholder: "搜索历史正文或编号", onChange: e => setQuery(e.target.value) }),
        h("div", { style: sty.dim }, `共 ${rows.length} 条`),
        rows.map(i => h("div", { key: i.seq, style: sty.card },
          h("div", { style: sty.cardHead }, h("span", { style: { ...sty.tag, background: visualFor(i).color } }, visualFor(i).label),
            h("span", null, `#${i.seq} · ${i.checkpoint ? "压缩记忆" : messageLabel(i)}`)),
          h("pre", { style: sty.pre }, i.preview || "（无文本正文）"),
          h("div", { style: sty.help }, visualFor(i).explanation),
          i.chain.length > 0 && h("div", { style: sty.help }, `替代路径：#${i.seq} → ${i.chain.map(n => "#" + n).join(" → ")}`),
          i.finalSeq != null && i.status !== "removed" && h("button", { style: sty.btn, onClick: () => onOpen(i.finalSeq) }, i.status === "active" ? "查看 / 编辑有效内容" : `前往当前承接内容 #${i.finalSeq}`),
          h("details", { style: sty.details }, h("summary", null, i.editable ? "展开正文（当前生效，可通过上方入口编辑）" : "展开归档原文（只读）"), h("pre", { style: sty.pre }, i.text)))));
    }

    function HistoryView({ sessionId, reloadKey }) {
      const [data, setData] = useState(null);
      const [q, setQ] = useState("");
      const [err, setErr] = useState("");
      useEffect(() => {
        let alive = true;
        setData(null); setErr("");
        api("/events?id=" + encodeURIComponent(sessionId))
          .then((j) => { if (alive) setData(j); })
          .catch((e) => { if (alive) setErr(e.message); });
        return () => { alive = false; };
      }, [sessionId, reloadKey]);
      if (err) return h("div", { style: sty.err }, err);
      if (!data) return h("div", { style: sty.dim }, "载入中…");
      const rows = data.events.filter((e) =>
        !q || (e.summary ?? "").toLowerCase().includes(q.toLowerCase()) || e.type.includes(q.toLowerCase()));
      return h("div", null,
        h("input", { style: sty.input, placeholder: `筛选 ${data.total} 条事件…`,
          value: q, onChange: (e) => setQ(e.target.value) }),
        h("div", null, rows.map((e) => h("div", { key: e.seq, style: sty.histRow },
          h("span", { style: sty.mono }, String(e.seq).padStart(4)),
          h("span", { style: { ...sty.tag, background: typeColor(e.type), fontSize: 9 } }, e.type),
          h("span", { style: { ...sty.dim, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            e.summary ?? "")))));
    }

    const roleColor = (r) => ({ system: "#7048E8", user: "#0E9F6E", assistant: "#2563EB" }[r] ?? "#64748B");
    const typeColor = (t) => t.startsWith("user") ? "#0E9F6E" : t.startsWith("assistant") ? "#2563EB"
      : t.startsWith("compaction") ? "#B4690E" : t.startsWith("tool") ? "#64748B" : "#94A3B8";

    /* ---------------- 面板 ---------------- */
    function MemoryAssistant({ sessionId, SessionProvider, renderSlot, onChanged, taskDraft, onReview }) {
      const [reference, setReference] = useState(null);
      const [info, setInfo] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [task, setTask] = useState(taskDraft?.sessionId === sessionId ? taskDraft.text : '');
      useEffect(() => { if (taskDraft?.sessionId === sessionId) setTask(taskDraft.text); }, [taskDraft, sessionId]);
      const owned = useRef(null), epoch = useRef(0), pending = useRef(false);
      const changes = useRef(0);
      useEffect(() => () => { ++epoch.current; owned.current?.release(); owned.current = null; }, [sessionId]);
      const open = async (reset = false, taskText = '') => {
        if (pending.current) return;
        pending.current = true;
        const stamp = ++epoch.current;
        setBusy(true); setError('');
        try {
          const data = await post('/assistant/open', { id: sessionId, reset });
          if (stamp !== epoch.current) return;
          owned.current?.release(); owned.current = null; setReference(null);
          const retained = hostSessions.retain(data.sessionId, { source: 'session-editor-memory' });
          let released = false;
          const ref = { get sessionId() { return retained.sessionId; }, get binding() { return retained.binding; }, ready: retained.ready,
            release() { if (!released) { released = true; retained.release(); } } };
          owned.current = ref;
          await ref.ready;
          if (stamp !== epoch.current) { ref.release(); return; }
          changes.current = data.changeCount;
          setInfo(data); setReference(ref);
          if (taskText.trim()) {
            await post('/assistant/prompt', { id: sessionId, text: taskText.trim() });
            if (stamp !== epoch.current) return;
            setTask('');
          }
          if (data.changeCount) { onChanged(); try { await refreshConversation(sessionId); } catch (e) { if (stamp === epoch.current) setError('记忆已修改，目标聊天同步失败：' + e.message); } }
        } catch (e) {
          if (stamp === epoch.current) { owned.current?.release(); owned.current = null; setReference(null); setError(e.message); }
        } finally { pending.current = false; if (stamp === epoch.current) setBusy(false); }
      };
      useEffect(() => {
        if (!reference) return;
        let active = true, timer, controller;
        const poll = async () => {
          controller = new AbortController();
          try {
            const data = await api('/assistant/status?id=' + encodeURIComponent(sessionId), { signal: controller.signal });
            if (!active) return;
            setInfo(data);
            if (data.changeCount !== changes.current) {
              changes.current = data.changeCount;
              onChanged();
              try { await refreshConversation(sessionId); }
              catch (e) { if (active) setError('记忆已修改，目标聊天同步失败：' + e.message); }
            }
          } catch (e) { if (active && e.name !== 'AbortError') setError(e.message); }
          finally { if (active) timer = setTimeout(poll, 900); }
        };
        poll();
        return () => { active = false; clearTimeout(timer); controller?.abort(); };
      }, [reference, sessionId, onChanged]);
      const control = async (action) => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError('');
        const stamp = epoch.current;
        try {
          await post('/assistant/' + action, { id: sessionId });
          if (stamp !== epoch.current) return;
          if (action === 'close') { owned.current?.release(); owned.current = null; setReference(null); setInfo(null); }
        } catch (e) { if (stamp === epoch.current) setError(e.message); }
        finally { pending.current = false; if (stamp === epoch.current) setBusy(false); }
      };
      return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }, 'data-memory-assistant-target': sessionId },
        h('div', { style: sty.help }, '帮你整理当前会话的记忆。局部压缩先生成候选，确认后才应用。归档原文只读，生效摘要可编辑。'),
        task && h('div', { style: sty.card }, h('div', { style: sty.cardHead }, '任务草稿 · 尚未发送'),
          h('textarea', { style: { ...sty.ta, minHeight: 110 }, 'aria-label': '助手任务草稿', value: task, disabled: busy, onChange: e => setTask(e.target.value) }),
          h('div', { style: sty.row }, h('button', { style: sty.primary, disabled: busy || info?.status === 'running', onClick: () => open(false, task) }, '发送给助手起草'),
            h('button', { style: sty.btn, disabled: busy, onClick: () => setTask('') }, '丢弃草稿'))),
        info?.legacyArchived && h('div', { style: sty.help, role: 'status' }, '旧版助手对话已保留，本次使用新的隔离助手，避免沿用以前混入的额外上下文。'),
        h('div', { style: sty.row },
          h('button', { style: sty.primary, disabled: busy, onClick: () => open() }, busy ? '处理中…' : reference ? '重新连接助手' : '打开 / 恢复助手'),
          h('button', { style: sty.btn, disabled: busy, onClick: () => { if (confirm('新建独立助手对话？旧助手历史保留，当前任务将停止。')) open(true); } }, '新建助手对话'),
          reference && h('button', { style: sty.btn, disabled: busy, onClick: () => control('cancel') }, '停止助手'),
          reference && h('button', { style: sty.btn, disabled: busy, onClick: () => control('close') }, '关闭助手')),
        info && h('div', { style: sty.dim, role: 'status' }, `助手${({ running: '运行中', idle: '已就绪', closed: '已关闭', closing: '关闭中', opening: '打开中' })[info.status] ?? info.status} · 本次已修改 ${info.changeCount ?? 0} 次 · ${info.model?.model ?? 'DSH 当前模型'} · ${info.isolation === 'memory-only-v1' ? '记忆范围已隔离' : '隔离状态未确认'}`),
        error && h('div', { style: sty.err, role: 'alert' }, error),
        info?.results?.some(r => r.candidateId) && h('button', { style: sty.primary, onClick: () => { onChanged(); onReview(); } }, '查看待审候选'),
        info?.results?.length > 0 && h('details', { style: sty.details }, h('summary', null, '最近记忆操作结果'),
          ...info.results.map((result, index) => h('pre', { key: index, style: sty.pre }, JSON.stringify(result, null, 2)))),
        reference ? h(SessionProvider, { session: reference }, renderSlot('session-editor.assistant', {}))
          : h('div', { style: sty.help }, '例如：找出与摘要矛盾的旧回复并修改；只改摘要不清除思考；检查哪些消息仍在有效上下文。'));
    }

    function WorkbenchView({ sessionId, reloadKey, onChanged, onAssistant, onOpen }) {
      const [data, setData] = useState(null), [error, setError] = useState("");
      const [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
      const [draft, setDraft] = useState(null), [query, setQuery] = useState("");
      const [originals, setOriginals] = useState(null), [original, setOriginal] = useState(null);
      const [archivesOpen, setArchivesOpen] = useState(false);
      const alive = useLifetime();
      useEffect(() => {
        const controller = new AbortController();
        api('/workbench?id=' + encodeURIComponent(sessionId), { signal: controller.signal })
          .then(v => { if (!controller.signal.aborted) setData(v); })
          .catch(e => { if (!controller.signal.aborted) setError(e.message); });
        return () => controller.abort();
      }, [sessionId, reloadKey]);
      const run = async task => {
        if (busy) return; setBusy(true); setError(''); setNotice('');
        try { await task(); } catch (e) { if (alive.current) setError(e.message); }
        finally { if (alive.current) setBusy(false); }
      };
      const propose = async input => {
        const result = await post('/workbench/propose', { id: sessionId, ...input });
        if (!alive.current) return;
        setNotice('候选已生成。请核对下方修改前后，再逐项应用。'); setDraft(null); onChanged();
        return result;
      };
      const apply = async candidate => {
        const result = await post('/workbench/apply', { id: sessionId, candidateId: candidate.candidateId });
        if (!alive.current) return;
        setNotice(result.warning || '已应用，原件仍保留。'); onChanged();
        // Business success is separate from native conversation synchronization.
        try { await refreshConversation(sessionId); }
        catch (e) { if (alive.current) setError('内容已保存，左侧同步失败：' + e.message + '。可点击上方“同步左侧”，无需重复应用。'); }
      };
      const search = async offset => {
        const result = await api('/workbench/originals?id=' + encodeURIComponent(sessionId) + '&query=' + encodeURIComponent(query) + '&offset=' + offset);
        if (alive.current) { setOriginals(result); setOriginal(null); setArchivesOpen(true); }
      };
      const read = async (seq, offset = 0, archiveId) => {
        const result = await api('/workbench/originals?id=' + encodeURIComponent(sessionId) + '&seq=' + seq + '&offset=' + offset + (archiveId ? '&archiveId=' + encodeURIComponent(archiveId) : ''));
        if (alive.current) setOriginal(previous => ({ ...result, text: offset ? (previous?.seq === seq ? previous.text : '') + result.text : result.text }));
      };
      if (!data) return h('div', { style: sty.help }, error || '正在读取记忆工作台…');
      const rows = data.rows, memories = rows.filter(r => r.canCompact), tools = rows.filter(r => r.tool);
      const pending = data.candidates.filter(c => c.status === 'pending');
      const from = rows.findIndex(r => r.seq === draft?.startSeq), to = rows.findIndex(r => r.seq === draft?.endSeq);
      const selected = from >= 0 && to >= from ? rows.slice(from, to + 1) : [];
      const blocked = selected.some(r => !r.canCompact);
      const validSelection = selected.length > 0 && !blocked;
      const names = { message: '消息修改', summary: '摘要修改', compress: '局部压缩', 'tool-trim': '工具输出裁剪', 'tool-restore': '工具原件恢复', recall: '补回历史正文', 'field-restore': '字段恢复' };
      const ranges = data.compressionRanges ?? [];
      const choose = kind => setDraft({ kind, expectRevision: data.contentRevision, startSeq: ranges[0]?.startSeq ?? memories[0]?.seq, endSeq: ranges[0]?.endSeq ?? memories[0]?.seq, seq: tools[0]?.seq, text: '', head: 1200, tail: 400 });
      const select = (value, options, change, label) => h('select', { 'aria-label': label, value: value ?? '', disabled: busy, style: sty.input, onChange: e => change(Number(e.target.value)) },
        options.map(r => h('option', { key: r.seq, value: r.seq }, '#' + r.seq + ' · ' + (r.checkpoint ? '摘要' : r.role || r.type) + ' · ' + r.preview.slice(0, 50))));
      return h('div', null,
        h('div', { style: sty.card }, h('div', { style: sty.cardHead }, '记忆工作台'),
          h('div', { style: { padding: 8 } },
            h('div', { style: sty.help }, '先起草 → 核对修改前后 → 逐项应用。起草不会改变发给模型的上下文。数字为估算 tokens。'),
            h('div', { style: sty.row },
              h('button', { style: sty.btn, disabled: busy || !memories.length, onClick: () => choose('compress') }, '局部压缩'),
              h('button', { style: sty.btn, disabled: busy || !tools.length, onClick: () => choose('tool-trim') }, '裁剪工具输出'),
              h('button', { style: sty.btn, disabled: busy, onClick: () => run(() => search(0)) }, '找回原件')),
            h('div', { style: sty.dim }, '普通消息和思考在“有效上下文”编辑；压缩后的摘要在“生效摘要”编辑。'))),
        error && h('div', { style: sty.err, role: 'alert' }, error),
        notice && h('div', { style: sty.success, role: 'status' }, notice),
        draft && ['compress', 'tool-trim'].includes(draft.kind) && h('div', { style: sty.card }, h('div', { style: sty.cardHead }, names[draft.kind]), h('div', { style: { padding: 8 } },
          draft.kind === 'compress' ? h('div', null,
            ranges.length > 0 && h('label', null, '快捷选择完整可压缩区间',
              h('select', { style: sty.input, 'aria-label': '合法压缩区间', value: ranges.findIndex(r => r.startSeq === draft.startSeq && r.endSeq === draft.endSeq), disabled: busy,
                onChange: e => { const r = ranges[Number(e.target.value)]; if (r) setDraft({ ...draft, startSeq: r.startSeq, endSeq: r.endSeq }); } },
                h('option', { value: -1 }, '自定义起止位置'), ...ranges.map((r, i) => h('option', { key: i, value: i }, '#' + r.startSeq + ' → #' + r.endSeq + ' · ' + r.members.length + ' 条 · 约 ' + r.tokens + ' tokens')))),
            h('label', null, '从这条开始', select(draft.startSeq, memories, startSeq => setDraft({ ...draft, startSeq }), '压缩起点')),
            h('label', null, '到这条结束', select(draft.endSeq, memories, endSeq => setDraft({ ...draft, endSeq }), '压缩终点')),
            h('div', { style: sty.help }, '包含两端的连续区间；区间外原文保留。遇到系统、工具调用或附件时会拒绝提交，不会悄悄跳过。'),
            h('div', { style: sty.dim }, '选中 ' + selected.length + ' 条 · 约 ' + selected.reduce((n, r) => n + r.tokens, 0) + ' tokens；区间外保留 ' + (rows.length - selected.length) + ' 条。'),
            h('details', { style: sty.details }, h('summary', null, '查看选区成员'), ...selected.map(r => h('div', { key: r.seq, style: sty.help }, '#' + r.seq + ' · ' + (r.checkpoint ? '摘要' : r.role || r.type) + (r.canCompact ? '' : ' · 受保护或含工具/附件，不能加入此摘要选区')))),
            onAssistant && h('button', { style: sty.btn, disabled: busy || !validSelection, onClick: () => onAssistant('请对当前会话的连续选区 #' + draft.startSeq + ' 到 #' + draft.endSeq + ' 起草局部压缩候选。先读完选区正文和思考，保留事实、约束、未完成事项及指代，区间外不改。只调用 propose_memory，等我审核，不直接应用。' + (draft.text.trim() ? '\n我已写的摘要草稿，可参考：\n' + draft.text : '')) }, '让助手起草此选区'),
            (!selected.length || blocked) && h('div', { style: sty.err }, blocked ? '区间包含受保护或非纯文本节点，请调整起止位置。' : '终点必须在起点之后（可只选一条）。'),
            h('textarea', { 'aria-label': '局部摘要', style: sty.ta, value: draft.text, placeholder: '写下这段历史需要保留的事实、约束和进度…', onChange: e => setDraft({ ...draft, text: e.target.value }) }))
          : h('div', null,
            select(draft.seq, tools, seq => setDraft({ ...draft, seq }), '待裁剪工具结果'),
            h('div', { style: sty.help }, '保留首尾文本，附件与工具调用编号不变。原文仍可检索恢复。'),
            ...['head', 'tail'].map(field => h('label', { key: field }, field === 'head' ? '保留开头字符数' : '保留结尾字符数', h('input', { 'aria-label': field === 'head' ? '开头字符数' : '结尾字符数', type: 'number', min: 0, max: 50000, style: sty.input, value: draft[field], onChange: e => setDraft({ ...draft, [field]: Number(e.target.value) }) })))),
          draft.expectRevision !== data.contentRevision && h('div', { style: sty.err }, '会话已有变化，草稿保留；请复制内容后重新选择操作。'),
          h('div', { style: sty.row }, h('button', { style: sty.primary, disabled: busy || draft.expectRevision !== data.contentRevision || (draft.kind === 'compress' && (!validSelection || !draft.text.trim())), onClick: () => run(() => propose(draft)) }, '生成审核候选'),
            h('button', { style: sty.btn, disabled: busy, onClick: () => setDraft(null) }, '取消起草')))),
        h('div', { style: sty.cardHead }, '待审核 · ' + pending.length),
        !pending.length && h('div', { style: sty.help }, '还没有待审核候选。'),
        ...pending.map((c, index) => h('details', { key: c.candidateId, open: index === 0, style: sty.card },
          h('summary', { style: { ...sty.cardHead, display: 'list-item', cursor: 'pointer' } }, names[c.kind], ' · #' + c.members.join(', #'), ' · ' + c.tokensBefore + ' → ' + c.tokensAfter + ' tokens'),
          h('div', { style: { padding: 8 } }, h('div', { style: sty.help }, c.reason),
            h('div', { style: sty.dim }, '选区估算：' + c.tokensBefore + ' → ' + c.tokensAfter + ' tokens'),
            h('details', { style: sty.details }, h('summary', null, '修改前'), h('pre', { style: sty.pre }, c.before)),
            h('details', { open: true, style: sty.details }, h('summary', null, '应用后'), h('pre', { style: sty.pre }, c.after)),
            h('div', { style: sty.row }, h('button', { style: sty.primary, disabled: busy, onClick: () => run(() => apply(c)) }, '应用此候选'),
              h('button', { style: sty.btn, disabled: busy, onClick: () => run(async () => { await post('/workbench/reject', { id: sessionId, candidateId: c.candidateId }); if (alive.current) onChanged(); }) }, '拒绝'))))),
        h('details', { style: sty.details, open: archivesOpen, onToggle: e => setArchivesOpen(e.currentTarget.open) }, h('summary', null, '检索历史原件（归档只读，按需补回）'),
          h('input', { 'aria-label': '搜索历史原件', style: sty.input, value: query, placeholder: '搜索正文或思考，留空列出全部原件', onChange: e => setQuery(e.target.value) }),
          h('button', { style: sty.btn, disabled: busy, onClick: () => run(() => search(0)) }, '搜索原件'),
          originals && h('div', null, h('div', { style: sty.help }, '共 ' + originals.total + ' 条，当前页 ' + ((originals.total ? originals.offset + 1 : 0)) + '–' + (originals.offset + originals.items.length)),
            ...originals.items.map(r => h('div', { key: r.archiveId ?? r.seq, style: sty.card }, h('div', { style: sty.cardHead }, '#' + r.seq + ' · ' + r.role + ' · ' + (r.accessLabel ?? (r.active ? '当前生效' : '归档只读')), h('button', { style: sty.btn, disabled: busy, onClick: () => run(() => read(r.seq, 0, r.archiveId)) }, '查看原件')), h('pre', { style: sty.pre }, r.preview))),
            originals.nextOffset !== null && h('button', { style: sty.btn, disabled: busy, onClick: () => run(() => search(originals.nextOffset)) }, '下一页原件')),
          original && h('div', { style: sty.card }, h('div', { style: sty.cardHead }, '原件 #' + original.seq + (original.archiveId ? ' · 裁剪前快照' : '')), h('pre', { style: { ...sty.pre, maxHeight: 400 } }, original.text),
            original.nextOffset !== null && h('button', { style: sty.btn, disabled: busy, onClick: () => run(() => read(original.seq, original.nextOffset, original.archiveId)) }, '继续读取原件'),
            h('div', { style: sty.help }, original.accessLabel),
            onOpen && (original.editable || original.summarySeq != null) && h('button', { style: sty.btn, onClick: () => onOpen(original.editable ? original.seq : original.summarySeq) }, original.editable ? original.editKind === 'summary' ? '编辑生效摘要' : '编辑当前消息' : '编辑承接摘要'),
            h('div', { style: sty.row }, original.tool ? h('button', { style: sty.btn, disabled: busy, onClick: () => setDraft({ kind: 'tool-restore', sourceSeq: original.seq, sourceCandidateId: original.archiveId, seq: tools.find(t => t.toolCallId === original.toolCallId)?.seq, expectRevision: data.contentRevision }) }, '选择工具恢复目标')
              : !original.active && h('button', { style: sty.btn, disabled: busy, onClick: () => run(() => propose({ kind: 'recall', seq: original.seq, expectRevision: data.contentRevision })) }, '起草补回正文')))),
        draft?.kind === 'tool-restore' && h('div', { style: sty.card }, h('div', { style: sty.cardHead }, '恢复工具原件 #' + draft.sourceSeq), select(draft.seq, tools, seq => setDraft({ ...draft, seq }), '工具恢复目标'), h('button', { style: sty.btn, disabled: busy || draft.seq === undefined, onClick: () => run(() => propose(draft)) }, '预览恢复'), h('button', { style: sty.btn, disabled: busy, onClick: () => setDraft(null) }, '取消恢复')),
        h('details', { style: sty.details }, h('summary', null, '已处理候选 · 按字段恢复'),
          ...data.candidates.filter(c => c.status !== 'pending').slice().reverse().map(c => h('div', { key: c.candidateId, style: sty.card }, h('div', { style: sty.cardHead }, names[c.kind] + ' · #' + c.members.join(', #') + ' · ' + (c.status === 'applied' ? '已应用' : '已拒绝')),
            c.status === 'applied' && c.canRestore && !c.kind.startsWith('tool-') && h('div', { style: sty.row }, ...['body', ...(c.kind === 'summary' ? [] : ['thinking'])].map(field => h('button', { key: field, style: sty.btn, disabled: busy, onClick: () => run(() => propose({ kind: 'field-restore', seq: c.seq, sourceCandidateId: c.candidateId, fields: [field], expectRevision: data.contentRevision })) }, field === 'body' ? '起草恢复此前正文' : '起草恢复此前思考')))))));
    }

    function EditorPanel(props) {
      const sessionId = props?.sessionId ?? props?.session?.id ?? currentSessionId();
      const [tab, setTab] = useState("context");
      const [reloadKey, setReloadKey] = useState(0);
      const [syncError, setSyncError] = useState("");
      const [focusSeq, setFocusSeq] = useState(null);
      const [summarySeq, setSummarySeq] = useState(null);
      const [visited, setVisited] = useState(['context']);
      const [taskDraft, setTaskDraft] = useState(null);
      const alive = useLifetime();
      const onChanged = useCallback(() => { setReloadKey((k) => k + 1); window.dispatchEvent(new Event('session-editor:changed')); }, []);
      const selectTab = t => { setVisited(v => v.includes(t) ? v : [...v, t]); setTab(t); };
      const onOpen = (seq) => { setFocusSeq(seq); selectTab("context"); };
      const onCoverage = (seq) => { setSummarySeq(seq); selectTab("coverage"); };
      useEffect(() => { setTaskDraft(null); setFocusSeq(null); setSummarySeq(null); setSyncError(''); setVisited(['context']); setTab('context'); }, [sessionId]);
      const onAssistant = text => { setTaskDraft({ text, sessionId }); selectTab('assistant'); };
      const tabButton = t => h("button", { key: t, style: { ...sty.tab, ...(tab === t ? sty.tabOn : {}) }, 'aria-pressed': tab === t,
        onClick: () => { selectTab(t); setFocusSeq(null); setSummarySeq(null); } },
        { context: "有效上下文", workbench: "记忆工作台", coverage: "覆盖关系", summary: "生效摘要", history: "原始事件", assistant: "记忆助手" }[t]);
      if (!sessionId) return h("div", { style: sty.dim }, "没有活动会话");
      return h("div", { style: sty.root },
        h("div", { style: sty.tabs },
          ["context", "summary", "workbench", "assistant"].map(tabButton)),
        h("div", { style: sty.row },
          h("button", { style: sty.btn, onClick: onChanged }, "刷新"),
          h("span", { style: sty.help }, "归档原文只读 · 生效摘要可编辑 · 保存自动同步")),
        h("details", { style: sty.details }, h("summary", null, "更多工具与使用说明"),
          h('div', { style: sty.row }, ['coverage', 'history'].map(tabButton),
            h("button", { style: sty.btn, onClick: async () => { const target = sessionId; setSyncError(""); try { await refreshConversation(target); } catch (e) { if (alive.current && target === currentSessionId()) setSyncError(e.message); } } }, "同步左侧")),
          h("div", { style: sty.row },
            h("span", { style: { color: '#475467', background: '#F2F4F7', padding: '3px 6px', borderRadius: 4 } }, "灰 · 整条已被摘要替代"),
            h("span", { style: { color: '#067647', background: '#ECFDF3', padding: '3px 6px', borderRadius: 4 } }, "绿 · 整条未被摘要覆盖"),
            h("span", { style: { color: '#B54708', background: '#FFFAEB', padding: '3px 6px', borderRadius: 4 } }, "橙 · 附带保留思考"),
            h("span", { style: { color: '#175CD3', background: '#EFF8FF', padding: '3px 6px', borderRadius: 4 } }, "蓝 · 生效摘要")),
          h("div", { style: sty.help }, "DSH 按整条消息替代，正文和思考不会在同一节点中一半被覆盖、一半保留。橙色是思考提示，不是半覆盖。思考是否实际回传取决于模型适配器。摘要不保证逐句保留原文。"),
          h('strong', null, "这些内容会发给 AI 吗？"),
          h("div", { style: sty.help }, "系统指令是 DSH 的规则；压缩记忆替代已压缩的旧消息；助手回复是保留的对话。改摘要不会自动改掉旧回复；只改正文也会保留旧思考。矛盾内容可搜索后逐条编辑，按需清除本条旧思考，或移出上下文。下一轮还会加入新问题、工具和运行环境；思考是否回传由模型适配器决定。#编号是原始日志位置，不是发送顺序。")),
        syncError && h("div", { style: sty.err }, syncError),
        h("div", { style: { ...sty.scroll, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
          // Retain visited views so navigating to the assistant does not destroy drafts.
          ...visited.map(t => h('div', { key: sessionId + ':' + t, hidden: tab !== t,
            style: { display: tab !== t ? 'none' : t === 'assistant' ? 'flex' : 'block', flexDirection: 'column', flex: 1, minHeight: 0, overflowY: t === 'assistant' ? 'hidden' : 'auto' } },
            t === 'assistant' && h(MemoryAssistant, { sessionId, SessionProvider: props.SessionProvider, renderSlot: props.renderSlot, onChanged, taskDraft, onReview: () => selectTab('workbench') }),
            t === "workbench" && h(WorkbenchView, { sessionId, reloadKey, onChanged, onAssistant, onOpen }),
            t === "context" && h(ContextView, { sessionId, reloadKey, onChanged, focusSeq, onCoverage }),
            t === "coverage" && h(CoverageView, { key: summarySeq, sessionId, reloadKey, summarySeq, onOpen }),
            t === "summary" && h(SummaryView, { sessionId, reloadKey, onChanged }),
            t === "history" && h(HistoryView, { sessionId, reloadKey })))));
      }


    function currentSessionId() {
      try {
        const nativeId = hostUiSession?.current.value.key;
        if (nativeId) return nativeId;
        const m = location.hash.match(/session-([0-9a-f-]{36})/) ?? location.pathname.match(/session-([0-9a-f-]{36})/);
        return m ? "session-" + m[1] : null;
      } catch { return null; }
    }

    /* ---------------- 样式 ---------------- */
    const sty = {
      root: { fontSize: 13, padding: 10, height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", overflow: "hidden" },
      scroll: { overflowY: "auto", flex: 1, minHeight: 0 },
      tabs: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 },
      tab: { border: "1px solid #d0d5dd", background: "#fff", borderRadius: 8, minHeight: 34, padding: "6px 10px", cursor: "pointer", fontSize: 12 },
      tabOn: { background: "#1C1822", color: "#fff", borderColor: "#1C1822" },
      row: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "6px 0" },
      spacer: { flex: 1 },
      card: { border: "1px solid #e4e7ec", borderRadius: 10, margin: "8px 0", overflow: "hidden" },
      cardHead: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "6px 8px", background: "#f8fafc", borderBottom: "1px solid #eef2f6" },
      tag: { color: "#fff", borderRadius: 6, padding: "1px 7px", fontSize: 10, fontWeight: 600 },
      btn: { border: "1px solid #d0d5dd", background: "#fff", borderRadius: 6, minHeight: 32, padding: "6px 10px", cursor: "pointer", fontSize: 12 },
      primary: { border: 0, background: "#1C1822", color: "#fff", borderRadius: 6, minHeight: 34, padding: "6px 12px", cursor: "pointer", fontSize: 12 },
      ta: { width: "100%", boxSizing: "border-box", fontFamily: "monospace", fontSize: 13, lineHeight: 1.6, padding: 8, border: "1px solid #d0d5dd", borderRadius: 6, minHeight: 180, resize: "vertical" },
      pre: { margin: 0, padding: "10px 12px", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "12px/1.7 monospace", maxHeight: 260, overflow: "auto", color: "#344054" },
      details: { padding: "8px", color: "#667085", fontSize: 12, cursor: "pointer" },
      help: { color: "#667085", fontSize: 12, lineHeight: 1.6, padding: "4px 0" },
      success: { color: "#067647", background: "#ecfdf3", borderRadius: 6, padding: 8, fontSize: 11 },
      dim: { color: "#667085", fontSize: 11 },
      err: { color: "#B42318", fontSize: 11, padding: 8 },
      input: { width: "100%", boxSizing: "border-box", padding: "5px 8px", border: "1px solid #d0d5dd", borderRadius: 6, fontSize: 12, marginBottom: 6 },
      mono: { fontFamily: "monospace", color: "#667085", fontSize: 10 },
      histRow: { display: "flex", gap: 6, alignItems: "center", padding: "3px 4px", borderBottom: "1px solid #f2f4f7" },
    };

    const EDITOR_KIND = "session-editor";
    const EDITOR_ID = "@shuangbai/dsh-session-editor";

    function apply(ctx) {
      hostSessions = ctx.sessions;
      hostUiSession = ctx.uiSession;
      ctx.effect(() => installChatCoverage(ctx), 'session-editor: chat coverage labels');
      try {
        // 1) tab 类型注册（宿主 tab 系统据此知道该 kind 的定义与 guide 菜单项）
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: EDITOR_ID,
          kind: EDITOR_KIND,
          priority: "builtin",
          title: () => "编辑器",
          guide: [{
            id: "session-editor",
            order: 90,
            title: () => "编辑器",
            description: () => "查看并编辑模型上下文 / 摘要 / 历史",
          }],
        }), "session-editor: sidebar type");
        // 2) tab body / title slot（body props 经 hookContext 注入；会话 id 从 useTabNavigation 拿不到时回退 URL）
        ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
          name: "sidebar.right.pane.tab",
          key: EDITOR_ID,
          children: { 'session-editor.assistant': { kind: 'single', scope: 'session' } },
        }, EditorPanel)), "session-editor: tab body");
        ctx.effect(() => ctx.slots.inject('session-editor.assistant', () => ctx.slots.register({
          name: 'session-editor.assistant',
        }, function AssistantConversation(props) {
          return props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false });
        })), 'session-editor: embedded conversation');
        ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
          name: "sidebar.right.pane.tab.title",
          key: EDITOR_ID,
        }, function Title() { return h("span", null, "✎ 编辑器"); })), "session-editor: tab title");
      } catch {
        // slot 不可用时静默（API 仍可用）
      }
    }

    return { apply, inject: ["slots", "sidebarRightTabs", "sidebarRight", "sessions", "uiSession", "uiConversation", "locale"] };
  },
});
