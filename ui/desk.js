// The Desk tab of the side panel: Tether's own editors (Slate, Ledger, Folio, Tack), each a sealed page under
// ui/desk/. This file is the go-between: it shows the pages, passes their file requests to the Mac side
// (desk.py), keeps them in Tether's colors, and carries Claude's `desk` tool requests to them.
const DeskHost = (() => {
  const APPS = [["slate", "Slate", "Text and code"], ["ledger", "Ledger", "Spreadsheets"], ["folio", "Folio", "Documents"], ["tack", "Tack", "Sticky notes"]];
  const frames = {};  // app -> { f, ready, go, title, cmds }
  let cur = localStorage.getItem("wb.deskApp") || "slate", built = false, cid = 0;
  const box = () => $("#desk-body");

  function themeMsg() {
    const cs = getComputedStyle(document.body), v = k => cs.getPropertyValue(k).trim();
    return { deskTheme: { dark: document.body.classList.contains("dark"), scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fs-scale")) || 1,
      vars: { "--text": v("--text"), "--text-2": v("--text-2"), "--text-3": v("--text-3"), "--accent": v("--accent"), "--accent-fill": v("--accent-fill"), "--accent-hover": v("--accent-hover"),
        "--on-accent": v("--on-accent"), "--accent-soft": v("--accent-soft"), "--accent-line": v("--accent-line") } } };
  }
  const post = (fr, msg) => fr.f.contentWindow?.postMessage(msg, "*");
  function build() {
    if (built) return;
    built = true;
    box().innerHTML = `<div class="desk-head"><div class="seg desk-apps">${APPS.map(a => `<button data-app="${a[0]}" title="${a[2]}"><span class="dn">${a[1]}</span><span class="dd"></span></button>`).join("")}</div>
      <span class="spacer"></span>
      <button class="icb" id="desk-full" title="Full window"><svg class="i" viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg></button></div><div class="desk-stage"></div>`;
    box().querySelectorAll("[data-app]").forEach(b => b.onclick = () => show(b.dataset.app));
    $("#desk-full").onclick = () => { const on = document.body.classList.toggle("desk-full"); $("#desk-full").title = on ? "Back to chat" : "Full window"; applyPanelW(); };
    let t = 0;
    const again = () => { clearTimeout(t); t = setTimeout(() => Object.values(frames).forEach(fr => post(fr, themeMsg())), 60); };
    new MutationObserver(again).observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    new MutationObserver(again).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  }
  function ensure(app) {
    if (frames[app]) return frames[app];
    build();
    const fr = frames[app] = { f: el("iframe", "desk-frame"), title: {}, cmds: new Map() };
    fr.ready = new Promise(ok => { fr.go = ok; });
    fr.f.setAttribute("sandbox", "allow-scripts");  // its own null origin: no network, no reach into Tether
    fr.f.hidden = app !== cur;
    box().querySelector(".desk-stage").appendChild(fr.f);
    api().desk_page(app).then(r => {
      if (r.error) { fr.f.remove(); delete frames[app]; toast(r.error, "error"); return; }
      fr.f.srcdoc = r.html;
    });
    return fr;
  }
  function show(app) {
    if (app && APPS.some(a => a[0] === app)) cur = app;
    localStorage.setItem("wb.deskApp", cur);
    build();
    const fr = ensure(cur);
    for (const [k, x] of Object.entries(frames)) x.f.hidden = k !== cur;
    box().querySelectorAll("[data-app]").forEach(b => b.classList.toggle("on", b.dataset.app === cur));
    fr.ready.then(() => { if (cur === app || !app) fr.f.focus(); });
  }
  // from the toolbox, a menu or Claude: the panel on the Desk tab, on this editor
  function open(app) { setTab("desk"); togglePanel(true); show(app); }

  function cmd(app, action, args, ms = 25000) {
    const fr = ensure(app);
    return fr.ready.then(() => new Promise(ok => {
      const id = ++cid;
      const t = setTimeout(() => { fr.cmds.delete(id); ok({ error: "The editor didn't answer in time." }); }, ms);
      fr.cmds.set(id, r => { clearTimeout(t); ok(r); });
      post(fr, { deskCmd: { cid: id, action, args: args || {} } });
    }));
  }
  function mark(app) {  // the dot beside an editor's name: it holds unsaved changes
    const b = box().querySelector(`[data-app="${app}"] .dd`);
    if (b) b.classList.toggle("on", !!frames[app]?.title.dirty);
  }
  async function handle(fr, app, d) {
    const a = d.args || {};
    switch (d.op) {
      case "hello": post(fr, themeMsg()); return;
      case "ready": post(fr, themeMsg()); fr.go(); return;
      case "title": fr.title = a; mark(app); return;
      case "cmdReply": { const w = fr.cmds.get(a.cid); if (w) { fr.cmds.delete(a.cid); w(a.result); } return; }
      case "open": return api().desk_open(app);
      case "read": return api().desk_read(app, a.path);
      case "save": return api().desk_save(app, a.path, a.data);
      case "saveTo": return api().desk_save_to(app, a.path, a.data);
      case "saveAs": return api().desk_save_as(app, a.name, a.data, a.types);
      case "stat": return api().desk_stat(a.path);
      case "draftLoad": return api().desk_draft_load(app);
      case "draftSave": return api().desk_draft_save(app, a.draft);
      case "reveal": return api().reveal(a.path);
      case "image": return api().desk_image();
      case "openUrl": if (/^(https?:|mailto:)/i.test(a.url || "")) api().open_url(a.url); return { ok: true };
      case "toChat": {
        if (!state.active) { toast("Open a chat first, then ask Claude from here."); return { ok: false }; }
        const t = $("#input"), text = String(a.text || "");
        t.value = (t.value.trim() ? t.value.replace(/\s*$/, "\n") : "") + text;
        t.dispatchEvent(new Event("input", { bubbles: true }));
        if (document.body.classList.contains("desk-full")) { document.body.classList.remove("desk-full"); applyPanelW(); }
        t.focus(); t.setSelectionRange(t.value.length, t.value.length);
        return { ok: true };
      }
    }
    throw new Error("Unknown request.");
  }
  addEventListener("message", async e => {
    const d = e.data?.desk;
    if (!d) return;
    const hit = Object.entries(frames).find(([, fr]) => fr.f.contentWindow === e.source);
    if (!hit) return;
    const [app, fr] = hit;
    let value, error;
    try { value = await handle(fr, app, d); } catch (err) { error = String(err.message || err); }
    if (d.id) post(fr, { deskReply: { id: d.id, value, error } });
  });

  // Claude's desk tool (wb_mcp.py -> desk.py -> here). Opening or changing something brings the Desk into view.
  async function request(ev) {
    let out;
    try {
      const app = String(ev.app || "").toLowerCase();
      if (ev.action === "state" && !app) {
        const all = await Promise.all(APPS.map(a => cmd(a[0], "state")));
        out = { showing: state.panel && state.tab === "desk" ? cur : "the Desk is closed", editors: all };
      } else if (!APPS.some(a => a[0] === app)) out = { error: "Pass app: slate, ledger, folio or tack." };
      else {
        if (ev.action === "open" || ev.action === "write") open(app);
        out = await cmd(app, ev.action, { ...(ev.args || {}) });
      }
    } catch (e) { out = { error: String(e.message || e) }; }
    api().desk_reply(ev.id, out);
  }
  return { APPS, open, show, request, cmd };
})();
