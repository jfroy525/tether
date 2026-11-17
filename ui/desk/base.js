// Shared by the Desk's editors. Each editor page defines `App` (what its file is and how to load and dump it) and
// calls Desk.start(App). Everything that touches a file goes through Tether with Desk.call(); this page is sealed.
const Desk = (() => {
  const app = document.body.dataset.app;
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const IC = {
    chev: '<svg class="chev" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3"/></svg>',
    claude: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
  };

  // ----- talking to Tether
  let seq = 0; const waiting = new Map();
  const call = (op, args) => new Promise((ok, no) => { const id = ++seq; waiting.set(id, [ok, no]); parent.postMessage({ desk: { app, id, op, args: args || {} } }, "*"); });
  addEventListener("message", async e => {
    const d = e.data || {};
    if (d.deskReply) { const w = waiting.get(d.deskReply.id); if (!w) return; waiting.delete(d.deskReply.id); d.deskReply.error ? w[1](new Error(d.deskReply.error)) : w[0](d.deskReply.value); }
    else if (d.deskTheme) theme(d.deskTheme);
    else if (d.deskCmd) {  // from Tether's header or from Claude's desk tool
      let out;
      try { out = await command(d.deskCmd.action, d.deskCmd.args || {}); } catch (err) { out = { error: String(err.message || err) }; }
      parent.postMessage({ desk: { app, id: 0, op: "cmdReply", args: { cid: d.deskCmd.cid, result: out ?? { ok: true } } } }, "*");
    }
  });
  function theme(t) {
    const r = document.documentElement;
    r.classList.toggle("dark", !!t.dark);
    for (const [k, v] of Object.entries(t.vars || {})) if (v) r.style.setProperty(k, v);
    r.style.setProperty("--scale", t.scale || 1);
    A?.onTheme?.(t);
  }

  // ----- small UI pieces
  function toast(text, ms = 2200) {
    document.querySelectorAll(".toast").forEach(n => n.remove());
    const t = el("div", "toast"); t.textContent = text; document.body.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 320); }, ms);
  }
  let openMenu = null;
  function closeMenu() { openMenu?.remove(); openMenu = null; }
  function menu(anchor, items) {  // items: {label, key, run, off} | "-" | {head}
    closeMenu();
    const m = el("div", "menu");
    for (const it of items) {
      if (!it) continue;
      if (it === "-") { m.appendChild(el("div", "ms")); continue; }
      if (it.head) { const h = el("div", "mh"); h.textContent = it.head; m.appendChild(h); continue; }
      const r = el("div", "mi" + (it.off ? " off" : ""), `<span></span>${it.key ? `<span class="k">${esc(it.key)}</span>` : ""}`);
      r.firstChild.textContent = it.label;
      if (it.swatch) r.insertAdjacentHTML("afterbegin", `<span class="sw" style="background:${esc(it.swatch)}"></span>`);
      r.onclick = () => { closeMenu(); it.run(); };
      m.appendChild(r);
    }
    document.body.appendChild(m);
    const a = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y };
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(6, Math.min(innerWidth - w - 6, a.left)) + "px";
    m.style.top = (a.bottom + 4 + h > innerHeight - 6 ? Math.max(6, a.top - h - 4) : a.bottom + 4) + "px";
    openMenu = m;
    return m;
  }
  addEventListener("mousedown", e => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
  addEventListener("blur", closeMenu);
  function ask(question, buttons, input) {  // buttons: [[label, value, "primary"?]]; resolves with the value (or the typed text)
    return new Promise(done => {
      const v = el("div", "veil"), box = el("div", "ask", `<div class="q"></div>${input != null ? '<input class="field">' : ""}<div class="row"></div>`);
      box.querySelector(".q").innerHTML = question;
      const inp = box.querySelector("input"); if (inp) inp.value = input;
      const fin = val => { v.remove(); done(val); };
      for (const [label, value, kind] of buttons) {
        const b = el("button", "btn" + (kind ? " " + kind : "")); b.textContent = label;
        b.onclick = () => fin(inp && value === true ? inp.value : value);
        box.querySelector(".row").appendChild(b);
      }
      v.onmousedown = e => { if (e.target === v) fin(null); };
      v.onkeydown = e => { if (e.key === "Escape") fin(null); if (e.key === "Enter" && inp) fin(inp.value); e.stopPropagation(); };
      v.appendChild(box); document.body.appendChild(v);
      (inp || box.querySelector(".btn.primary") || box.querySelector(".btn")).focus(); inp?.select();
    });
  }

  // ----- the file an editor has open. An editor with several (Slate's tabs) swaps `doc` itself with Desk.use().
  let A = null;
  let doc = { path: "", name: "", dirty: false, mtime: 0 };
  const blankDoc = () => ({ path: "", name: "", dirty: false, mtime: 0 });
  const shown = d => d.name || "Untitled";
  function paint() {
    const n = $("#doc-name");
    if (n) { n.querySelector(".t").textContent = shown(doc); n.classList.toggle("dirty", doc.dirty); n.title = doc.path || "Not saved yet"; }
    parent.postMessage({ desk: { app, id: 0, op: "title", args: { name: shown(doc), dirty: doc.dirty, path: doc.path } } }, "*");
    A.onDoc?.(doc);
  }
  let draftT = 0;
  function touch(dirty = true) {  // the editor calls this on every change
    if (dirty && !doc.dirty) { doc.dirty = true; paint(); }
    clearTimeout(draftT); draftT = setTimeout(saveDraft, 1200);
  }
  function saveDraft() { clearTimeout(draftT); try { call("draftSave", { draft: A.draft() }); } catch (e) {} }
  async function okToDrop(what) {
    if (!doc.dirty) return true;
    const r = await ask(`<b>${esc(shown(doc))}</b> has changes that aren't saved.`, [["Cancel", null], ["Don't save", "drop"], ["Save", "save", "primary"]]);
    if (r === "save") return await save();
    return r === "drop";
  }
  async function fresh() {
    if (!A.many && !(await okToDrop())) return;
    A.blank(); if (!A.many) doc = blankDoc();
    paint(); saveDraft();
  }
  async function load(r) {  // r: what Tether read ({path, name, mtime, text | b64 | html})
    if (!r) return false;
    if (r.error) { toast(r.error, 4000); return false; }
    const d = { path: r.path, name: r.name, dirty: false, mtime: r.mtime };
    try { await A.load(r, d); } catch (e) { toast(`Couldn't open ${r.name}: ${e.message || e}`, 4000); return false; }
    if (!A.many) doc = d;
    paint(); saveDraft(); if (drawer?.classList.contains("on")) listFiles(listing?.dir);
    return true;
  }
  async function open() {
    if (!A.many && !(await okToDrop())) return;
    await load(await call("open"));
  }
  const extOf = n => (/\.[^./\\]+$/.exec(n || "") || [""])[0].toLowerCase();
  async function save(as) {
    const ext = extOf(doc.path);
    if (as || !doc.path || (A.canSave && !A.canSave(ext))) return saveAs();
    let r;
    try { r = await call("save", { path: doc.path, data: await A.dump(ext) }); } catch (e) { r = { error: e.message }; }
    if (!r || r.error) { toast(r?.error || "Couldn't save.", 4000); return false; }
    doc.mtime = r.mtime; doc.dirty = false; paint(); saveDraft(); toast("Saved"); if (drawer?.classList.contains("on")) listFiles(listing?.dir);
    return true;
  }
  async function saveAs(type) {  // type: one of A.types ([label, ext]); the first is the editor's own
    const t = type || A.types[0], base = (doc.name || "Untitled").replace(/\.[^.]+$/, "");
    let r;
    try { r = await call("saveAs", { name: base + "." + t[1], types: [`${t[0]} (*.${t[1]})`], data: await A.dump("." + t[1]) }); } catch (e) { r = { error: e.message }; }
    if (!r) return false;
    if (r.error) { toast(r.error, 4000); return false; }
    if (!type || type === A.types[0] || !doc.path) { doc.path = r.path; doc.name = r.name; doc.mtime = r.mtime; doc.dirty = false; }
    paint(); saveDraft(); toast(`Saved ${r.name}`); if (drawer?.classList.contains("on")) listFiles("");
    return true;
  }
  // the file changed on disk (Claude or another app wrote it): take it if nothing is unsaved here, else ask
  let asked = 0;
  async function watch() {
    if (!doc.path || document.hidden) return;
    let s; try { s = await call("stat", { path: doc.path }); } catch (e) { return; }
    if (!s || !s.mtime || s.mtime <= doc.mtime + 0.001 || s.mtime === asked) return;
    const path = doc.path;
    if (!doc.dirty) { const r = await call("read", { path }); if (doc.path === path && !doc.dirty && r && !r.error) { await A.load(r, doc); doc.mtime = r.mtime; paint(); toast(`${doc.name} changed on disk, so it was reloaded`); } return; }
    asked = s.mtime;
    document.querySelectorAll(".notice").forEach(n => n.remove());
    const n = el("div", "notice", `<span><b>${esc(doc.name)}</b> changed on disk.</span><span class="sp"></span><button class="btn" data-a="mine">Keep mine</button><button class="btn" data-a="theirs">Load the new one</button>`);
    n.querySelector("[data-a=mine]").onclick = () => { doc.mtime = s.mtime; n.remove(); };
    n.querySelector("[data-a=theirs]").onclick = async () => { n.remove(); const r = await call("read", { path }); if (r && !r.error && doc.path === path) { await A.load(r, doc); doc.mtime = r.mtime; doc.dirty = false; paint(); } };
    $(".bar").after(n);
  }


  // ----- the Files list: recent files, and the folders you've picked files in. Open, rename, copy, move, delete.
  const FI = {
    files: '<svg viewBox="0 0 24 24"><path d="M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9a1.5 1.5 0 0 0-1.5-1.500H12L10 5H4.500A1.500 1.500 0 0 0 3 6.500z"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9a1.5 1.5 0 0 0-1.5-1.500H12L10 5H4.500A1.500 1.500 0 0 0 3 6.500z"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };
  let drawer = null, listing = null, filter = "";
  const when = t => { const d = new Date(t * 1000), n = new Date(); return d.toDateString() === n.toDateString() ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== n.getFullYear() ? { year: "numeric" } : {}) }); };
  const openPaths = () => A.paths ? A.paths() : doc.path ? [doc.path] : [];
  async function openPath(path) {
    if (A.focus?.(path)) return drawFiles();
    if (!A.many && path === doc.path) return;
    if (!A.many && !(await okToDrop())) return;
    await load(await call("read", { path })); drawFiles();
  }
  // a file was renamed, moved or deleted from the list: whatever has it open follows it, and keeps its text
  function moved(old, r) {
    if (A.repath) A.repath(old, r);
    else if (doc.path === old) { if (r) { doc.path = r.path; doc.name = r.name; doc.mtime = r.mtime; } else { doc.path = ""; doc.dirty = true; } }
    paint(); saveDraft();
  }
  async function fileOp(op, f) {
    let r = null;
    try {
      if (op === "rename") { const name = await ask("Rename", [["Cancel", null], ["Rename", true, "primary"]], f.name); if (!name || name === f.name) return; r = await call("rename", { path: f.path, name }); }
      else if (op === "duplicate") r = await call("duplicate", { path: f.path });
      else if (op === "move") r = await call("move", { path: f.path });
      else if (op === "trash") { if (!(await ask(`Move <b>${esc(f.name)}</b> to the Trash?`, [["Cancel", null], ["Move to Trash", true, "primary"]]))) return; r = await call("trash", { path: f.path }); }
    } catch (e) { r = { error: e.message }; }
    if (!r) return;
    if (r.error) return toast(r.error, 4000);
    if (op === "rename" || op === "move") { moved(f.path, r); toast(op === "rename" ? `Renamed to ${r.name}` : `Moved ${r.name}`); }
    else if (op === "trash") { moved(f.path, null); toast(`${f.name} is in the Trash`); }
    else toast(`Made ${r.name}`);
    await listFiles(op === "move" ? "" : listing?.dir);
  }
  function rowMenu(anchor, f) {
    menu(anchor, [{ label: "Open", run: () => openPath(f.path) }, "-",
      { label: "Rename…", run: () => fileOp("rename", f) }, { label: "Duplicate", run: () => fileOp("duplicate", f) }, { label: "Move to…", run: () => fileOp("move", f) },
      { label: "Show in Finder", run: () => call("reveal", { path: f.path }) }, "-", { label: "Move to Trash", run: () => fileOp("trash", f) }]);
  }
  async function listFiles(dir) { try { listing = await call("files", { dir: dir || "" }); } catch (e) { listing = { error: e.message }; } drawFiles(); }
  function drawFiles() {
    if (!drawer || !listing) return;
    const L = listing, body = drawer.querySelector(".fbody"), open = new Set(openPaths()), q = filter.trim().toLowerCase();
    const hit = n => !q || n.toLowerCase().includes(q);
    body.innerHTML = "";
    const row = (f, kind, sub) => {
      const n = el("div", "frow" + (open.has(f.path) ? " on" : ""), `${kind === "folder" ? FI.folder : FI.file}<span class="fn"></span><span class="fs"></span>${kind === "folder" ? "" : `<button class="ib fm" title="Rename, copy, move or delete">${FI.more}</button>`}`);
      n.querySelector(".fn").textContent = f.name; n.querySelector(".fs").textContent = sub || ""; n.title = f.path;
      n.onclick = e => { if (e.target.closest(".fm")) return rowMenu(e.target.closest(".fm"), f); kind === "folder" ? listFiles(f.path) : openPath(f.path); };
      if (kind !== "folder") n.oncontextmenu = e => { e.preventDefault(); rowMenu({ x: e.clientX, y: e.clientY }, f); };
      body.appendChild(n);
    };
    const rec = (L.recent || []).filter(f => hit(f.name));
    if (rec.length) { body.appendChild(el("div", "fh", "Recent")); rec.forEach(f => row(f, "file", f.where)); }
    if (L.dir) {
      const h = el("div", "fh dir", `${L.up ? `<button class="ib" data-a="up" title="Up one folder">${FI.up}</button>` : ""}<span class="fn"></span>`);
      h.querySelector(".fn").textContent = L.name; h.title = L.dir;
      const u = h.querySelector("[data-a=up]"); if (u) u.onclick = () => listFiles(L.up);
      if ((L.roots || []).length > 1) { h.classList.add("pickable"); h.querySelector(".fn").onclick = () => menu(h, L.roots.map(r => ({ label: r.name, run: () => listFiles(r.path) }))); h.querySelector(".fn").insertAdjacentHTML("beforeend", IC.chev); }
      body.appendChild(h);
      const fo = L.folders.filter(f => hit(f.name)), fi = L.files.filter(f => hit(f.name));
      fo.forEach(f => row(f, "folder")); fi.forEach(f => row(f, "file", when(f.mtime)));
      if (!fo.length && !fi.length) body.appendChild(el("div", "fnone", q ? "Nothing matches." : "No files of this kind here."));
    }
    if (L.error) body.appendChild(el("div", "fnone", esc(L.error)));
    drawer.classList.toggle("bare", !L.dir && !rec.length);
  }
  function toggleFiles(on) {
    const want = on ?? !drawer?.classList.contains("on");
    if (!drawer) {
      drawer = el("div", "files", `<div class="ftop"><input class="field" placeholder="Find" spellcheck="false"><button class="ib" data-a="close" title="Close the list">${FI.x}</button></div><div class="fbody"></div>
        <div class="fbot"><button class="btn" data-a="folder">${FI.folder}<span>Choose folder…</span></button></div>`);
      drawer.querySelector("input").oninput = e => { filter = e.target.value; drawFiles(); };
      drawer.querySelector("input").onkeydown = e => { e.stopPropagation(); if (e.key === "Escape") toggleFiles(false); };
      drawer.querySelector("[data-a=close]").onclick = () => toggleFiles(false);
      drawer.querySelector("[data-a=folder]").onclick = async () => { const r = await call("folder"); if (r) { listing = r; drawFiles(); } };
      $(".grow").appendChild(drawer); drawer.offsetWidth;
      $(".grow").addEventListener("pointerdown", e => { if (drawer.classList.contains("on") && !drawer.contains(e.target)) toggleFiles(false); });  // a click in the file puts the list away
    }
    drawer.classList.toggle("on", want); $("#files-btn")?.classList.toggle("on", want);
    if (want) listFiles(listing?.dir);
  }

  function fileMenu(anchor) {
    menu(anchor, [
      { label: "New", key: "⌘N", run: fresh }, { label: "Open…", key: "⌘O", run: open }, { label: "Files", key: "⇧⌘O", run: () => toggleFiles(true) }, "-",
      { label: "Save", key: "⌘S", run: () => save() }, { label: "Save as…", key: "⇧⌘S", run: () => saveAs() },
      ...(A.types.length > 1 ? ["-", { head: "Export a copy" }, ...A.types.slice(1).map(t => ({ label: `${t[0]} (.${t[1]})`, run: () => saveAs(t) }))] : []),
      ...(doc.path ? ["-", { label: "Rename…", run: () => fileOp("rename", { path: doc.path, name: doc.name }) }, { label: "Duplicate", run: () => fileOp("duplicate", { path: doc.path, name: doc.name }) },
        { label: "Move to…", run: () => fileOp("move", { path: doc.path, name: doc.name }) }, { label: "Show in Finder", run: () => call("reveal", { path: doc.path }) },
        { label: "Move to Trash", run: () => fileOp("trash", { path: doc.path, name: doc.name }) }] : []),
      ...(A.fileMenu ? ["-", ...A.fileMenu()] : []),
    ]);
  }
  const toChat = text => call("toChat", { text });

  // ----- what Claude's desk tool, or Tether, can ask of any editor
  async function command(action, args) {
    if (action === "state") return { app, ...(A.noFiles ? {} : { name: shown(doc), path: doc.path, unsaved: doc.dirty }), ...(A.state?.() || {}) };
    if (A.noFiles && (action === "open" || action === "save")) return { error: "Tack has no files to open or save; Tether keeps the notes itself." };
    if (action === "open") {
      if (!args.path) { if (!A.many && doc.dirty && !args.force) return { error: `${shown(doc)} has unsaved changes. Save it first (action "save"), or pass force: true to drop them.` }; A.blank(); if (!A.many) doc = blankDoc(); paint(); return { ok: true, opened: "a new blank file" }; }
      if (!A.many && doc.dirty && !args.force) return { error: `${shown(doc)} has unsaved changes. Save it first (action "save"), or pass force: true to drop them.` };
      const r = await call("read", { path: args.path });
      return (await load(r)) ? { ok: true, opened: r.name } : { error: r?.error || "Couldn't open it." };
    }
    if (action === "save") {
      if (args.path) {
        const r = await call("saveTo", { path: args.path, data: await A.dump(extOf(args.path)) });
        if (!r || r.error) return { error: r?.error || "Couldn't save." };
        doc.path = r.path; doc.name = r.name; doc.mtime = r.mtime; doc.dirty = false; paint(); saveDraft();
        return { ok: true, saved: r.path };
      }
      if (!doc.path) return { error: "This file has no name yet. Pass a path." };
      return (await save()) ? { ok: true, saved: doc.path } : { error: "Couldn't save." };
    }
    if (action === "read") return await A.read(args);
    if (action === "write") { const r = await A.write(args); if (!r?.error) touch(!A.noFiles); return r ?? { ok: true }; }
    return { error: `Unknown action ${action}.` };
  }

  addEventListener("keydown", e => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || A?.noFiles) return;
    const k = e.key.toLowerCase();
    if (k === "s") { e.preventDefault(); e.shiftKey ? saveAs() : save(); }
    else if (k === "o" && !A.noFiles) { e.preventDefault(); e.shiftKey ? toggleFiles() : open(); }
    else if (k === "n" && !A.noFiles) { e.preventDefault(); fresh(); }
  }, true);

  async function start(App) {
    A = App;
    const n = $("#doc-name"); if (n) n.onclick = () => fileMenu(n);
    if (n && !A.noFiles) { const b = el("button", "ib", FI.files); b.id = "files-btn"; b.title = "Files: recent ones and your folders (⇧⌘O)"; b.onclick = () => toggleFiles(); n.before(b); }
    const c = $("#ask-claude"); if (c) c.onclick = () => toChat(A.forChat());
    parent.postMessage({ desk: { app, id: 0, op: "hello", args: {} } }, "*");  // Tether answers with its colors
    let d = {}; try { d = (await call("draftLoad")) || {}; } catch (e) {}
    try { await A.restore(d); } catch (e) { A.blank(); }
    paint();
    parent.postMessage({ desk: { app, id: 0, op: "ready", args: {} } }, "*");  // only now can Tether or Claude ask for anything
    if (!A.noFiles) setInterval(watch, 2500);
    addEventListener("pagehide", saveDraft);
  }
  return { app, $, el, esc, IC, call, toast, menu, closeMenu, ask, touch, paint, save, saveAs, open, fresh, load, toChat, start, saveDraft, extOf,
    get doc() { return doc; }, use(d) { doc = d; paint(); }, blankDoc };
})();
