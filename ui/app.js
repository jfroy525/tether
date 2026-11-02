// Tether page: sessions sidebar, chats (one per session, kept alive), composer, repo bar and panel.
const $ = s => document.querySelector(s);
const api = () => window.pywebview.api;
const esc = s => window.escapeHtml(String(s ?? ""));

const state = { sessions: [], pinOrder: [], confirmClose: null, showArchived: false, repos: [], settings: {}, hotkeys: {}, groups: [], open: new Map(), active: null, models: [], panel: false,
  tab: "view", repo: {}, dictating: false, circling: false, search: "", expanded: new Set(), openFile: null };

// ---------- helpers ----------
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function ago(t) {
  const s = Date.now() / 1000 - t;
  if (s < 60) return "now"; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`; return new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function toast(text, level) {
  const t = el("div", "t " + (level || ""), esc(text));
  $("#toast").appendChild(t);
  setTimeout(() => t.remove(), level === "error" ? 9000 : 4000);
}
const tilde = p => p && state.home ? p.replace(state.home, "~") : p;
const basename = p => (p || "").replace(/\/+$/, "").split("/").pop();
const kfmt = n => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
function nearBottom(S) { const c = S.el; return c.scrollHeight - c.scrollTop - c.clientHeight < 140; }
function scrollDown(S, force) {
  if (force) { S.glide = false; requestAnimationFrame(() => { S.el.scrollTop = S.el.scrollHeight; S.setTop = S.el.scrollTop; }); return; }
  if (!S.stick || S.follow) return;
  if (!smooth(S)) { requestAnimationFrame(() => { S.el.scrollTop = S.el.scrollHeight; S.setTop = S.el.scrollTop; }); return; }
  if (S.glide) return;
  S.glide = true;
  const step = () => {  // ease toward the bottom; each frame covers a fifth of what's left
    if (!S.glide || !S.stick) { S.glide = false; return; }
    const c = S.el, left = c.scrollHeight - c.clientHeight - c.scrollTop;
    if (left < 1) { S.glide = false; return; }
    c.scrollTop += Math.max(1, Math.ceil(left * 0.2));
    S.setTop = c.scrollTop;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
// How replies land (Settings › Appearance › Reply animation): dur is one word's or line's own animation, step the gap between them.
const REPLY_ANIM = { blur: { dur: 550, step: 30 }, scan: { dur: 450, step: 140 }, pop: { dur: 800, step: 12 } };
const POP_LETTERS_MAX = 2500;  // longer replies pop word by word: thousands of moving letters would stutter
const animMode = () => { const m = state.settings?.reply_anim ?? "blur"; return REPLY_ANIM[m] ? m : ""; };
const smooth = S => !!animMode() && !S.replaying && S.sid === state.active && !document.hidden
  && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- tables ----------
window.makeTable = function ({ title, columns, rows, note, inline }) {
  const card = el("div", "table-card");
  const isNum = v => v !== null && v !== "" && !isNaN(+String(v).replace(/[,$%]/g, ""));
  const numCol = columns.map((_, c) => rows.length > 0 && rows.every(r => r[c] == null || r[c] === "" || isNum(r[c])));
  let data = rows.slice(), sortCol = -1, dir = 1, limit = 200;
  if (!inline || title) {
    const th = el("div", "th", `<span class="ttl">${esc(title || "Results")}</span>`);
    const copy = el("button", "btn ghost small", "Copy");
    copy.onclick = () => { api().copy([columns, ...rows].map(r => r.map(v => v ?? "").join("\t")).join("\n")); toast("Copied (paste into Excel or Sheets)"); };
    const exp = el("button", "btn ghost small", "Export CSV");
    exp.onclick = async () => toast("Saved " + await api().export_table(title || "results", columns, rows));
    th.append(copy, exp);
    card.appendChild(th);
  }
  const tw = el("div", "tw");
  const table = el("table", "data");
  tw.appendChild(table);
  card.appendChild(tw);
  const foot = el("div", "tf");
  card.appendChild(foot);
  function draw() {
    const head = "<tr>" + columns.map((c, i) => `<th data-c="${i}" class="${i === sortCol ? (dir > 0 ? "asc" : "desc") : ""}">${window.mdInline(String(c))}</th>`).join("") + "</tr>";
    const body = data.slice(0, limit).map(r => "<tr>" + columns.map((_, i) => {
      const v = r[i] ?? "";
      return `<td class="${numCol[i] ? "num" : ""}" title="${esc(v)}">${inline ? window.mdInline(String(v)) : esc(v)}</td>`;
    }).join("") + "</tr>").join("");
    table.innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
    foot.innerHTML = `<span>${rows.length} row${rows.length === 1 ? "" : "s"} · ${columns.length} col</span>` + (note ? `<span>${esc(note)}</span>` : "");
    if (rows.length > limit) {
      const more = el("a", "copy", `show all ${rows.length}`);
      more.onclick = () => { limit = rows.length; draw(); };
      foot.appendChild(more);
    }
    table.querySelectorAll("th").forEach(th => th.onclick = () => {
      const c = +th.dataset.c;
      dir = sortCol === c ? -dir : 1; sortCol = c;
      data.sort((a, b) => {
        const x = a[c] ?? "", y = b[c] ?? "";
        if (numCol[c]) return (parseFloat(String(x).replace(/[,$%]/g, "")) - parseFloat(String(y).replace(/[,$%]/g, ""))) * dir;
        return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
      });
      draw();
    });
  }
  draw();
  return card;
};

// ---------- diffs ----------
function makeDiff(d, { closed = false, file = "", cwd = "" } = {}) {
  const box = el("div", "diff" + (closed ? " closed" : ""));
  const head = el("div", "diff-head", `<span class="f">${esc(d.short || d.file)}${d.new ? " (new)" : ""}</span>` +
    `<span class="a">+${d.added}</span><span class="r">−${d.removed}</span>`);
  const open = el("button", "copy", "open");
  open.title = "Open in VS Code";
  open.onclick = e => { e.stopPropagation(); const first = d.rows.find(r => r[2]); api().open_in_editor(file || d.file, first ? first[2] : 1); };
  head.appendChild(open);
  head.onclick = () => box.classList.toggle("closed");
  box.appendChild(head);
  const body = el("div", "diff-body");
  const rows = d.rows.map(([k, a, b, t]) => k === "gap" ? `<tr class="gap"><td colspan="4">⋯</td></tr>` :
    `<tr class="${k}"><td class="n">${a ?? ""}</td><td class="n">${b ?? ""}</td><td class="s"></td><td>${esc(t)}</td></tr>`).join("");
  body.innerHTML = `<table>${rows}</table>` + (d.truncated ? `<div class="note">diff truncated</div>` : "") +
    (!d.rows.length ? `<div class="note">no line changes</div>` : "");
  box.appendChild(body);
  return box;
}

// ---------- sessions ----------
function makeSession(info) {
  const S = { sid: info.sid, cwd: info.cwd, title: info.title || "", status: info.status || "saved", model: info.model || "", permMode: info.perm_mode || "", fast: !!info.fast, modes: {},
    effort: info.effort || "", context: info.context || info.ctx_usage?.totalTokens || 0, ctxUsage: info.ctx_usage?.totalTokens ? info.ctx_usage : null, commands: [], draft: "", attachments: [], tools: new Map(),
    perms: new Map(), jobs: new Map(), cur: null, think: null, stick: true, started: 0, lastActive: Date.now() / 1000 };
  S.el = el("div", "chat");
  S.inner = el("div", "chat-inner");
  S.el.appendChild(S.inner);
  S.el.hidden = true;
  S.el.addEventListener("scroll", () => {
    if (S.glide && Math.abs(S.el.scrollTop - (S.setTop ?? -9)) < 2) return;  // a step of our own glide
    S.stick = nearBottom(S); if (!S.stick) S.glide = false;
    if (S.sid === state.active) syncJump();
  });
  S.el.addEventListener("wheel", e => { if (e.deltaY < 0 && S.glide) { S.glide = false; S.stick = false; syncJump(); } }, { passive: true });
  $("#chats").appendChild(S.el);
  state.open.set(S.sid, S);
  return S;
}

function add(S, node) {
  const w = S.inner.querySelector(":scope > .working, :scope > .msg-user.queued");  // the reply streams above both
  if (!S.replaying) node.classList.add("rise");
  if (S.playing?.size && !node.classList.contains("msg-text")) { node.classList.add("held"); (S.held ||= []).push(node); }
  S.inner.insertBefore(node, w || null);
  scrollDown(S);
  return node;
}

function addUser(S, text, images, queued) {
  if (/^\[(Tether|Tether) handoff\]/.test(text || "")) {
    const [carried, mine] = text.split("\n\n[Your message]\n");
    add(S, freshCard(S, { carried, from: (carried.match(/\((\w{8})\)/) || [])[1] }));
    if (!mine) return;
    text = mine;
  }
  const m = el("div", "msg-user");
  if (images && (images.length || images > 0)) {
    const imgs = el("div", "imgs");
    if (Array.isArray(images)) images.forEach(im => { const i = el("img"); i.src = `data:${im.media_type};base64,${im.data}`; i.title = im.label || ""; i.onclick = () => showPeek(i, { src: i.src, label: im.label }); imgs.appendChild(i); });
    else imgs.appendChild(el("span", "imgnote", `${images} image${images > 1 ? "s" : ""}`));
    m.appendChild(imgs);
  }
  m.appendChild(document.createTextNode(text || ""));
  if (queued) {  // Claude is mid-reply: wait at the bottom until Claude reads it (see "delivered")
    m.classList.add("queued");
    m.prepend(el("div", "q-label", `<span class="qdot"></span>Queued`));
    S.inner.appendChild(m);
    scrollDown(S, true);
    return m;
  }
  thinkDone(S); S.cur = null; S.think = null; S.replies = 0;
  add(S, m);
  scrollDown(S, true);
  return m;
}
// Claude took in a message: a queued one moves to this point in the conversation, so what follows answers it.
function delivered(S, text) {
  const norm = t => (t || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const i = (S.pending ||= []).findIndex(p => norm(p.text) === norm(text));
  if (i < 0) return;
  const [p] = S.pending.splice(i, 1);
  if (!p.el.classList.contains("queued")) return;
  thinkDone(S); endText(S); S.think = null; S.replies = 0;
  p.el.classList.remove("queued");
  p.el.querySelector(":scope > .q-label")?.remove();
  add(S, p.el);
  scrollDown(S, true);
}

function textBlock(S) {
  const d = el("div", "msg-text" + (S.replies ? " reply-next" : ""));  // a second reply in the same turn: divider in Chat/Thinking
  S.replies = (S.replies || 0) + 1;
  S.cur = { el: d, src: "", queued: false };
  add(S, d);
  return S.cur;
}
function textDelta(S, t) {
  const c = S.cur || textBlock(S);
  c.src += t;
  if (smooth(S) || c.playing) return play(S, c);
  if (!c.queued) {
    c.queued = true;
    requestAnimationFrame(() => {
      c.queued = false;
      if (S.cur !== c) return;  // already finished (endText rendered it for good)
      window.renderMarkdown(c.el, c.src, true); c.el.classList.add("cursor"); scrollDown(S);
    });
  }
}
// Claude Code often hands over a whole reply in one go. Lay it out once, then let its words (or lines) land one after
// another, all within about a second. Each word keeps its own start time, so text that arrives later carries on smoothly.
function play(S, c) {
  if (!c.playing) { c.playing = true; (S.playing ||= new Set()).add(c); }  // rows that follow wait from now on
  if (c.landing) return;
  c.landing = true;
  requestAnimationFrame(() => { c.landing = false; land(S, c); });
}
const UNIT_BLOCK = "pre, svg, img, table, .mermaid, .table-card, button";  // these land whole, not word by word
function wordUnits(root) {
  const units = [];
  const walk = node => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 1) { if (ch.matches(UNIT_BLOCK)) units.push([ch]); else walk(ch); continue; }
      if (ch.nodeType !== 3) continue;
      const parts = ch.textContent.match(/\S+\s*|\s+/g);
      if (!parts || parts.length === 1 && !parts[0].trim()) continue;
      const frag = document.createDocumentFragment();
      for (const t of parts) {
        if (!t.trim()) { frag.append(t); continue; }
        const w = document.createElement("span"); w.className = "w"; w.textContent = t;
        frag.append(w); units.push([w]);
      }
      ch.replaceWith(frag);
    }
  };
  walk(root);
  return units;
}
const graphemes = t => window.Intl?.Segmenter ? [...new Intl.Segmenter().segment(t)].map(x => x.segment) : [...t];
function letterUnits(root) {  // each letter lands on its own; a word's letters stay together so lines break as usual
  const units = [];
  for (const [w] of wordUnits(root)) {
    if (!w.classList.contains("w")) { units.push([w]); continue; }
    const t = w.textContent, word = t.trimEnd();
    w.className = "wd"; w.textContent = "";
    for (const ch of graphemes(word)) { const c = document.createElement("span"); c.className = "c"; c.textContent = ch; w.append(c); units.push([c]); }
    if (t.length > word.length) w.after(t.slice(word.length));  // the space stays outside the word
  }
  return units;
}
function lineUnits(root) {  // words that share a line on screen land together
  const words = wordUnits(root).map(u => u[0]);
  const tops = words.map(w => Math.round(w.getBoundingClientRect().top));  // one layout pass, then regroup
  const lines = [];
  let top = null, seg = null;
  words.forEach((w, i) => {
    if (!w.classList.contains("w")) { lines.push([w]); top = null; seg = null; return; }
    if (top === null || Math.abs(tops[i] - top) > 3) { lines.push([]); top = tops[i]; seg = null; }
    if (seg && seg.parentNode === w.parentNode && seg.nextSibling === w) { seg.append(w); return; }
    seg = document.createElement("span"); seg.className = "ln";
    w.before(seg); seg.append(w);
    lines.at(-1).push(seg);
  });
  for (const line of lines) {  // a line split by bold or code: the bar crosses each piece in turn, as one sweep
    const r = line.map(n => n.getBoundingClientRect()), x0 = Math.min(...r.map(b => b.left)), w = Math.max(...r.map(b => b.right)) - x0 || 1;
    line.forEach((n, i) => { n.dataset.f0 = (r[i].left - x0) / w; n.dataset.fw = r[i].width / w; });
  }
  return lines;
}
function land(S, c) {
  if (!c.el.isConnected) { c.playing = false; S.playing?.delete(c); return; }  // the chat was reloaded
  const mode = animMode(), A = REPLY_ANIM[mode];
  window.renderMarkdown(c.el, c.src, true);
  if (!A || !smooth(S)) { c.until = 0; return settle(S, c); }  // switched away, hidden or turned off: show it all now
  const now = performance.now();
  if (mode === "pop" && !c.kind) c.kind = c.src.length > POP_LETTERS_MAX ? "words" : "letters";  // decided once, so start times line up
  if (c.kind === "letters") c.el.classList.add("nokern");  // split letters lose kerning; the settled reply matches, so lines don't jump
  const units = mode === "scan" ? lineUnits(c.el) : mode === "pop" && c.kind === "letters" ? letterUnits(c.el) : wordUnits(c.el), starts = c.starts ||= [];
  const fresh = units.length - starts.length;
  if (fresh > 0) {
    let t = Math.max(now, starts.length ? starts.at(-1) + A.step : now);
    const gap = Math.max(0, Math.min(A.step, (now + 950 - t) / fresh));  // the new part lands within about a second, however long
    for (let i = 0; i < fresh; i++, t += gap) starts.push(t);
  }
  const cls = mode === "scan" ? "ln-a" : mode === "pop" ? "pop-a" : "w-a";
  units.forEach((u, i) => {
    const d = Math.round(starts[i] - now);
    if (d + A.dur <= 0) return;  // landed already
    for (const n of u) {
      n.classList.add(cls);
      const f0 = +(n.dataset.f0 || 0), fw = +(n.dataset.fw || 1);
      n.style.animationDelay = Math.round(d + f0 * A.dur) + "ms";
      if (mode === "scan") n.style.animationDuration = Math.max(60, Math.round(fw * A.dur)) + "ms";
    }
  });
  for (const box of c.el.querySelectorAll("li, :not(pre) > code")) {  // a bullet or code box shows with its first word
    const first = box.querySelector(".w-a, .ln-a, .pop-a");
    if (first) { box.classList.add("box-a"); box.style.animationDelay = first.style.animationDelay; }
  }
  c.units = units;
  c.until = (starts.at(-1) ?? now) + A.dur;
  clearTimeout(c.timer);
  c.timer = setTimeout(() => settle(S, c), Math.max(0, c.until - now) + 40);
  follow(S, c);
}
// Keep the newest landed line in view while it plays in, instead of jumping to the bottom of space that's still empty.
function follow(S, c) {
  if (S.follow === c) return;
  S.follow = c; S.glide = true;
  const step = () => {
    if (S.follow !== c) return;
    if (!c.playing || !S.stick || !c.el.isConnected) { S.follow = null; S.glide = false; return scrollDown(S); }
    const now = performance.now(), st = c.starts || [];
    let k = st.length - 1;
    while (k > 0 && st[k] > now) k--;
    const u = c.units?.[k]?.[0], comp = $("#composer");
    const floor = (comp && !comp.hidden ? comp.getBoundingClientRect().top : S.el.getBoundingClientRect().bottom) - 28;  // the message box floats over the chat
    if (u) {
      const want = Math.min(S.el.scrollHeight - S.el.clientHeight, S.el.scrollTop + u.getBoundingClientRect().bottom - floor);
      const left = want - S.el.scrollTop;
      if (left >= 1) { S.el.scrollTop += Math.max(1, Math.ceil(left * 0.2)); S.setTop = S.el.scrollTop; }
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function settle(S, c) {
  const wait = (c.until || 0) - performance.now();
  if (wait > 5) { clearTimeout(c.timer); c.timer = setTimeout(() => settle(S, c), wait + 20); return; }
  c.playing = false;
  S.playing?.delete(c);
  if (c.ended || S.cur !== c) finishText(S, c);  // its block was closed while it played: draw it for good
  if (!S.playing?.size && S.held?.length) { for (const h of S.held) h.classList.remove("held"); S.held = []; }
  scrollDown(S);
}
function finishText(S, c) { c.starts = c.units = c.kind = null; window.renderMarkdown(c.el, c.src); c.el.classList.remove("cursor"); hydrate(S, c.el); scrollDown(S); }
function endText(S) {
  const c = S.cur;
  S.cur = null;
  if (!c) return;
  if (c.playing) c.ended = true;  // it finishes when it has played in
  else finishText(S, c);
}
// Paths in a finished reply: check each against the disk (dead ones go back to plain text), show images inline.
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|heic|tiff?)$/i;
// A path shown as a path becomes a trail: each folder opens in Finder, the file name opens the file.
function segmentPath(a, r) {
  const text = a.textContent;
  const m = text.match(/^(.*?)((?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)?)$/);
  const shown = m[1], lineTxt = m[2];
  if (text !== a.dataset.path || !shown.includes("/")) {  // a named link ("see the setup") stays one link
    a.title = `${r.short}\n${r.kind === "dir" ? "Click to open in Finder" : "Click to open in its default app · ⌥-click for VS Code · ⌘-click to show in Finder"}`;
    return;
  }
  const disp = shown.replace(/\/+$/, "").split("/");
  const abs = r.path.replace(/\/+$/, "").split("/");
  const wrap = el("span", "path-trail");
  disp.forEach((seg, i) => {
    const fromEnd = disp.length - 1 - i;
    let target = abs.slice(0, abs.length - fromEnd).join("/") || "/";
    if (seg === "~" && i === 0) target = state.home;
    const last = i === disp.length - 1;
    if (seg === "") { wrap.appendChild(document.createTextNode("/")); return; }  // a leading "/"
    const isFile = last && r.kind !== "dir";
    const s = el("a", "path pseg " + (isFile ? "is-file" : "is-dir"));
    s.textContent = seg + (isFile ? lineTxt : "");
    s.dataset.abs = target; s.dataset.ok = "1"; s.dataset.kind = isFile ? "file" : "dir";
    if (isFile && r.line) s.dataset.line = r.line;
    s.title = isFile ? `${r.short}${r.line ? ":" + r.line : ""}\nClick to open in its default app · ⌥-click for VS Code · ⌘-click to show in Finder` : `${target.replace(state.home, "~")}\nOpen in Finder`;
    wrap.appendChild(s);
    if (!last || shown.endsWith("/")) wrap.appendChild(document.createTextNode("/"));
  });
  a.replaceWith(wrap);
}

function hydrate(S, root) {
  // Absolute and ~ paths first; the folders they name become places to look for short names in the same reply.
  const links = [...root.querySelectorAll("a.path:not([data-ok])")];
  links.forEach(a => { a.dataset.ok = "1"; });
  const abs = links.filter(a => /^[~/]/.test(a.dataset.path)), rel = links.filter(a => !/^[~/]/.test(a.dataset.path));
  const bases = [];
  const apply = async (a, r) => {
    if (r.kind === "missing") { a.replaceWith(document.createTextNode(a.textContent)); return; }
    a.dataset.abs = r.path;
    a.dataset.kind = r.kind;
    a.classList.add("is-" + r.kind);
    segmentPath(a, r);
    if (r.kind !== "image") return;
    const block = a.closest("p, li, td, blockquote") || a.parentElement;
    if (block.querySelector(`img[data-for="${CSS.escape(r.path)}"]`)) return;
    const im = await api().image_data(S.sid, r.path);
    if (!im) return;
    const img = el("img", "inline-img");
    img.src = im.src; img.title = `${im.short} (click to open)`; img.dataset.for = r.path;
    img.onclick = () => showPeek(img, { ref: r.path, sid: S.sid });
    block.appendChild(img);
    scrollDown(S);
  };
  (async () => {
    for (const a of abs) {
      const r = await api().path_info(S.sid, a.dataset.path, []);
      if (r.kind === "dir") bases.push(r.path);
      else if (r.kind !== "missing") bases.push(r.path.replace(/\/[^/]+$/, ""));
      apply(a, r);
    }
    for (const a of rel) apply(a, await api().path_info(S.sid, a.dataset.path, bases));
  })();
}
function thinkBlock(S, text, open, live) {
  const d = el("details", "thinking" + (live ? " live" : ""));
  d.open = !!open;
  d.innerHTML = `<summary><span class="tlabel">Thinking</span><span class="ttime"></span></summary><div class="body"></div>`;
  d.querySelector(".body").textContent = text || "";
  if (live) {  // Claude Code sends the thinking summary in one go when thinking ends; until then, show it's thinking and for how long
    d.started = Date.now(); d.queue = "";
    const tt = d.querySelector(".ttime");
    d.timer = setInterval(() => { tt.textContent = ` · ${Math.round((Date.now() - d.started) / 1000)}s`; }, 1000);
  }
  S.think = d;
  add(S, d);
  return d;
}
// Reveal arriving thinking smoothly instead of all at once.
function thinkType(S, d, text) {
  d.queue = (d.queue || "") + text;
  if (d.typing) return;
  d.typing = true;
  const body = d.querySelector(".body");
  const step = () => {
    if (!d.queue) { d.typing = false; return; }
    const n = Math.max(3, Math.ceil(d.queue.length / 40));
    body.textContent += d.queue.slice(0, n); d.queue = d.queue.slice(n);
    body.scrollTop = body.scrollHeight; scrollDown(S);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function thinkDone(S) {
  const d = S.think;
  if (!d || !d.timer) return;
  clearInterval(d.timer); d.timer = null;
  d.classList.remove("live");
  if (!d.querySelector(".body").textContent && !d.queue && !d.typing) { d.remove(); S.think = null; return; }  // it went straight to a reply or a tool
  const secs = Math.round((Date.now() - d.started) / 1000);
  d.querySelector(".tlabel").textContent = secs >= 1 ? `Thought for ${secs}s` : "Thinking";
  d.querySelector(".ttime").textContent = "";
}

function addTool(S, ev, done) {
  if (ev.agent) return addAgent(S, ev, done);
  const t = el("div", "tool");
  const isCmd = ev.name === "Bash";
  let short = ev.name.startsWith("mcp__") ? ev.name.split("__")[1] : ev.name;
  const verb = (ev.label || "").split(/[\s:]/)[0];
  if (["Read", "Write", "Edit", "Search", "Web", "Fetch", "Agent", "Skill"].includes(verb) || ev.name.startsWith("mcp__")) short = "";
  t.innerHTML = `<div class="row"><span class="ico ${done ? (ev.ok === false ? "bad" : "ok") : "run"}"></span>` +
    `<span class="name">${esc(short)}</span><span class="lbl ${isCmd ? "cmd" : ""}"></span></div><div class="steps"></div><div class="detail"></div>`;
  t.querySelector(".lbl").textContent = isCmd && ev.command ? ev.command.split("\n")[0] : ev.label;
  t.querySelector(".lbl").title = ev.label;
  const det = t.querySelector(".detail");
  det.innerHTML = `<div class="k">${isCmd ? "command" : "input"}</div><pre></pre><div class="k out" hidden>output</div><pre class="out" hidden></pre>`;
  det.querySelector("pre").textContent = isCmd ? (ev.command || "") : ev.input;
  t.querySelector(".row").onclick = () => t.classList.toggle("open");
  const fp = (ev.input || "").match(/"(?:file_path|notebook_path|path)":\s*"((?:[^"\\]|\\.)+)"/);
  if (fp && !isCmd && ev.name === "Read") {
    const path = JSON.parse(`"${fp[1]}"`), off = +((ev.input || "").match(/"offset":\s*(\d+)/) || [])[1] || 0, lim = +((ev.input || "").match(/"limit":\s*(\d+)/) || [])[1] || 0;
    t.querySelector(".row").onclick = () => showPeek(t.querySelector(".lbl"), { ref: path, sid: S.sid, from: off || (lim ? 1 : 0), to: lim ? (off || 1) + lim - 1 : 0 });
  }
  if (fp && !isCmd) {
    const o = el("button", "copy", "open");
    o.title = "Open in VS Code";
    o.onclick = e => { e.stopPropagation(); api().open_path(S.sid, JSON.parse(`"${fp[1]}"`), "editor").then(r => r.kind === "missing" && toast("Not found: " + r.path)); };
    t.querySelector(".row").appendChild(o);
  }
  if (done && ev.output) setToolOutput(t, ev.output);
  S.tools.set(ev.id, t);
  S.cur = null;
  add(S, t);
  if (ev.job) jobEvent(S, { ...ev.job, id: ev.id }, t);
}

// ---------- background jobs: the row that started one stays live until it ends ----------
// Claude Code reports each job's start and end (task_* events, or task notifications in a saved chat) and
// writes its output to a file as it runs; Tether reads that file, so following a job costs no tokens.
const JOB_WORD = { running: "Running", completed: "Completed", failed: "Failed", killed: "Stopped", stopped: "Stopped", unknown: "No update saved" };
const jobsRunning = S => [...(S?.jobs?.values() || [])].filter(j => j.status === "running");
function jobDur(j) { return j.started ? agDur(((j.ended || Date.now() / 1000) - j.started) * 1000) : ""; }
function jobEvent(S, ev, row) {
  const j = S.jobs.get(ev.task_id) || {};
  Object.assign(j, ev);
  if (row) j.row = row;
  j.row ||= S.tools.get(j.id);
  S.jobs.set(j.task_id, j);
  if (j.status !== "running" && j.status !== "unknown" && !S.replaying) {
    j.endedAt = Date.now();
    if (j.status === "failed" && S.sid !== state.active) S.jobFailed = true;
    pollJob(S, j, true);  // its last lines
  }
  paintJob(S, j);
  if (!S.replaying) { syncJobsNote(); renderSidebar(); }
}
function paintJob(S, j) {
  const t = j.row;
  if (!t) return;
  t.classList.add("job");
  const ok = j.status === "completed" && (j.exit == null || j.exit === 0), bad = j.status === "failed";
  t.querySelector(".ico").className = "ico " + (j.status === "running" ? "run" : ok ? "ok" : bad ? "bad" : "off");
  let st = t.querySelector(".jstate");
  if (!st) { st = el("span", "jstate"); t.querySelector(".row").insertBefore(st, t.querySelector(".row .copy")); }
  const word = JOB_WORD[j.status] || j.status, cls = j.status === "running" ? "run" : ok ? "ok" : bad ? "bad" : "";
  const bits = [j.exit != null && j.exit !== 0 ? `exit ${j.exit}` : "", j.status === "unknown" ? "" : jobDur(j)].filter(Boolean);
  st.innerHTML = `<b class="${cls}">${word}</b>${bits.map(b => ` · ${esc(b)}`).join("")}`;
  st.title = j.summary || "";
  let tail = t.querySelector(".jtail");
  if (!tail) { tail = el("div", "jtail"); t.querySelector(".row").after(tail); }
  tail.textContent = j.last || "";
  tail.hidden = !j.last || t.classList.contains("open");
  const det = t.querySelector(".detail");
  if (!det.querySelector(".jout")) {
    det.insertAdjacentHTML("beforeend", `<div class="k">job output<span class="jsize"></span></div><pre class="jout"></pre>`);
    t.querySelector(".row").addEventListener("click", () => { tail.hidden = !j.last || t.classList.contains("open"); if (t.classList.contains("open")) pollJob(S, j, true); });
  }
}
async function pollJob(S, j, full) {
  if (j.polling) return;
  j.polling = true;
  try {
    const open = j.row?.classList.contains("open");
    const r = await api().job_output(S.sid, j.task_id, j.output_file || "", open || full ? 60000 : 4000);
    if (r.missing) { if (!j.last) j.last = ""; return; }
    const lines = (r.text || "").replace(/\s+$/, "").split("\n");
    j.last = (lines.at(-1) || "").slice(0, 300);
    const out = j.row?.querySelector(".jout");
    if (out && (open || full)) {
      const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 8;
      out.textContent = (r.cut ? "…\n" : "") + (r.text || "(no output yet)");
      if (atEnd) out.scrollTop = out.scrollHeight;
      j.row.querySelector(".jsize").textContent = r.size ? ` · ${r.size < 1024 ? r.size + " bytes" : Math.round(r.size / 1024) + " KB"}${j.status === "running" ? " · grows as it runs" : ""}` : "";
    }
  } finally { j.polling = false; paintJob(S, j); }
}
let jobTick = 0;
setInterval(() => {  // timers every second; output every two, only for the chat in front
  jobTick++;
  for (const S of state.open.values()) {
    const run = jobsRunning(S);
    if (!run.length) continue;
    for (const j of run) { paintJob(S, j); if (S.sid === state.active && jobTick % 2 === 0) pollJob(S, j); }
  }
  syncJobsNote();
}, 1000);
// "Running" above the message box, so a chat whose reply ended doesn't look finished while a job still runs
function syncJobsNote() {
  const box = $("#jobs-note"), S = state.open.get(state.active);
  if (!box) return;
  const run = jobsRunning(S), ended = [...(S?.jobs?.values() || [])].filter(j => j.endedAt && Date.now() - j.endedAt < 60000).sort((a, b) => b.endedAt - a.endedAt);
  if (!run.length && !ended.length) { box.hidden = true; $("#jobs-pop").hidden = true; return; }
  box.hidden = false;
  let html;
  if (run.length) {
    html = `<span class="jring"></span><span class="w">${run.length === 1 ? "Running" : `${run.length} running`}</span><span class="lbl">· ${esc(run.map(j => j.description).join(", "))}${run.length === 1 ? ` · ${jobDur(run[0])}` : ""}</span>`;
  } else {
    const j = ended[0], ok = j.status === "completed" && !j.exit;
    html = `<span class="jdot ${ok ? "ok" : j.status === "failed" ? "bad" : ""}"></span><span class="w ${ok ? "ok" : j.status === "failed" ? "bad" : ""}">${ok ? "Ended" : JOB_WORD[j.status] || j.status}</span><span class="lbl">· ${esc(j.description)} · ${j.exit ? `exit ${j.exit}` : jobDur(j)}</span>`;
  }
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  box.onclick = () => {
    const A = state.open.get(state.active), list = [...jobsRunning(A), ...ended.filter(j => !jobsRunning(A).includes(j))];
    if (list.length === 1) return showJob(A, list[0]);
    const pop = $("#jobs-pop");
    if (!pop.hidden) { pop.hidden = true; return; }
    pop.innerHTML = "";
    for (const j of list) {
      const it = el("button", "jp-row", `<span class="${j.status === "running" ? "jring" : "jdot " + (j.status === "completed" && !j.exit ? "ok" : j.status === "failed" ? "bad" : "")}"></span><span class="lbl"></span><span class="t">${esc(j.status === "running" ? jobDur(j) : `${JOB_WORD[j.status] || j.status} · ${jobDur(j)}`)}</span>`);
      it.querySelector(".lbl").textContent = j.description;
      it.onclick = () => { pop.hidden = true; showJob(A, j); };
      pop.appendChild(it);
    }
    pop.hidden = false;
  };
}
function showJob(S, j) {
  if (!S || !j.row) return;
  j.row.classList.add("open");
  j.row.querySelector(".jtail").hidden = true;
  pollJob(S, j, true);
  S.stick = false;
  j.row.scrollIntoView({ block: "center", behavior: "smooth" });
}
// ---------- sub-agents: one lane each, under the call that started them ----------
// Live numbers come from Claude Code's task_* events (foreground and background agents alike).
const AG_WORD = { unfinished: "No result saved", starting: "Starting", running: "Running", completed: "Done", failed: "Failed", killed: "Stopped", stopped: "Stopped" };
function agDur(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; }
function addAgent(S, ev, done) {
  const a = ev.agent;
  const L = { id: ev.id, agentId: ev.agent_id || "", type: ev.agent_type || a.type, desc: a.description, prompt: a.prompt,
    background: a.background, steps: [], status: done ? (ev.status === "running" ? "unfinished" : ev.status || (ev.ok === false ? "failed" : "completed")) : "starting",
    started: Date.now(), ms: ev.ms || 0, tools: ev.tools || 0, tokens: ev.tokens || 0, result: done ? (ev.output || "") : "", summary: ev.summary || "", loaded: false };
  const n = el("div", "agent");
  n.innerHTML = `<div class="ag-row"><span class="dot"></span><span class="ag-type"></span><span class="ag-desc"></span><span class="ag-meta"></span></div>
    <div class="ag-track"></div><div class="ag-now"></div>
    <div class="ag-detail" hidden>
      <details class="ag-task"><summary>What it was asked</summary><div class="msg-text"></div></details>
      <div class="ag-h">Steps</div><ol class="ag-steps"></ol>
      <div class="ag-h ag-rh">Result</div><div class="msg-text ag-result"></div>
    </div>`;
  n.querySelector(".ag-type").textContent = L.type;
  n.querySelector(".ag-desc").textContent = L.desc;
  n.querySelector(".ag-row").onclick = () => toggleAgent(S, L);
  n.querySelector(".ag-task").ontoggle = e => { const b = e.target.querySelector(".msg-text"); if (e.target.open && !b.innerHTML) renderMarkdown(b, L.prompt || "—"); };
  L.el = n; n.lane = L;
  (S.agents ||= new Map()).set(ev.id, L);
  S.tools.set(ev.id, n);
  S.cur = null;
  // agents started together sit in one group with a count
  const last = [...S.inner.children].filter(c => !c.classList.contains("working") && !c.classList.contains("queued")).pop();
  if (last?.classList.contains("agents")) last.querySelector(".ag-list").appendChild(n);
  else if (last?.classList.contains("agent")) {
    const g = el("div", "agents", `<div class="ag-group-h"></div><div class="ag-list"></div>`);
    last.replaceWith(g); g.querySelector(".ag-list").append(last, n);
  } else add(S, n);
  paintAgent(L);
  scrollDown(S);
  return n;
}
function paintAgent(L) {
  const n = L.el, live = L.status === "running" || L.status === "starting";
  n.className = "agent " + (live ? "run" : L.status === "completed" ? "ok" : L.status === "unfinished" ? "" : "bad") + (n.classList.contains("open") ? " open" : "");
  const ms = live && !L.msLive ? Date.now() - L.started : L.ms || (L.msLive ? L.msLive + (Date.now() - L.msAt) : 0);
  const bits = [AG_WORD[L.status] || L.status, ms ? agDur(live ? Math.max(ms, Date.now() - L.started) : ms) : "",
    L.tools ? `${L.tools} ${L.tools === 1 ? "step" : "steps"}` : "", L.tokens ? `${kfmt(L.tokens)} tokens` : "", L.background ? "background" : ""];
  n.querySelector(".ag-meta").textContent = bits.filter(Boolean).join(" · ");
  const track = n.querySelector(".ag-track"), want = Math.min(L.tools, 48);
  while (track.children.length < want) track.appendChild(el("i"));
  [...track.children].forEach((t, i) => { t.className = live && i === want - 1 ? "cur" : ""; t.title = L.steps[i]?.text || ""; });
  track.dataset.more = L.tools > 48 ? `+${L.tools - 48}` : "";
  const now = live ? (L.steps.at(-1)?.text || (L.status === "starting" ? "Starting…" : "Working…"))
    : cleanAgentText(L.summary || L.result).replace(/<[^>]+>/g, "").split("\n").find(x => x.trim()) || "";
  n.querySelector(".ag-now").textContent = now;
  const g = n.closest(".agents");
  if (g) {
    const all = [...g.querySelectorAll(".agent")].map(x => x.lane), running = all.filter(x => x.status === "running" || x.status === "starting").length;
    g.querySelector(".ag-group-h").textContent = `${all.length} agents` + (running ? ` · ${running} running` : " · all finished");
  }
  if (n.classList.contains("open")) fillAgent(L);
}
// Claude Code wraps a sub-agent's report in a hand-back note and a tools list; show just the report.
const cleanAgentText = t => (t || "").replace(/<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>\s*/g, "")
  .replace(/^\s*\[Subagent hand-back\][\s\S]*?The report follows:\s*/, "").replace(/^ {2,}/gm, "");
function fillAgent(L) {
  const ol = L.el.querySelector(".ag-steps");
  ol.innerHTML = L.steps.map(s => `<li>${esc(s.text)}</li>`).join("") || `<li class="dim">${L.status === "starting" ? "Not started yet" : "No steps recorded"}</li>`;
  const res = L.result || L.summary;
  L.el.querySelector(".ag-rh").hidden = !res;
  const r = L.el.querySelector(".ag-result");
  if (r.dataset.src !== res) { r.dataset.src = res; renderMarkdown(r, cleanAgentText(res)); }
}
async function toggleAgent(S, L) {
  const open = L.el.classList.toggle("open");
  L.el.querySelector(".ag-detail").hidden = !open;
  if (!open) return;
  fillAgent(L);
  const live = L.status === "running" || L.status === "starting";
  if (!L.loaded && L.agentId && !live) {  // the full trail is in the agent's own file
    L.loaded = true;
    const t = await api().agent_trail(S.sid, L.agentId);
    if (t?.steps?.length) { L.steps = t.steps; L.tools = Math.max(L.tools, t.total || 0); }
    if (t?.result && (!L.result || /delivered to you as a message|SubagentHandback/.test(L.result))) L.result = t.result;
    paintAgent(L); hydrate(S, L.el.querySelector(".ag-result"));
  }
}
function agentEvent(S, ev) {
  const L = S.agents?.get(ev.id);
  if (!L) return;
  if (ev.type === "agent") {
    L.agentId = ev.agent_id; L.type = ev.agent_type || L.type; L.background = ev.background; L.status = "running"; L.started = Date.now();
    L.el.querySelector(".ag-type").textContent = L.type;
  } else if (ev.type === "agent_step") {
    if (ev.text && L.steps.at(-1)?.text !== ev.text) L.steps.push({ text: ev.text.replace(/^Running /, ""), tool: ev.tool });
    if (ev.tools != null) L.tools = ev.tools;
    if (ev.tokens) L.tokens = ev.tokens;
    if (ev.ms) { L.msLive = ev.ms; L.msAt = Date.now(); }
    if (L.status === "starting") L.status = "running";
    S.step = `${L.desc}: ${L.steps.at(-1)?.text || ""}`; S.inner.querySelector(":scope > .working")?.tick?.();
  } else if (ev.type === "agent_done") {
    L.status = ev.status || "completed"; L.summary = ev.summary || L.summary;
    if (ev.tools != null) L.tools = ev.tools; if (ev.tokens) L.tokens = ev.tokens;
    L.ms = ev.ms || (Date.now() - L.started);
  }
  paintAgent(L);
}
setInterval(() => document.querySelectorAll(".agent.run").forEach(n => paintAgent(n.lane)), 1000);

// ---------- previews ----------
// A glass card beside what you clicked: code with the lines Claude read lit, or the image. Space grows it to a
// large viewer and back; Esc closes; Open uses the file's default app.
const peek = { ref: null, sid: null, anchor: null };
async function showPeek(anchor, { ref, sid = state.active, src, label, from = 0, to = 0 } = {}) {
  const box = $("#peek"), body = box.querySelector(".peek-b"), S0 = state.open.get(sid);
  const inView = ref && state.panel && state.tab === "view" && S0 && findViewItem(S0, ref);
  if (inView) { closePeek(); return openInView(S0, inView.path); }  // already open in the panel: show it there
  peek.ref = ref || null; peek.sid = sid; peek.anchor = anchor; peek.src = src || null; peek.label = label || "";
  box.querySelector("[data-peek=open]").hidden = !ref;
  box.querySelector(".peek-mode").hidden = true;
  body.innerHTML = `<div class="peek-wait">Loading…</div>`;
  box.querySelector(".peek-t").textContent = label || (ref ? basename(ref) : "Image");
  box.querySelector(".peek-m").textContent = "";
  box.classList.remove("big", "show");
  box.hidden = false;
  placePeek();
  requestAnimationFrame(() => box.classList.add("show"));
  document.activeElement?.blur?.();
  box.focus();
  if (src) { body.innerHTML = ""; const im = el("img"); im.src = src; body.appendChild(im); return; }
  const r = await api().preview(sid, ref);
  if (peek.ref !== (ref || null)) return;  // another preview opened meanwhile
  box.querySelector(".peek-t").textContent = label || basename(r.path || ref);
  box.querySelector(".peek-t").title = r.short || r.path || "";
  if (r.kind === "image" && r.src) { body.innerHTML = ""; const im = el("img"); im.src = r.src; body.appendChild(im); return; }
  if (r.kind !== "text") { body.innerHTML = `<div class="peek-wait">${r.kind === "missing" ? "Not found" : r.kind === "dir" ? "A folder" : r.kind === "big" ? "Too large to preview" : "No text preview for this file"}</div>`; return; }
  const a = from || r.line || 0, b = to || a;
  peek.path = r.path;
  if (["page", "svg", "markdown"].includes(VIEW_TYPE_OF(r.path))) {  // a page Claude wrote reads better drawn than as code
    const seg = box.querySelector(".peek-mode");
    seg.hidden = false;
    const show = mode => {
      seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.pm === mode));
      if (mode === "code") return peekCode(box, body, r, a, b);
      box.querySelector(".peek-m").textContent = "";
      peekPage(body, r, sid);
    };
    seg.querySelectorAll("button").forEach(x => x.onclick = () => show(x.dataset.pm));
    return show(a ? "code" : "page");
  }
  peekCode(box, body, r, a, b);
}
async function peekPage(body, r, sid) {
  if (VIEW_TYPE_OF(r.path) === "markdown") {
    const d = el("div", "msg-text peek-md"); window.renderMarkdown(d, r.lines.join("\n")); hydrate(state.open.get(sid), d);
    body.innerHTML = ""; body.appendChild(d); return;
  }
  const v = await api().view_get(sid, r.path, 0, 0);
  if (peek.path !== r.path) return;
  const html = await fillLibs(v.html || "");
  if (peek.path !== r.path) return;
  const f = el("iframe", "peek-page"); f.setAttribute("sandbox", "allow-scripts"); f.srcdoc = html + HASH_JS;
  body.innerHTML = ""; body.appendChild(f);
}
function peekCode(box, body, r, a, b) {
  box.querySelector(".peek-m").textContent = a ? (b > a ? `lines ${a}–${b}` : `line ${a}`) : `${r.total.toLocaleString()} lines`;
  const pre = el("pre", "peek-code");
  pre.innerHTML = r.lines.map((t, i) => `<div class="${a && i + 1 >= a && i + 1 <= b ? "lit" : ""}"><i>${i + 1}</i>${esc(t) || " "}</div>`).join("");
  body.innerHTML = ""; body.appendChild(pre);
  if (r.total > r.lines.length) body.appendChild(el("div", "peek-wait", `First ${r.lines.length.toLocaleString()} lines`));
  const lit = pre.querySelector(".lit");
  if (lit) body.scrollTop = Math.max(0, lit.offsetTop - 60);
}
function placePeek() {
  const box = $("#peek"), a = peek.anchor;
  if (box.classList.contains("big") || !a?.isConnected) { box.style.left = box.style.top = ""; return; }
  const r = a.getBoundingClientRect(), W = innerWidth, H = innerHeight, w = Math.min(560, W - 32), h = Math.min(400, H - 32);
  let x = r.right + 12, y = r.top - 40;
  if (x + w > W - 16) x = Math.max(16, r.left - w - 12);
  if (x < 16 || (r.left - w - 12 < 16 && r.right + 12 + w > W - 16)) { x = Math.min(Math.max(16, r.left), W - w - 16); y = r.bottom + 8; if (y + h > H - 16) y = r.top - h - 8; }
  y = Math.min(Math.max(16, y), H - h - 16);
  box.style.left = x + "px"; box.style.top = y + "px";
  box.style.setProperty("--ox", `${(r.left + r.width / 2 - x)}px`); box.style.setProperty("--oy", `${(r.top + r.height / 2 - y)}px`);
}
function growPeek() { const b = $("#peek"); b.classList.toggle("big"); placePeek(); }
function closePeek() {
  const b = $("#peek");
  if (b.hidden) return false;
  b.classList.remove("show"); peek.ref = null; peek.path = null;
  setTimeout(() => { if (!b.classList.contains("show")) b.hidden = true; }, 180);
  $("#input").focus();
  return true;
}

// ---------- the Shelf tab (data-tab "view"): artifacts Claude shows, and files you move there from a preview ----------
// One item at a time, picked from the name menu. Pages run sealed in a frame (no network, no reach into Tether);
// text files show the lines changed since you opened them; every change is a version you can go back to.
const VIEW_TYPE = { page: "HTML", svg: "SVG", markdown: "Markdown", code: "Code", image: "Image" };
const VIEW_TYPE_OF = p => { const x = (p || "").split(".").pop().toLowerCase();  // the same split as artifacts.kind
  return ["html", "htm"].includes(x) ? "page" : x === "svg" ? "svg" : ["md", "markdown"].includes(x) ? "markdown" : ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic"].includes(x) ? "image" : "code"; };
const ICON_ART = {  // a page or picture; code; a document
  page: `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 15v-3M12 15V9M16 15v-5"/></svg>`,
  code: `<svg viewBox="0 0 24 24"><path d="M9 7 4 12l5 5M15 7l5 5-5 5"/></svg>`,
  markdown: `<svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4v13H7z"/><path d="M10 12h5M10 15.5h5"/></svg>`,
};
async function loadView(S) {
  const r = await api().view_list(S.sid);
  const saved = r?.items || [], have = new Set(saved.map(x => x.path));
  // shown live but maybe not in the saved transcript yet
  const live = (S.viewLive || []).filter(x => !have.has(x.path));
  // older than Settings › Shelf allows: kept under Earlier in the name menu, out of the way
  const cut = r?.hours ? Date.now() / 1000 - r.hours * 3600 : 0;
  saved.forEach(x => { x.old = !!(cut && x.ts && x.ts < cut); });
  S.viewItems = [...saved.filter(x => x.from === "claude"), ...live, ...saved.filter(x => x.from !== "claude"), ...(S.viewMem || [])];
  syncViewTab();
  return S.viewItems;
}
function syncViewTab() {
  const S = state.open.get(state.active), t = $('.tab[data-tab="view"]');
  t.hidden = !S;  // always there, so you can open the Shelf in any chat
  t.classList.toggle("fresh", !!S?.viewDot);
  if (t.hidden && state.tab === "view") setTab("notes");
}
const viewKey = p => (p || "").replace(/(?::\d+(?::\d+)?(?:-\d+)?|#L\d+.*)$/, "");
function findViewItem(S, ref) {
  const k = viewKey(ref);  // mem:<time> (a picture moved to the Shelf) is an id, not a path with a line number
  return (S?.viewItems || []).find(it => it.path === ref) || (S?.viewItems || []).find(it => it.path === k || it.short === k || (k && !k.startsWith("/") && !k.startsWith("~") && it.path.endsWith("/" + k)));
}
async function openInView(S, path, { auto } = {}) {
  if (!S.viewItems || !findViewItem(S, path)) await loadView(S);
  const it = findViewItem(S, path);
  if (!it) return toast("Couldn't open that in the panel.");
  S.viewSel = it.path; S.viewN = 0; S.viewBase = null;
  if (S.sid !== state.active) return;
  if (auto && state.panel && state.tab !== "view") { S.viewDot = true; syncViewTab(); return; }
  S.viewDot = false;
  togglePanel(true, "view");
}
function artifactLine(S, a) {
  const line = el("div", "art-line", `${ICON_ART[a.type] || ICON_ART.page}<span class="a"></span><span class="b"></span>`);
  line.querySelector(".a").textContent = a.title || basename(a.path);
  line.querySelector(".b").textContent = VIEW_TYPE[a.type || "page"] || "";
  line.title = a.short || a.path;
  line.onclick = () => openInView(S, a.path);
  return line;
}
function onArtifact(S, ev) {
  const known = (S.viewItems || []).some(it => it.path === ev.path);
  S.viewLive = [...(S.viewLive || []).filter(x => x.path !== ev.path), { path: ev.path, short: ev.short, title: ev.title, from: "claude", type: VIEW_TYPE_OF(ev.path) }];
  loadView(S).then(() => {
    if (S.sid !== state.active) { S.viewDot = true; return; }
    const showing = state.panel && state.tab === "view";
    if (showing && S.viewSel === ev.path) return renderView(S, $("#panel-body"), true);
    if (showing || (!state.panel && !S.viewAuto) || !known) { S.viewAuto = true; openInView(S, ev.path, { auto: !showing && state.panel }); }
    else { S.viewDot = true; syncViewTab(); }
  });
}
// what's on screen in the View tab, so polling and redraws know what changed
const viewShown = { sid: null, path: null, mtime: 0, size: 0, n: 0, scroll: [0, 0], mode: "file" };
async function renderView(S, body, refresh) {
  const items = S.viewItems || await loadView(S);
  const recent = items.filter(x => !x.old);
  if (!items.length || (!recent.length && !items.some(x => x.path === S.viewSel))) return renderShelfEmpty(S, body);
  const it = items.find(x => x.path === S.viewSel) || recent[recent.length - 1];
  S.viewSel = it.path; S.viewDot = false; syncViewTab();
  const same = viewShown.sid === S.sid && viewShown.path === it.path;
  if (!same) { viewShown.scroll = [0, 0]; viewShown.mode = "file"; }
  const r = it.src ? { type: "image", src: it.src, short: it.title } : await api().view_get(S.sid, it.path, S.viewBase || 0, S.viewN || 0);
  if (state.tab !== "view" || state.active !== S.sid || S.viewSel !== it.path) return;
  if (!S.viewBase && r.n) S.viewBase = r.n;  // changed lines are counted from the version you first saw
  Object.assign(viewShown, { sid: S.sid, path: it.path, mtime: r.mtime || 0, size: r.size || 0, n: r.n || 0 });
  const vs = r.versions || [], old = S.viewN && S.viewN !== r.n;
  const imgs = items.filter(x => x.type === "image" && !!x.old === !!it.old), ii = imgs.indexOf(it);
  const ch = r.changes?.lines?.length ? r.changes : null;
  body.classList.add("view-body");
  body.innerHTML = `<div class="vw-h pywebview-drag-region">
      <button class="vw-name" title="${esc(it.short || it.path)}"><span class="t"></span><span class="chev-s"></span></button>
      ${vs.length > 1 ? `<button class="vw-ver">v${r.shown} of ${vs[vs.length - 1].n}</button>` : ""}
      ${old ? `<button class="btn small" data-vw="restore">Restore</button><button class="btn ghost small" data-vw="latest">Latest</button>` : ""}
      <span class="spacer pywebview-drag-region"></span>
      ${S.commenting && noteKind(r, it) && !old ? `<span class="vw-commenting">Commenting · <a data-vw="done">Done</a></span>` : ""}
      ${ch && !old ? `<div class="seg vw-mode"><button data-m="file" class="${viewShown.mode === "file" ? "on" : ""}">File</button><button data-m="changes" class="${viewShown.mode === "changes" ? "on" : ""}">Changes</button></div>` : ""}
      ${imgs.length > 1 && ii >= 0 ? `<button class="icb" data-vw="prev" title="Previous picture" ${ii ? "" : "disabled"}><svg class="i" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button><button class="icb" data-vw="next" title="Next picture" ${ii < imgs.length - 1 ? "" : "disabled"}><svg class="i" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>` : ""}
      ${noteKind(r, it) && !old ? `<button class="icb${S.commenting ? " on" : ""}" data-vw="comment" title="Leave notes for Claude">${NOTE_ICON}</button>` : ""}
      <button class="icb" data-vw="reload" title="Reload"><svg class="i" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg></button>
      <button class="icb" data-vw="full" title="${document.body.classList.contains("view-full") ? "Back to chat (Esc)" : "Full window"}">${document.body.classList.contains("view-full")
        ? `<svg class="i" viewBox="0 0 24 24"><path d="M10 4v6H4M14 20v-6h6M10 10 4 4M14 14l6 6"/></svg>` : `<svg class="i" viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>`}</button>
      <button class="icb" data-vw="more" title="More"><svg class="i" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/></svg></button>
    </div><div class="vw-frame"></div><div class="vw-f mono"></div>`;
  body.querySelector(".vw-name .t").textContent = it.title || basename(it.path);
  body.querySelector(".vw-f").textContent = r.missing ? `${it.short || it.path} · not found` : (it.short || it.path);
  const frame = body.querySelector(".vw-frame");
  if (r.missing) frame.appendChild(el("div", "panel-empty", "This file isn't there anymore."));
  else if (r.error) frame.appendChild(el("div", "panel-empty", esc(r.error)));
  else if (r.html != null) {
    const f = el("iframe");
    f.setAttribute("sandbox", "allow-scripts");  // its own null origin: scripts run, but can't reach Tether or the network
    const [sx, sy] = viewShown.scroll;
    const html = await fillLibs(r.html);
    if (state.tab !== "view" || state.active !== S.sid || S.viewSel !== it.path) return;
    f.srcdoc = html + HASH_JS + NOTE_JS + `<script>addEventListener("load",()=>scrollTo(${sx},${sy}));addEventListener("scroll",()=>parent.postMessage({tetherScroll:[scrollX,scrollY]},"*"),{passive:true});<\/script>`;
    frame.appendChild(f); frame.classList.add("page");
  } else if (r.type === "image") {
    const im = el("img"); im.src = r.src; im.onclick = () => S.commenting || frame.classList.toggle("actual"); im.title = "Click for actual size";
    frame.appendChild(im); frame.classList.add("pic");
    if (!r.src) frame.innerHTML = `<div class="panel-empty">Too large to show</div>`;
  } else if (r.binary) frame.appendChild(el("div", "panel-empty", "No text view for this file."));
  else if (r.type === "markdown" && viewShown.mode === "file") {
    const d = el("div", "msg-text vw-md"); window.renderMarkdown(d, r.text || ""); hydrate(S, d); frame.appendChild(d); frame.classList.add("scroll");
  } else if (viewShown.mode === "changes" && ch) {
    const pre = el("pre", "vw-diff");
    pre.innerHTML = ch.diff.split("\n").slice(2).map(l => `<div class="${l[0] === "+" ? "add" : l[0] === "-" ? "del" : l.startsWith("@@") ? "hunk" : ""}">${esc(l) || " "}</div>`).join("");
    frame.appendChild(pre); frame.classList.add("scroll");
  } else {
    const lines = (r.text || "").split("\n"), lit = new Set(ch?.lines || []);
    const pre = el("pre", "peek-code vw-code");
    pre.innerHTML = lines.slice(0, 20000).map((t, i) => `<div class="${lit.has(i + 1) ? "chg" : ""}"><i>${i + 1}</i>${esc(t) || " "}</div>`).join("");
    frame.appendChild(pre); frame.classList.add("scroll");
    if (r.cut) frame.appendChild(el("div", "peek-wait", "Showing the first 2 MB"));
    frame.onscroll = () => { viewShown.scroll = [frame.scrollLeft, frame.scrollTop]; };
    if (same || refresh) { frame.scrollLeft = viewShown.scroll[0]; frame.scrollTop = viewShown.scroll[1]; }
    else if (lit.size) requestAnimationFrame(() => { const c = pre.querySelector(".chg"); if (c) frame.scrollTop = Math.max(0, c.offsetTop - 80); });
  }
  if (frame.classList.contains("scroll") && r.type === "markdown") { frame.onscroll = () => { viewShown.scroll = [0, frame.scrollTop]; }; if (same) frame.scrollTop = viewShown.scroll[1]; }
  if (!old) wireNotes(S, it, r, frame);
  const act = (k, fn) => { const b = body.querySelector(`[data-vw="${k}"]`); if (b) b.onclick = e => { e.stopPropagation(); fn(b); }; };
  act("comment", () => setCommenting(S, !S.commenting));
  act("done", () => setCommenting(S, false));
  act("reload", () => renderView(S, body, true));
  act("full", () => { document.body.classList.toggle("view-full"); applyPanelW(); renderView(S, body, true); });
  act("latest", () => { S.viewN = 0; renderView(S, body, true); });
  act("restore", async () => {
    const ok = await confirmBox(`Restore v${r.shown}?`, `The file goes back to v${r.shown}. What's there now stays as a version, so you can undo this.`, "Restore", "primary");
    if (!ok) return;
    const x = await api().view_restore(it.path, r.shown);
    if (x?.error) return toast(x.error, "error");
    S.viewN = 0; renderView(S, body, true);
  });
  act("prev", () => { S.viewSel = imgs[ii - 1].path; renderView(S, body); });
  act("next", () => { S.viewSel = imgs[ii + 1].path; renderView(S, body); });
  act("more", b => viewMenu(b, [
    !it.src && { a: r.type === "page" || r.type === "svg" ? "Open in browser" : "Open", fn: () => api().open_path(S.sid, it.path, "file") },
    !it.src && { a: "Show in Finder", fn: () => api().reveal(it.path) },
    !it.src && { a: "Copy path", fn: () => api().copy(it.path) },
    it.from === "you" && "sep",
    it.from === "you" && { a: "Remove from Shelf", fn: async () => {
      if (it.src) S.viewMem = (S.viewMem || []).filter(x => x !== it); else await api().view_open(S.sid, it.path, false);
      S.viewSel = null; await loadView(S); if (state.tab === "view") renderView(S, body);
    } },
  ]));
  body.querySelector(".vw-name").onclick = async e => {
    e.stopPropagation();
    viewMenu(e.currentTarget, viewPicker(S, body));
  };
  body.querySelector(".vw-ver")?.addEventListener("click", e => {
    e.stopPropagation();
    viewMenu(e.currentTarget, [...vs].reverse().map(v => ({ a: `v${v.n}${v.note ? " · " + v.note : ""}`, b: ago(v.ts) === "now" ? "just now" : ago(v.ts) + " ago", on: v.n === r.shown,
      fn: () => { S.viewN = v.n === r.n ? 0 : v.n; renderView(S, body, true); } })));
  });
  body.querySelectorAll(".vw-mode [data-m]").forEach(b => b.onclick = () => { viewShown.mode = b.dataset.m; viewShown.scroll = [0, 0]; renderView(S, body, true); });
}
function viewPicker(S, body) {
  const pick = x => ({ a: x.title || basename(x.path), b: VIEW_TYPE[x.type] || "", on: x.path === S.viewSel, fn: () => { S.viewSel = x.path; S.viewN = 0; S.viewBase = null; renderView(S, body); } });
  const now = S.viewItems.filter(x => !x.old), earlier = S.viewItems.filter(x => x.old).reverse();  // earlier: newest first
  const mine = now.filter(x => x.from === "claude"), yours = now.filter(x => x.from !== "claude");
  const heads = mine.length > 0 && yours.length > 0;
  return [heads && mine.length && { hd: "Built by Claude" }, ...mine.map(pick),
    heads && "sep", heads && { hd: "Opened" }, ...yours.map(pick),
    earlier.length && now.length && "sep", earlier.length && { hd: "Earlier" }, ...earlier.map(pick)];
}
// nothing on this chat's Shelf yet, or nothing recent: older items stay one click away
function renderShelfEmpty(S, body) {
  body.classList.remove("view-body");
  body.innerHTML = "";
  const old = (S.viewItems || []).filter(x => x.old).length;
  const box = el("div", "panel-empty", old ? `Nothing new on the Shelf. <a class="shelf-earlier">Earlier (${old})</a>` : "Nothing on the Shelf yet.");
  box.querySelector(".shelf-earlier")?.addEventListener("click", e => { e.stopPropagation(); viewMenu(e.currentTarget, viewPicker(S, body)); });
  body.appendChild(box);
}
function viewMenu(anchor, rows) {
  let m = $("#view-menu");
  if (!m) { m = el("div", "popup menu view-menu"); m.id = "view-menu"; document.body.appendChild(m); }
  rows = rows.filter(Boolean);
  m.innerHTML = rows.map((x, i) => x === "sep" ? `<div class="sep"></div>` : x.hd ? `<div class="hd">${esc(x.hd)}</div>`
    : `<div class="it${x.on ? " on" : ""}" data-i="${i}"><span class="ck">${x.on ? "✓" : ""}</span><span class="txt"><span class="a">${esc(x.a)}</span>${x.b ? `<span class="b">${esc(x.b)}</span>` : ""}</span></div>`).join("");
  m.querySelectorAll("[data-i]").forEach(n => n.onclick = e => { e.stopPropagation(); m.hidden = true; rows[+n.dataset.i].fn(); });
  m.hidden = false;
  const r = anchor.getBoundingClientRect(), w = Math.min(320, innerWidth - 16);
  Object.assign(m.style, { width: w + "px", left: Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px", top: r.bottom + 6 + "px", maxHeight: Math.max(160, innerHeight - r.bottom - 20) + "px" });
}
// the side panel's width: one per tab, from dragging its left edge; View starts wider, since pages need room
function applyPanelW() {
  const p = $("#panel");
  if (document.body.classList.contains("view-full") && state.tab === "view") { p.style.width = ""; return; }
  const max = Math.max(320, innerWidth - ($("#side").offsetWidth || 0) - 420);
  p.style.width = Math.max(320, Math.min(max, +(state.settings.panel_w || {})[state.tab] || (state.tab === "view" ? 600 : 380))) + "px";
}
function wirePanelGrip() {
  const g = $("#panel-grip");
  g.onmousedown = e => {
    e.preventDefault();
    const x0 = e.clientX, w0 = $("#panel").offsetWidth, max = Math.max(320, innerWidth - ($("#side").offsetWidth || 0) - 420);
    document.body.classList.add("resizing");
    const move = ev => { $("#panel").style.width = Math.max(320, Math.min(max, w0 + x0 - ev.clientX)) + "px"; };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      const panel_w = { ...(state.settings.panel_w || {}), [state.tab]: $("#panel").offsetWidth };
      api().save_settings({ panel_w }).then(s => { state.settings = s; });
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  };
  g.ondblclick = () => { const panel_w = { ...(state.settings.panel_w || {}) }; delete panel_w[state.tab]; api().save_settings({ panel_w }).then(s => { state.settings = s; applyPanelW(); }); };
}
window.addEventListener("message", e => {  // the sealed page reports where it's scrolled, so a reload keeps the place
  if (diag.frame && e.source === diag.frame.contentWindow) {  // the diagram frame: ready, or a drawn diagram
    if (e.data?.tetherDiagReady) diag.onReady?.();
    const done = diag.wait.get(e.data?.tetherDiag);
    if (done) { diag.wait.delete(e.data.tetherDiag); done(e.data.svg || null); }
    return;
  }
  const f = document.querySelector("#panel-body .vw-frame iframe");
  if (!f || e.source !== f.contentWindow) return;
  if (Array.isArray(e.data?.tetherScroll)) viewShown.scroll = e.data.tetherScroll.map(Number);
  const S = state.open.get(state.active), it = S && (S.viewItems || []).find(x => x.path === S.viewSel);
  if (!S?.commenting || !it) return;
  if (e.data?.tetherNoteEsc) return closeNoteBox() || setCommenting(S, false);
  const d = e.data?.tetherNote;
  if (!d) return;
  const b = f.getBoundingClientRect(), k = b.width / (d.vw || b.width);
  noteBox(S, it, f.closest(".vw-frame"), b.left + d.cx * k, b.top + d.cy * k,
    d.n ? { n: d.n } : { x: +d.x, y: +d.y, vw: d.vw, vh: d.vh, part: String(d.part || "").slice(0, 160) });
});
// live: while View is showing, look for changes to its file about every 1.5 seconds (a stat, not a read)
setInterval(async () => {
  if (!state.panel || state.tab !== "view" || document.hidden) return;
  const S = state.open.get(state.active);
  if (!S || viewShown.sid !== S.sid || !viewShown.path || viewShown.path.startsWith("mem:") || S.viewN) return;
  const st = await api().view_stat(viewShown.path);
  if (st && !st.missing && (st.mtime !== viewShown.mtime || st.size !== viewShown.size) && state.tab === "view") renderView(S, $("#panel-body"), true);
}, 1500);

// ---------- charts and diagrams: Tether's own Mermaid, Chart.js and D3 (ui/lib) ----------
// A Shelf page's CDN links come back from Python as markers; each library crosses into the window once, then fills
// every page that asks for it. ```mermaid blocks in replies and Markdown are drawn in a hidden sealed frame (no
// network, no reach into Tether) and shown as a picture, so nothing from the diagram runs in the window.
const libCache = {};
const libSource = n => libCache[n] ??= Promise.resolve(api().lib_source(n)).then(s => s || "");
async function fillLibs(html) {
  for (const n of ["mermaid", "chartjs", "d3"]) {
    const mark = `<script data-tether-lib="${n}"></script>`;
    if (html.includes(mark)) { const src = await libSource(n); html = html.replace(mark, () => `<script>${src}<\/script>`); }
  }
  return html;
}
const diag = { frame: null, ready: null, n: 0, wait: new Map(), cache: new Map() };
function diagFrame() {
  return diag.ready ??= libSource("mermaid").then(src => new Promise(res => {
    const f = el("iframe");
    f.setAttribute("sandbox", "allow-scripts"); f.setAttribute("aria-hidden", "true");
    f.style.cssText = "position:fixed;left:-10000px;top:0;width:1000px;height:800px;border:0;visibility:hidden";
    f.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:"><body><script>${src}<\/script><script>
addEventListener("message", async e => { const d = e.data || {}; if (!d.id) return;
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: d.theme, htmlLabels: false, flowchart: { htmlLabels: false } });
    let { svg } = await mermaid.render("dg" + d.id, d.code);
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml"), r = doc.documentElement, vb = (r.getAttribute("viewBox") || "").split(/[\\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0) { r.setAttribute("width", Math.ceil(vb[2])); r.setAttribute("height", Math.ceil(vb[3])); r.style.removeProperty("max-width"); }
    parent.postMessage({ tetherDiag: d.id, svg: new XMLSerializer().serializeToString(r) }, "*");
  } catch (err) { parent.postMessage({ tetherDiag: d.id, error: String(err && err.message || err) }, "*"); }
  document.querySelectorAll("body > [id^=ddg], body > [id^=dg]").forEach(n => n.remove());
});
parent.postMessage({ tetherDiagReady: 1 }, "*");<\/script>`;
    diag.frame = f; diag.onReady = res;
    document.body.appendChild(f);
  }));
}
function diagTheme() {
  const dark = document.body.classList.contains("dark");
  const accent = /^#[0-9a-f]{6}$/i.test(state.settings?.accent || "") ? state.settings.accent : dark ? "#6CCDE3" : "#0B6E86";
  return dark
    ? { darkMode: true, background: "transparent", primaryColor: "#1d2a31", primaryBorderColor: accent, primaryTextColor: "#F1F5F7", secondaryColor: "#1d2a31", tertiaryColor: "#18232a",
        lineColor: "#A6B2B9", textColor: "#F1F5F7", edgeLabelBackground: "#141b20", clusterBkg: "#18232a", clusterBorder: "#3a4a53", fontFamily: "-apple-system, Helvetica, sans-serif", fontSize: "13px" }
    : { darkMode: false, background: "transparent", primaryColor: "#eef4f6", primaryBorderColor: accent, primaryTextColor: "#16232a", secondaryColor: "#eef4f6", tertiaryColor: "#f6f8f9",
        lineColor: "#5b6b73", textColor: "#16232a", edgeLabelBackground: "#ffffff", clusterBkg: "#f6f8f9", clusterBorder: "#c9d3d8", fontFamily: "-apple-system, Helvetica, sans-serif", fontSize: "13px" };
}
// the picture for one diagram (a data: URL), or null if Mermaid can't read it; kept per theme, so redraws while a reply streams are instant
function diagram(code) {
  const theme = diagTheme(), key = (theme.darkMode ? "d" : "l") + theme.primaryBorderColor + code;
  if (!diag.cache.has(key)) diag.cache.set(key, diagFrame().then(() => new Promise(res => {
    const id = ++diag.n;
    diag.wait.set(id, res);
    diag.frame.contentWindow.postMessage({ id, code, theme }, "*");
    setTimeout(() => { if (diag.wait.delete(id)) res(null); }, 15000);
  })).then(svg => svg ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg) : null));
  return diag.cache.get(key);
}
window.drawDiagrams = root => root.querySelectorAll(".code[data-diagram]:not(.drawn)").forEach(async box => {
  const code = box.querySelector("code").textContent, src = await diagram(code);
  if (!src || !box.isConnected || box.classList.contains("drawn")) return;  // Mermaid couldn't read it: it stays as code
  box.classList.add("drawn");
  const pic = el("div", "diag-pic"), im = el("img");
  im.src = src; im.alt = "Diagram"; im.title = "Click to see it bigger";
  im.onload = () => { im.style.minWidth = Math.min(im.naturalWidth, 520) + "px"; };  // a narrow chat scrolls it sideways rather than shrink the text away
  im.onclick = () => showPeek(im, { src, label: "Diagram" });
  pic.appendChild(im);
  box.querySelector("pre").before(pic);
  const head = box.querySelector(".code-head"), acts = el("span", "diag-acts");
  head.querySelector("span").textContent = "diagram";
  const show = el("button", "copy", "show code");
  show.onclick = e => { e.stopPropagation(); show.textContent = box.classList.toggle("show-code") ? "hide code" : "show code"; };
  acts.append(show, head.querySelector("[data-copy]"));
  if (!box.closest(".vw-md")) {
    const shelf = el("button", "copy", "open on Shelf");
    shelf.onclick = async e => {
      e.stopPropagation();
      const S = state.open.get(state.active);
      if (!S) return;
      const it = { path: `mem:${Date.now()}`, src, title: "Diagram", type: "image", from: "you", code };
      (S.viewMem ||= []).push(it); await loadView(S); openInView(S, it.path);
    };
    acts.appendChild(shelf);
  }
  head.appendChild(acts);
});
// light or dark changed: draw the diagrams again in the new colors
function redrawDiagrams() {
  document.querySelectorAll(".code[data-diagram].drawn").forEach(b => { b.classList.remove("drawn", "show-code"); b.querySelector(".diag-pic")?.remove();
    const acts = b.querySelector(".diag-acts"), cp = acts?.querySelector("[data-copy]"); if (cp) b.querySelector(".code-head").appendChild(cp); acts?.remove();
    b.querySelector(".code-head span").textContent = "mermaid"; });
  document.querySelectorAll(".msg-text, .vw-md").forEach(r => window.drawDiagrams(r));
}

// ---------- notes on the Shelf: click a spot, type a note, and the notes go with your next message ----------
// Pages and pictures get numbered pins and Claude gets a picture of them; code takes a note on a line, Markdown on
// the paragraph. On a page Tether also records the part under the pin (its tag, class and text), so Claude can find
// it in the code. The script below runs inside the sealed page; it only reports clicks and draws the pins.
// A sealed page's base address is Tether's own, so a "#section" link would load Tether into the frame; scroll instead.
const HASH_JS = `<script>addEventListener("click",e=>{const a=e.target.closest&&e.target.closest('a[href^="#"]');if(!a||e.defaultPrevented)return;e.preventDefault();const id=decodeURIComponent(a.getAttribute("href").slice(1));const t=id?document.getElementById(id)||document.getElementsByName(id)[0]:document.body;t&&t.scrollIntoView({behavior:"smooth",block:"start"});});<\/script>`;
const NOTE_JS = `<script>(()=>{let on=false,pins=[],L=null,color="#0B6E86";
const st=document.createElement("style");st.textContent="html.tether-c,html.tether-c *{cursor:crosshair!important}";
const draw=()=>{if(!L){L=document.createElement("div");L.style.cssText="position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647";document.documentElement.appendChild(L);}
 L.innerHTML="";for(const p of pins){const d=document.createElement("div");d.textContent=p.n;d.dataset.tetherPin=p.n;
 d.style.cssText="position:absolute;left:"+(p.x-11)+"px;top:"+(p.y-11)+"px;width:22px;height:22px;border-radius:50%;background:"+color+";color:#fff;font:600 12px/22px -apple-system,Helvetica,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff,0 2px 6px rgba(0,0,0,.35);pointer-events:"+(on?"auto":"none");L.appendChild(d);}};
const txt=e=>((e.getAttribute&&(e.getAttribute("aria-label")||e.getAttribute("title")||e.getAttribute("alt")))||e.innerText||e.textContent||"").replace(/\\s+/g," ").trim();
const name=e=>{const s=e.tagName.toLowerCase();if(e.id)return s+"#"+e.id;const c=[...e.classList].slice(0,2);return s+(c.length?"."+c.join("."):"");};
const part=t=>{let e=t;while(e&&e!==document.body&&e.parentElement&&txt(e).length<2&&!/^(canvas|svg|img|video)$/i.test(e.tagName))e=e.parentElement;
 if(!e||e===document.body||e===document.documentElement)return"";const ch=[];let a=e;while(a&&a!==document.body&&ch.length<3){ch.unshift(name(a));if(a.id)break;a=a.parentElement;}
 let s=txt(e);if(s.length>70)s=s.slice(0,67)+"…";return ch.join(" > ")+(s?' "'+s+'"':"");};
const stop=e=>{if(on){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();}};
["mousedown","mouseup","pointerdown","pointerup","dblclick","auxclick","submit","contextmenu"].forEach(k=>addEventListener(k,stop,true));
addEventListener("click",e=>{if(!on)return;stop(e);const p=e.target.closest&&e.target.closest("[data-tether-pin]");
 parent.postMessage({tetherNote:{x:e.pageX,y:e.pageY,cx:e.clientX,cy:e.clientY,vw:innerWidth,vh:innerHeight,n:p?+p.dataset.tetherPin:0,part:p?"":part(e.target)}},"*");},true);
addEventListener("keydown",e=>{if(on&&e.key==="Escape")parent.postMessage({tetherNoteEsc:1},"*");},true);
addEventListener("message",e=>{if(e.source!==parent)return;const d=e.data||{};if(!("tetherPins" in d))return;
 on=!!d.on;pins=d.tetherPins||[];color=d.color||color;(document.head||document.documentElement).appendChild(st);document.documentElement.classList.toggle("tether-c",on);draw();});
})()<\/script>`;
const NOTE_ICON = `<svg class="i" viewBox="0 0 24 24"><path d="M5 5h14v10H10l-4 4v-4H5z"/></svg>`;
const notesOn = (S, path) => (S.notes || []).filter(x => x.path === path);
const accentFill = () => getComputedStyle(document.body).getPropertyValue("--accent-fill").trim() || "#0B6E86";
function setCommenting(S, on) {
  S.commenting = on; closeNoteBox();
  if (state.panel && state.tab === "view" && state.active === S.sid) renderView(S, $("#panel-body"), true);
}
// what the Shelf is showing can take notes: a page or SVG, a picture, code (not a diff or an older version), Markdown
function noteKind(r, it) {
  if (r.missing || r.error || r.binary) return "";
  if (r.html != null) return "page";
  if (r.type === "image") return r.src ? "image" : "";
  return r.type === "markdown" && viewShown.mode === "file" ? "markdown" : viewShown.mode === "changes" ? "" : "code";
}
// pins for what's on the Shelf now, drawn inside the page or over the picture, code or Markdown
function drawNotes(S, it, frame) {
  const mine = notesOn(S, it.path), kind = frame.dataset.noteKind;
  frame.classList.toggle("commenting", !!S.commenting);
  if (kind === "page") {
    const f = frame.querySelector("iframe");
    f?.contentWindow?.postMessage({ tetherPins: mine.map(x => ({ n: x.n, x: x.x, y: x.y })), on: !!S.commenting, color: accentFill() }, "*");
    return;
  }
  frame.querySelectorAll(".note-pin").forEach(p => p.remove());
  const pin = (x, host, css) => { const p = el("span", "note-pin", String(x.n)); Object.assign(p.style, css); p.onclick = e => { if (!S.commenting) return; e.stopPropagation(); noteBox(S, it, frame, e.clientX, e.clientY, x); }; host.appendChild(p); };
  if (kind === "image") {
    const im = frame.querySelector("img"), lay = frame.querySelector(".note-layer");
    if (!im || !lay) return;
    Object.assign(lay.style, { left: im.offsetLeft + "px", top: im.offsetTop + "px", width: im.offsetWidth + "px", height: im.offsetHeight + "px" });
    mine.forEach(x => pin(x, lay, { left: x.fx * 100 + "%", top: x.fy * 100 + "%" }));
  } else if (kind === "markdown") {
    const md = frame.querySelector(".vw-md");
    mine.forEach(x => pin(x, md, { left: x.fx * 100 + "%", top: x.y + "px" }));
  } else if (kind === "code") {
    const rows = frame.querySelectorAll(".vw-code > div");
    mine.forEach(x => rows[x.line - 1] && pin(x, rows[x.line - 1], { left: "2px", top: "50%" }));
  }
}
function wireNotes(S, it, r, frame) {
  const kind = noteKind(r, it);
  frame.dataset.noteKind = kind;
  if (!kind) return;
  if (kind === "page") { const f = frame.querySelector("iframe"); f.addEventListener("load", () => drawNotes(S, it, frame)); return; }
  if (kind === "image") {
    const im = frame.querySelector("img");
    frame.appendChild(el("div", "note-layer"));
    im.addEventListener("load", () => drawNotes(S, it, frame));
    new ResizeObserver(() => frame.isConnected && drawNotes(S, it, frame)).observe(frame);
    im.addEventListener("click", e => {
      if (!S.commenting) return;
      e.stopImmediatePropagation(); frame.classList.remove("actual");
      const b = im.getBoundingClientRect();
      noteBox(S, it, frame, e.clientX, e.clientY, { fx: (e.clientX - b.left) / b.width, fy: (e.clientY - b.top) / b.height });
    }, true);
  } else frame.addEventListener("click", e => {
    if (!S.commenting || e.target.closest(".note-pin, a, button")) return;
    if (kind === "code") {
      const row = e.target.closest(".vw-code > div");
      if (!row) return;
      const line = [...row.parentNode.children].indexOf(row) + 1;
      return noteBox(S, it, frame, e.clientX, e.clientY, { line, part: row.textContent.replace(/^\d+/, "").trim().slice(0, 80) });
    }
    const md = frame.querySelector(".vw-md"), b = md.getBoundingClientRect(), blk = e.target.closest("p, li, h1, h2, h3, h4, td, th, pre, blockquote, .table-card, .code");
    let t = (blk?.innerText || "").replace(/\s+/g, " ").trim();
    if (t.length > 70) t = t.slice(0, 67) + "…";
    noteBox(S, it, frame, e.clientX, e.clientY, { fx: (e.clientX - b.left) / b.width, y: e.clientY - b.top, part: t ? `"${t}"` : "" });
  });
  drawNotes(S, it, frame);
}
// the box for typing a note: new at a spot, or an existing note to change or delete
function noteBox(S, it, frame, cx, cy, at) {
  closeNoteBox();
  const old = at.n ? notesOn(S, it.path).find(x => x.n === at.n) : null;
  if (at.n && !old) return;
  const box = el("div", "note-box popup", `<textarea rows="3" placeholder="Note for Claude"></textarea><div class="acts">${old ? `<button class="btn ghost small" data-k="del">Delete</button>` : ""}<span class="spacer"></span><button class="btn ghost small" data-k="no">Cancel</button><button class="btn small primary" data-k="ok">${old ? "Save" : "Add"}</button></div>`);
  box.id = "note-box";
  document.body.appendChild(box);
  const ta = box.querySelector("textarea");
  ta.value = old?.text || "";
  const w = 260, h = box.offsetHeight || 120;
  box.style.left = Math.max(8, Math.min(cx + 14, innerWidth - w - 8)) + "px";
  box.style.top = Math.max(8, Math.min(cy - 10, innerHeight - h - 8)) + "px";
  const save = () => {
    const text = ta.value.trim();
    if (!text) return old ? del() : closeNoteBox();
    if (old) old.text = text;
    else {
      const mine = notesOn(S, it.path);
      (S.notes ||= []).push({ ...at, path: it.path, title: it.title || basename(it.path), short: it.short || it.path, src: it.src || "", kind: frame.dataset.noteKind, n: mine.length + 1, text });
    }
    closeNoteBox(); drawNotes(S, it, frame); renderAttachments();
  };
  const del = () => {
    S.notes = S.notes.filter(x => x !== old);
    notesOn(S, it.path).forEach((x, i) => x.n = i + 1);
    closeNoteBox(); drawNotes(S, it, frame); renderAttachments();
  };
  box.querySelectorAll("[data-k]").forEach(b => b.onclick = e => { e.stopPropagation(); ({ ok: save, no: closeNoteBox, del })[b.dataset.k](); });
  ta.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } else if (e.key === "Escape") closeNoteBox(); };
  box.onmousedown = e => e.stopPropagation();
  ta.focus();
}
function closeNoteBox() { const b = $("#note-box"); if (!b) return false; b.remove(); return true; }
document.addEventListener("mousedown", e => { if (!e.target.closest("#note-box")) closeNoteBox(); });
// redraw the pins if the file with these notes is on the Shelf now
function refreshNotePins(S) {
  const frame = document.querySelector("#panel-body .vw-frame");
  const it = S && state.tab === "view" && state.panel && state.active === S.sid && (S.viewItems || []).find(x => x.path === S.viewSel);
  if (frame && it) drawNotes(S, it, frame);
}
// a picture with numbered pins, drawn from one on the Shelf (no larger than 1000 px across)
function pinnedPicture(src, notes) {
  return new Promise(res => {
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, 1000 / im.naturalWidth), w = Math.round(im.naturalWidth * k), h = Math.round(im.naturalHeight * k);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(im, 0, 0, w, h);
      notes.forEach(x => {
        const px = x.fx * w, py = x.fy * h;
        g.beginPath(); g.arc(px, py, 13, 0, 7); g.fillStyle = "#fff"; g.fill();
        g.beginPath(); g.arc(px, py, 11, 0, 7); g.fillStyle = accentFill(); g.fill();
        g.fillStyle = "#fff"; g.font = "600 12px -apple-system, Helvetica, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(String(x.n), px, py + .5);
      });
      try { res({ data: c.toDataURL("image/jpeg", .85).split(",")[1], media_type: "image/jpeg" }); } catch { res(null); }
    };
    im.onerror = () => res(null);
    im.src = src;
  });
}
// the notes as they go to Claude: one line each, grouped by file, plus a picture for pages and pictures
async function notesMessage(S) {
  const groups = new Map();
  (S.notes || []).forEach(x => { if (!groups.has(x.path)) groups.set(x.path, []); groups.get(x.path).push(x); });
  const text = [], images = [];
  for (const [path, list] of groups) {
    const first = list[0], mem = path.startsWith("mem:");
    let pic = null;
    if (first.kind === "page") {
      pic = await api().note_shot(path, first.vw, first.vh, list.map(x => ({ n: x.n, x: x.x, y: x.y })), accentFill(), document.body.classList.contains("dark"));
      if (pic?.error) { toast("Couldn't draw the page for your notes: " + pic.error, "error"); pic = null; }
    } else if (first.kind === "image") pic = await pinnedPicture(first.src || (await api().view_get(S.sid, path, 0, 0))?.src, list);
    if (pic) images.push({ ...pic, label: `Notes · ${first.title}` });
    const where = x => x.kind === "code" ? `line ${x.line}${x.part ? ` (\`${x.part.replace(/`/g, "'")}\`)` : ""}`
      : x.kind === "image" ? `at ${Math.round(x.fx * 100)}% across, ${Math.round(x.fy * 100)}% down`
      : x.part || (x.kind === "page" ? `at ${Math.round(x.x)}, ${Math.round(x.y)} px` : "");
    const what = mem ? `the picture "${first.title}" on the Shelf` : tilde(first.short || path);
    text.push(`Notes on ${what}${pic ? " (numbered pins in the attached picture)" : ""}:\n` + list.map(x => `${x.n}. ${where(x) ? where(x) + ": " : ""}${x.text}`).join("\n")
      + (mem && S.viewItems?.find(v => v.path === path)?.code ? `\nIt was drawn from this Mermaid code:\n\`\`\`mermaid\n${S.viewItems.find(v => v.path === path).code}\n\`\`\`` : ""));
  }
  return { text: text.join("\n\n"), images };
}

// ---------- the working marker: when you've scrolled up, a small note says Claude is still going ----------
function syncJump() {
  const S = state.open.get(state.active), j = $("#jump");
  if (!j) return;
  j.onclick ||= () => {  // back to the bottom, following Claude again
    const A = state.open.get(state.active);
    if (!A) return;
    A.stick = true; A.newReply = false; A.el.scrollTop = A.el.scrollHeight; syncJump();
  };
  if (S?.stick) S.newReply = false;
  const busy = !!S && ["running", "starting", "waiting"].includes(S.status), show = !!S && !S.stick && (busy || S.newReply);
  j.hidden = !show;
  if (!show) return;
  j.classList.toggle("done", !busy);
  j.querySelector(".t").textContent = busy ? "Working" : "New reply";
}

function setToolOutput(t, out) {
  t.querySelectorAll(".out").forEach(n => n.hidden = !out);
  t.querySelector("pre.out").textContent = out;
}

function addPermission(S, ev) {
  const card = el("div", "perm" + (ev.guarded ? " guarded" : ""));
  S.perms.set(ev.rid, card);
  S.cur = null;
  if (ev.kind === "question") return dockPerm(S, add(S, questionCard(S, ev, card)));
  if (ev.kind === "plan") {
    card.innerHTML = `<div class="ph">Plan ready for review</div><div class="msg-text"></div><div class="acts"></div>`;
    window.renderMarkdown(card.querySelector(".msg-text"), ev.plan);
    const acts = card.querySelector(".acts");
    acts.append(btn("Approve plan", "primary", () => answer(S, ev.rid, "allow")),
      btn("Keep planning", "", () => answer(S, ev.rid, "deny", null, "The user wants to keep planning. Ask what to change.")));
    return dockPerm(S, add(S, card));
  }
  card.innerHTML = `<div class="ph">${ev.guarded ? `<span class="badge">Always asks</span>` : ""}<span></span></div>`;
  card.querySelector(".ph span:last-child").textContent = ev.tool === "Bash" ? "Run this command?" : `Allow ${ev.label}?`;
  if (ev.diff) card.appendChild(makeDiff(ev.diff));
  else { const pre = el("pre"); pre.textContent = ev.detail; card.appendChild(pre); }
  if (ev.reason && !ev.guarded) { const w = el("div", "why"); w.textContent = ev.reason; card.appendChild(w); }
  const acts = el("div", "acts");
  acts.append(btn(ev.tool === "Bash" ? "Run" : "Allow", "primary", () => answer(S, ev.rid, "allow")));
  if (!ev.guarded) acts.append(btn(ev.tool === "Bash" ? `Always allow “${(ev.detail.split(/\s+/)[0] || "").slice(0, 24)}” here` : "Always allow here", "", () => answer(S, ev.rid, "always")));
  acts.append(btn("Deny", "danger", () => answer(S, ev.rid, "deny")));
  acts.append(el("span", "hint", "⌘↩ allow · ⌘⌫ deny"));
  card.appendChild(acts);
  dockPerm(S, add(S, card));
}
// Approvals and questions wait docked above the message box, so you never scroll to find one. Once answered,
// each goes back to its place in the chat as a one-line record.
function dockPerm(S, card) {
  const slot = el("div", "perm-slot");
  card.before(slot);
  card.dockSlot = slot; card.dataset.sid = S.sid;
  $("#perm-dock").appendChild(card);
  syncDock();
  return card;
}
function undockPerm(card) {
  if (!card.closest("#perm-dock")) return;
  if (card.dockSlot?.isConnected) card.dockSlot.replaceWith(card); else card.remove();
  syncDock();
}
function dropDocked(sid) { document.querySelectorAll("#perm-dock > .perm").forEach(c => { if (c.dataset.sid === sid) c.remove(); }); syncDock(); }
function syncDock() { document.querySelectorAll("#perm-dock > .perm").forEach(c => { c.hidden = c.dataset.sid !== state.active; }); }
function questionCard(S, ev, card) {
  card.innerHTML = `<div class="ph">Claude is asking</div>`;
  const picks = ev.questions.map(() => new Set());
  const others = [];
  ev.questions.forEach((q, qi) => {
    const box = el("div", "q");
    box.appendChild(el("div", "qt", esc(q.question)));
    const opts = el("div", "opts");
    (q.options || []).forEach(o => {
      const b = el("button", "opt", `${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ""}`);
      b.onclick = () => {
        if (!q.multiSelect) { picks[qi].clear(); opts.querySelectorAll(".opt").forEach(x => x.classList.remove("sel")); }
        picks[qi].has(o.label) ? picks[qi].delete(o.label) : picks[qi].add(o.label);
        b.classList.toggle("sel", picks[qi].has(o.label));
      };
      opts.appendChild(b);
    });
    const other = el("input", "other");
    other.placeholder = "Other…";
    others.push(other);
    box.append(opts, other);
    card.appendChild(box);
  });
  const acts = el("div", "acts");
  acts.append(btn("Submit", "primary", () => {
    const answers = {};
    ev.questions.forEach((q, i) => { const v = others[i].value.trim() || [...picks[i]].join(", "); if (v) answers[q.question] = v; });
    answer(S, ev.rid, "allow", answers);
  }), btn("Skip", "", () => answer(S, ev.rid, "deny", null, "The user skipped the question. Use your best judgement.")));
  card.appendChild(acts);
  return card;
}
function btn(label, cls, fn) { const b = el("button", "btn small " + cls, esc(label)); b.onclick = fn; return b; }
function answer(S, rid, choice, answers, note) { api().answer(S.sid, rid, choice, answers || null, note || ""); }
function permDone(S, rid, choice) {
  const c = S.perms.get(rid);
  if (!c) return;
  c.classList.add("done");
  const words = { allow: "Allowed", always: "Allowed for this session", deny: "Denied", answered: "Answered", gone: "No longer needed" };
  c.appendChild(el("div", "outcome", words[choice] || choice));
  S.perms.delete(rid);
  undockPerm(c);
}

function setWorking(S, on) {
  let w = S.inner.querySelector(":scope > .working");
  if (on && !w) {
    w = el("div", "working", `<span class="wtext">Working…</span>`);
    const anim = window.WorkAnim?.create(state.settings.working_anim || "mix");
    if (anim) { w.classList.add("anim"); w.prepend(anim.el); w.anim = anim; }
    S.inner.insertBefore(w, S.inner.querySelector(":scope > .msg-user.queued"));
    S.started = S.started || Date.now();
    const txt = w.querySelector(".wtext");
    const tick = () => { txt.textContent = `Working… ${Math.round((Date.now() - S.started) / 1000)}s` + (S.step ? `  ·  ${S.step}` : ""); };
    w.tick = tick;
    S.timer = setInterval(tick, 1000);
    scrollDown(S);
  } else if (!on && w) {
    w.anim?.stop(); w.remove(); clearInterval(S.timer); S.started = 0; S.step = "";
  }
}

function renderItems(S, items) {
  S.replaying = true;
  for (const it of items) {
    if (it.type === "user") addUser(S, it.text, it.images);
    else if (it.type === "text") { const c = textBlock(S); c.src = it.text; window.renderMarkdown(c.el, it.text); hydrate(S, c.el); S.cur = null; }
    else if (it.type === "thinking") thinkBlock(S, it.text, state.view === "thinking");
    else if (it.type === "tool") addTool(S, it, true);
    else if (it.type === "table") add(S, window.makeTable(it));
    else if (it.type === "artifact") add(S, artifactLine(S, { ...it, type: VIEW_TYPE_OF(it.path) }));
    else if (it.type === "compaction") add(S, compactionRow(S, it));
    else if (it.type === "switch") add(S, switchLine(it.text));
  }
  if (items.length) add(S, el("div", "note", "— earlier messages from the saved session —"));
  S.replaying = false;
}

// ---------- events from Python ----------
window.onEvents = list => { for (const ev of list) { try { onEvent(ev); } catch (e) { console.error(e, ev); } } };

function onEvent(ev) {
  const S = ev.sid ? state.open.get(ev.sid) : null;
  if (!S && ev.sid && ev.type === "result") lateReply(ev.sid);
  switch (ev.type) {
    case "session_state": if (S) setStatus(S, ev); break;
    case "models": state.models = ev.models || []; fillModels(); break;
    case "notes":
      if (S) { S.notesProg = ev.busy && ev.of ? `${ev.done}/${ev.of}` : ""; if (state.panel && state.tab === "notes" && state.active === S.sid) renderNotes(S, $("#panel-body")); }
      if (!ev.busy && ev.error) toast("Notes: " + ev.error, "error");
      break;
    case "fresh_start": freshStart(ev); break;
    case "fresh_prep": if (S) S.freshPrep = !ev.done; break;
    case "fast_unavailable": state.settings.fast_unavailable = ev.reason; if (S && S.sid === state.active) syncModes(S); break;
    case "modes": if (S) { S.modes = ev; S.fast = !!ev.want_fast; if (ev.permission) S.permMode = ev.permission; if (S.sid === state.active) syncModes(S); } break;
    case "stale": if (S) markStale(S, ev.where); break;
    case "session_info":
      if (S) { S.commands = ev.commands || S.commands; }
      if (ev.models && ev.models.length && !state.models.length) { state.models = ev.models; fillModels(); }
      break;
    case "text_start": if (S) { thinkDone(S); endText(S); textBlock(S); } break;
    case "text_delta": if (S) textDelta(S, ev.text); break;
    case "thinking_start": if (S) { endText(S); if (!(S.think?.timer && !S.think.querySelector(".body").textContent && !S.think.queue)) thinkBlock(S, "", true, true); } break;
    case "thinking_delta": if (S) { const t = S.think || thinkBlock(S, "", true, true); thinkType(S, t, ev.text); } break;
    case "tool": if (S) { thinkDone(S); endText(S); if (S.think && state.view !== "thinking") S.think.open = false; addTool(S, ev, false); S.step = ev.label; S.inner.querySelector(":scope > .working")?.tick?.(); } break;
    case "tool_progress": if (S) { const t = S.tools.get(ev.id); if (t) { const st = t.querySelector(".steps"); st.appendChild(el("div", "", esc(ev.text))); while (st.children.length > 3) st.firstChild.remove(); } } break;
    case "agent": case "agent_step": case "agent_done": if (S) agentEvent(S, ev); break;
    case "job": case "job_done": if (S) jobEvent(S, ev); break;
    case "tool_result":
      if (S && S.agents?.has(ev.id)) {  // a foreground agent's reply; a background one only says it launched
        const L = S.agents.get(ev.id);
        if (!L.background && !/^Async agent launched/i.test(ev.output || "")) {
          L.result = ev.output || L.result;
          if (L.status === "running" || L.status === "starting") { L.status = ev.ok ? "completed" : "failed"; L.ms ||= Date.now() - L.started; }
          paintAgent(L);
        }
        break;
      }
      if (S) {
        const t = S.tools.get(ev.id);
        if (t) { const i = t.querySelector(".ico"); i.className = "ico " + (ev.ok ? "ok" : "bad"); setToolOutput(t, ev.output); t.querySelector(".steps").innerHTML = ""; }
        const j = [...S.jobs.values()].find(j => j.id === ev.id);
        if (j) { const m = /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(ev.output || ""); if (m) j.output_file ||= m[1]; paintJob(S, j); }
      }
      break;
    case "diff": if (S) { const t = S.tools.get(ev.id); const d = makeDiff(ev, { closed: ev.rows.length > 60 }); t ? t.after(d) : add(S, d); scrollDown(S); } break;
    case "table": if (S) { endText(S); add(S, window.makeTable(ev)); } break;
    case "artifact": if (S) {
      endText(S);
      const line = add(S, artifactLine(S, { ...ev, type: VIEW_TYPE_OF(ev.path) }));
      (S.artLines ||= new Map()).set(ev.id, line);
      onArtifact(S, ev);
    } break;
    case "artifact_checked": {
      const line = S?.artLines?.get(ev.id);
      if (!line) break;
      const errs = (/Script errors: (.*)$/.exec(ev.text || "") || [])[1];
      const n = errs ? errs.split("; ").length : 0;
      const note = el("div", "note art-note", !ev.ok ? "Couldn't show it" : /Picture below/.test(ev.text || "") ? `Checked how it looks${n ? ` · ${n} script error${n === 1 ? "" : "s"}` : ""}` : "");
      if (note.textContent) { if (errs) note.title = errs; line.after(note); }
    } break;
    case "permission": if (S) { endText(S); addPermission(S, ev); if (S.sid !== state.active) toast(`“${S.title || "A session"}” needs your approval`); } break;
    case "permission_done": if (S) permDone(S, ev.rid, ev.choice); break;
    case "requesting": if (S && state.view === "thinking" && !S.think?.timer) { endText(S); thinkBlock(S, "", true, true); } break;
    case "usage": if (S) { S.context = ev.context; if (S.ctxUsage) S.ctxUsage.totalTokens = ev.context; if (S.sid === state.active) showCtx(S); } break;
    case "loaded": if (S && S.sid === state.active && state.panel && state.tab === "stats") { const b = $(".st-loaded"); if (b) fillLoaded(b, S.sid, false); } break;
    case "context": if (S) { S.ctxUsage = ev; S.context = ev.totalTokens; if (S.sid === state.active) showCtx(S); } break;
    case "delivered": if (S) delivered(S, ev.text); break;
    case "compacting": if (S) { S.step = ev.on ? "Compacting the conversation" : ""; S.inner.querySelector(":scope > .working")?.tick?.(); } break;
    case "compacted": if (S) { S.ctxUsage = null; api().context_usage(S.sid); } break;
    case "result": if (S) thinkDone(S);
      if (S) {
        thinkDone(S); endText(S); if (S.think && state.view !== "thinking") S.think.open = false;
        if (!ev.ok && ev.error) add(S, el("div", "err", esc(ev.error)));
        const bits = [ev.ok ? "Done" : (ev.subtype || "Stopped")];
        if (ev.seconds) bits.push(`${ev.seconds}s`);
        add(S, el("div", "footnote", bits.join(" · ")));
        if (S.sid !== state.active) S.unseen = true;
        if (S.sid === state.active) { refreshRepo(true); if (state.panel && state.tab === "stats") setTimeout(renderPanel, 1500); }
      }
      break;
    case "error": if (S) add(S, el("div", "err", esc(ev.text))); else toast(ev.text, "error"); break;
    case "notice": if (S) add(S, el("div", "note", esc(ev.text))); else toast(ev.text, ev.level); break;
    case "compaction": if (S) { add(S, compactionRow(S, ev)); S.lastCompaction = ev; } break;
    case "markup": state.marksUp = !!(ev.marks || []).length; if (!$("#tools-menu").hidden) renderToolsMenu(); break;
    case "level": $("#mic-btn .lvl").style.transform = `scaleX(${Math.min(1, ev.level * 12)})`; break;
    case "dictating":
      state.dictating = ev.on;
      $("#mic-btn").classList.toggle("on", ev.on);
      $("#mic-btn").classList.toggle("busy", !!ev.busy);
      if (!ev.on) $("#mic-btn .lvl").style.transform = "scaleX(0)";
      break;
    case "dictation": {
      $("#mic-btn").classList.remove("busy");
      if (!ev.text) { toast("Didn't catch anything"); break; }
      if (!state.active) { toast("Open a session first: " + ev.text); break; }
      insertText(ev.text);
      if (ev.send) send();
      break;
    }
    case "circling": state.circling = ev.on; $("#circling").hidden = !ev.on; $("#tools-btn").classList.toggle("on", ev.on); break;
    case "circled": {
      const S2 = state.open.get(state.active);
      if (!S2) { toast("Open a session first, then circle again."); break; }
      ev.images.forEach(im => S2.attachments.push(im));
      if (!$("#input").value.trim()) $("#input").value = "Explain what I circled on my screen (the yellow strokes).";
      send();
      break;
    }
  }
}

function setStatus(S, ev) {
  const was = S.status;
  S.status = ev.status;
  if (ev.title) S.title = ev.title;
  if (ev.model !== undefined) S.model = ev.model;
  if (ev.effort !== undefined) S.effort = ev.effort;
  if (ev.context) S.context = ev.context;
  S.lastActive = Date.now() / 1000;
  setWorking(S, ev.status === "running" || ev.status === "starting");
  const going = st => ["running", "starting", "waiting"].includes(st);
  if (going(was) && !going(ev.status) && !S.stick) S.newReply = true;  // it finished while you were reading back
  if (S.sid === state.active) syncJump();
  if (ev.status === "exited" && was !== "exited") add(S, el("div", "note", "Claude Code process ended. Send a message to resume."));
  if (S.sid === state.active) { syncComposer(S); const t = document.querySelector("#bar .thread-title"); if (t && S.title && t.textContent !== S.title) t.textContent = S.title; }
  renderSidebar();
}

// ---------- sidebar ----------
// ---------- sidebar ----------
// Active = sessions loaded in this window (each has a close ×). Pinned stay on top. Recent is everything else
// from Claude Code's history, by date or by repo. Names, pins and the archive are kept by the app.
const ui = JSON.parse(localStorage.getItem("wb.sidebar") || "{}");
ui.view = ui.view || "time";
ui.collapsed = ui.collapsed || { Scratch: true };
const saveUi = () => localStorage.setItem("wb.sidebar", JSON.stringify(ui));
const STATUS_WORDS = { running: "Working…", starting: "Starting…", waiting: "Needs you", done: "Finished", idle: "Idle", exited: "Ended", new: "New", saved: "" };

async function loadHistory() {
  const [list, repos] = await Promise.all([api().list_sessions(), api().discover_repos()]);
  state.sessions = list.sessions;
  state.pinOrder = list.pinned;
  state.repos = repos;
  state.groups = groupsOf(state.sessions.filter(s => !s.archived));
  renderSidebar();
  renderRecentRepos();
}
function groupsOf(items) {  // for the new-session picker: folders with sessions, newest first
  const g = new Map();
  for (const s of items) {
    if (s.scratch) continue;
    if (!g.has(s.cwd)) g.set(s.cwd, { cwd: s.cwd, name: s.group, sessions: [] });
    g.get(s.cwd).sessions.push(s);
  }
  return [...g.values()];
}
const info = sid => state.sessions.find(s => s.id === sid);
function liveStatus(S) { return S.unseen && S.status === "idle" ? "done" : S.status; }

function sessRow(s, kind) {
  // kind: active | pinned | recent
  const sid = s.id, S = state.open.get(sid);
  const status = S ? liveStatus(S) : "saved";
  const title = (S && !s.renamed && S.title) || s.title || "New session";
  const r = el("div", `sess ${kind}` + (sid === state.active ? " on" : "") + (s.archived ? " archived" : ""));
  r.dataset.sid = sid;
  const where = s.group || basename(s.cwd);
  let meta;
  if (S && S.stale && !["running", "waiting", "starting"].includes(status)) meta = `<span class="st waiting">Updated in ${esc(S.stale)}</span><span>${esc(where)}</span>`;
  else if (S) meta = `<span class="st ${status}">${STATUS_WORDS[status] || ""}</span><span>${esc(where)}</span>`;
  const nj = S ? jobsRunning(S).length : 0;
  if (nj) meta = `<span class="st job"><i class="jring"></i>${nj} ${nj === 1 ? "job" : "jobs"} running</span>` + meta.replace(/<span class="st (idle|done)">[^<]*<\/span>/, "");
  else if (S?.jobFailed) meta = `<span class="st exited">Job failed</span>` + meta.replace(/<span class="st (idle|done)">[^<]*<\/span>/, "");
  else meta = (ui.view === "repo" && kind === "recent" ? "" : `<span>${esc(where)}</span>`) + (s.branch && s.branch !== "HEAD" ? `<span>${esc(s.branch)}</span>` : "") + `<span>${ago(s.mtime)}</span>`;
  const lead = kind === "pinned" ? `<span class="pin-mark ${S ? "live " + status : "closed"}">★</span>` : `<span class="dot ${status}"></span>`;
  r.innerHTML = `${lead}<div class="body"><div class="t"></div><div class="m">${meta}</div></div><div class="acts"></div>`;
  r.querySelector(".t").textContent = title;
  r.title = `${title}\n${tilde(s.cwd)}${s.branch ? " · " + s.branch : ""}`;
  const acts = r.querySelector(".acts");
  const act = (icon, tip, fn, cls = "") => { const b = el("button", "ic " + cls, icon); b.title = tip; b.onclick = e => { e.stopPropagation(); fn(); }; acts.appendChild(b); };
  act(s.pinned ? "★" : "☆", s.pinned ? "Unpin" : "Pin", () => setMeta(sid, "pinned", !s.pinned), s.pinned ? "lit" : "");
  if (S) act("✕", "Close (⌘W)", () => closeSession(sid));
  else act("⌫", s.archived ? "Unarchive" : "Archive", () => setMeta(sid, "archived", !s.archived));
  act("⋯", "More", () => sessionMenu(s, acts.lastChild));
  r.onclick = () => openSession(sid, s.cwd, title);
  r.ondblclick = e => { e.preventDefault(); rename(r, s); };
  r.onauxclick = e => { if (e.button === 1 && S) closeSession(sid); };
  r.oncontextmenu = e => { e.preventDefault(); sessionMenu(s, null, e.clientX, e.clientY); };
  if (state.confirmClose === sid) {
    r.classList.add("confirm");
    r.querySelector(".m").innerHTML = `<span class="st waiting">${S && !["running", "waiting", "starting"].includes(S.status) && jobsRunning(S).length ? "A job is running. Stop it and close?" : "Still working. Stop and close?"}</span>`;
    acts.innerHTML = "";
    act("Stop", "Stop it and close", () => closeSession(sid, true), "danger txt");
    act("Keep", "Keep it running", () => { state.confirmClose = null; renderSidebar(); }, "txt");
  }
  return r;
}

function section(box, label, count, extra) {
  const h = el("div", "side-sec", `<span class="lbl">${esc(label)}</span>${count != null ? `<span class="cnt">${count}</span>` : ""}`);
  if (extra) h.appendChild(extra);
  box.appendChild(h);
  return h;
}
function groupHead(box, key, label, count, sub, onNew) {
  const closed = ui.collapsed[key] !== false;  // Recent groups start collapsed until you open them
  const h = el("div", "side-grp" + (closed ? " closed" : ""), `<span class="chev">›</span><span class="lbl">${esc(label)}</span><span class="cnt">${count}</span>`);
  if (sub) h.title = sub;
  if (onNew) { const p = el("button", "ic grp-new", "+"); p.title = "New session here"; p.onclick = e => { e.stopPropagation(); onNew(); }; h.appendChild(p); }
  h.onclick = () => { ui.collapsed[key] = !closed; saveUi(); renderSidebar(); };
  box.appendChild(h);
  return !closed;
}
function bucketOf(t) {
  const d = new Date(), midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
  if (t >= midnight) return "Today";
  if (t >= midnight - 86400) return "Yesterday";
  if (t >= midnight - 6 * 86400) return "This week";
  return "Older";
}

function renderSidebar() {
  const box = $("#side-list");
  const keep = box.scrollTop;
  box.innerHTML = "";
  const q = state.search.trim().toLowerCase();
  const all = state.sessions || [];
  const byId = new Map(all.map(s => [s.id, s]));
  const live = [...state.open.values()].map(S => byId.get(S.sid) || { id: S.sid, cwd: S.cwd, title: S.title, group: S.cwd.replace(/\/+$/, "") === state.home ? "Home" : basename(S.cwd), mtime: S.lastActive });
  const match = s => !q || `${s.title} ${s.cwd} ${s.group} ${s.branch || ""}`.toLowerCase().includes(q);

  if (q) {  // search: one flat list over everything, archived included
    const hits = all.filter(match);
    for (const S of live) if (!byId.has(S.id) && match(S)) hits.unshift(S);
    section(box, "Results", hits.length);
    hits.slice(0, 80).forEach(s => box.appendChild(sessRow(s, state.open.has(s.id) ? "active" : "recent")));
    if (!hits.length) box.appendChild(el("div", "side-empty", "No sessions match."));
    $("#archived-btn").textContent = `Archived ${all.filter(s => s.archived).length || ""}`.trim();
    return;
  }

  if (state.showArchived) {
    const arch = all.filter(s => s.archived);
    const back = el("button", "btn ghost small", "Done");
    back.onclick = () => { state.showArchived = false; renderSidebar(); };
    section(box, "Archived", arch.length, back);
    arch.forEach(s => box.appendChild(sessRow(s, "recent")));
    if (!arch.length) box.appendChild(el("div", "side-empty", "Nothing archived. Archive sessions from their ⋯ menu or with ⌫ on hover."));
    $("#archived-btn").textContent = "Archived";
    return;
  }

  // Pinned: every pinned session, open or not, in pin order. Open: loaded sessions that aren't pinned.
  live.sort((a, b) => (state.open.get(b.id).lastActive) - (state.open.get(a.id).lastActive));
  const order = state.pinOrder || [];
  const pinnedIds = new Set(all.filter(s => s.pinned && !s.archived).map(s => s.id));
  const pinned = all.filter(s => pinnedIds.has(s.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const openOnly = live.filter(s => !pinnedIds.has(s.id));
  const idle = live.filter(s => !["running", "waiting", "starting"].includes(state.open.get(s.id).status) && !jobsRunning(state.open.get(s.id)).length && s.id !== state.active);

  if (pinned.length) {
    const blk = el("div", "side-block pinned");
    section(blk, "Pinned", pinned.length);
    pinned.forEach(s => blk.appendChild(sessRow(s, "pinned")));
    box.appendChild(blk);
  }
  if (openOnly.length || (idle.length && !pinned.length)) {
    let extra = null;
    if (idle.length) {
      extra = el("button", "btn ghost small", "Close idle");
      extra.title = `Close ${idle.length} idle session${idle.length > 1 ? "s" : ""}, pinned ones included (they stay pinned). Keeps the one you're in.`;
      extra.onclick = () => { idle.forEach(s => closeSession(s.id)); };
    }
    const blk = el("div", "side-block open");
    section(blk, "Open", openOnly.length, extra);
    openOnly.forEach(s => blk.appendChild(sessRow(s, "active")));
    box.appendChild(blk);
  } else if (idle.length) {  // only pinned sessions are open: keep Close idle reachable on the Pinned header
    const head = box.querySelector(".side-block.pinned .side-sec");
    const extra = el("button", "btn ghost small", "Close idle");
    extra.title = "Close the idle pinned sessions (they stay pinned)";
    extra.onclick = () => { idle.forEach(s => closeSession(s.id)); };
    head && head.appendChild(extra);
  }

  // Recent
  const recent = all.filter(s => !s.archived && !pinnedIds.has(s.id) && !state.open.has(s.id));
  const toggle = el("div", "seg", `<button data-v="time" class="${ui.view === "time" ? "on" : ""}">Date</button><button data-v="repo" class="${ui.view === "repo" ? "on" : ""}">Repo</button>`);
  toggle.querySelectorAll("button").forEach(b => b.onclick = () => { ui.view = b.dataset.v; saveUi(); renderSidebar(); });
  const groups = new Map();
  for (const s of recent) {
    const key = s.scratch ? "Scratch" : ui.view === "time" ? bucketOf(s.mtime) : s.cwd;
    if (!groups.has(key)) groups.set(key, { key, label: s.scratch ? "Scratch" : ui.view === "time" ? key : s.group, cwd: s.cwd, scratch: s.scratch, items: [] });
    groups.get(key).items.push(s);
  }
  const list = [...groups.values()].sort((a, b) => (a.scratch - b.scratch));
  const keys = list.map(g => (ui.view === "repo" ? "r:" : "t:") + g.key);
  const anyOpen = keys.some(k => ui.collapsed[k] === false);
  const fold = el("button", "btn ghost small", anyOpen ? "Collapse all" : "Expand all");
  fold.onclick = () => { keys.forEach(k => { ui.collapsed[k] = anyOpen; }); saveUi(); renderSidebar(); };
  const tools = el("div", "sec-tools");
  if (keys.length) tools.appendChild(fold);
  tools.appendChild(toggle);
  section(box, "Recent", null, tools);
  for (const g of list) {
    const k = (ui.view === "repo" ? "r:" : "t:") + g.key;
    const open = groupHead(box, k, g.label, g.items.length, g.scratch ? "tmp and agent scratch folders" : ui.view === "repo" ? tilde(g.cwd) : "",
      ui.view === "repo" && !g.scratch ? () => newSession(g.cwd) : null);
    if (!open) continue;
    const max = state.expanded.has(k) ? 500 : 6;
    g.items.slice(0, max).forEach(s => box.appendChild(sessRow(s, "recent")));
    if (g.items.length > max) {
      const m = el("div", "more", `Show ${g.items.length - max} more`);
      m.onclick = () => { state.expanded.add(k); renderSidebar(); };
      box.appendChild(m);
    }
  }
  if (!all.length && !live.length) box.appendChild(el("div", "side-empty", "No sessions yet. Start one with New session."));
  const nArch = all.filter(s => s.archived).length;
  $("#archived-btn").textContent = nArch ? `Archived ${nArch}` : "Archived";
  box.scrollTop = keep;
  slideHighlight(box);
}
let hlWas = null;
function slideHighlight(box) {
  const on = box.querySelector(".sess.on"), hl = el("div", "sel-hl");
  if (!on) { hlWas = null; return; }
  box.prepend(hl);
  const to = { top: on.offsetTop, height: on.offsetHeight }, from = hlWas && hlWas.sid !== state.active ? hlWas : to;
  hl.style.top = from.top + "px"; hl.style.height = from.height + "px";
  if (from !== to) requestAnimationFrame(() => requestAnimationFrame(() => { hl.style.top = to.top + "px"; hl.style.height = to.height + "px"; }));
  hlWas = { ...to, sid: state.active };
}

async function setMeta(sid, key, value) {
  await api().set_meta(sid, key, value);
  if (key === "archived" && value && state.open.has(sid) && !["running", "waiting"].includes(state.open.get(sid).status)) closeSession(sid);
  if (key === "title") { const S = state.open.get(sid); if (S && value) S.title = value; }
  await loadHistory();
  if (key === "archived") toast(value ? "Archived. Find it under Archived at the bottom." : "Unarchived");
}

function rename(row, s) {
  const t = row.querySelector(".t");
  const input = el("input", "rename");
  input.value = t.textContent;
  t.replaceWith(input);
  input.focus(); input.select();
  input.onclick = e => e.stopPropagation();
  let done = false;
  const finish = save => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save && v !== s.title) setMeta(s.id, "title", v); else renderSidebar();
  };
  input.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
}

function sessionMenu(s, anchor, x, y) {
  const m = $("#ctx-menu");
  m.style.width = "";
  const S = state.open.get(s.id);
  const items = [
    ["Open", () => openSession(s.id, s.cwd, s.title)],
    ["Rename…", () => { const row = document.querySelector(`#side-list .sess[data-sid="${s.id}"]`); if (row) rename(row, s); }],
    s.renamed ? ["Use Claude's title", () => setMeta(s.id, "title", "")] : null,
    [s.pinned ? "Unpin" : "Pin to top", () => setMeta(s.id, "pinned", !s.pinned)],
    "-",
    S ? ["Reload from disk", () => reloadSession(s.id)] : null,
    S ? ["Close", () => closeSession(s.id)] : null,
    [s.archived ? "Unarchive" : "Archive", () => setMeta(s.id, "archived", !s.archived)],
    "-",
    ["New session in this folder", () => newSession(s.cwd)],
    ["Start fresh (carry over notes)", () => handoff(s.id)],
    ["Open folder in VS Code", () => api().open_in_editor(s.cwd)],
    ["Copy resume command", async () => toast("Copied: " + await api().resume_command(s.id))],
  ].filter(Boolean);
  m.innerHTML = "";
  items.forEach(it => {
    if (it === "-") { m.appendChild(el("div", "sep")); return; }
    const row = el("div", "it", `<span class="a">${esc(it[0])}</span>`);
    row.onclick = e => { e.stopPropagation(); m.hidden = true; it[1](); };
    m.appendChild(row);
  });
  m.hidden = false;
  const side = $("#side").getBoundingClientRect();
  if (anchor) { const r = anchor.getBoundingClientRect(); x = r.right - 4; y = r.bottom + 4; }
  const w = 230, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(anchor ? x - w + 20 : x, window.innerWidth - w - 8)) + "px";
  m.style.top = Math.min(y, window.innerHeight - h - 8) + "px";
}

// A chat that worked in more than one repo: pick which one the tabs and top bar show. Saved per chat.
function repoMenu(S, anchor) {
  const m = $("#ctx-menu");
  m.innerHTML = "";
  m.style.width = "380px";
  for (const r of S.repos) {
    const what = r.started ? "Started here" : [r.edits ? `${r.edits} edit${r.edits > 1 ? "s" : ""}` : "", r.commits ? `${r.commits} commit${r.commits > 1 ? "s" : ""} or push${r.commits > 1 ? "es" : ""}` : ""].filter(Boolean).join(" · ");
    const row = el("div", "it" + (r.top === S.repo ? " sel" : ""), `<span class="a">${esc(r.name)}</span><span class="b">${esc(what)}</span>`);
    row.title = tilde(r.top);
    row.onclick = async e => { e.stopPropagation(); m.hidden = true; await setMeta(S.sid, "repo", r.top); refreshRepo(true); };
    m.appendChild(row);
  }
  m.hidden = false;
  const a = anchor.getBoundingClientRect(), w = m.offsetWidth;
  m.style.left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8)) + "px";
  m.style.top = a.bottom + 6 + "px";
}

function recentRepos() {
  // Pinned first, then repos with recent sessions, then other git repos found on disk.
  const seen = new Set(), out = [];
  const push = r => { if (!seen.has(r.cwd)) { seen.add(r.cwd); out.push(r); } };
  for (const p of state.settings.pinned || []) push({ cwd: p, name: basename(p), pinned: true });
  const repoSet = new Set(state.repos.map(r => r.cwd));
  for (const g of state.groups) if (repoSet.has(g.cwd)) push({ cwd: g.cwd, name: g.name });
  for (const r of state.repos) push(r);
  for (const g of state.groups) if (!g.scratch) push({ cwd: g.cwd, name: g.name });
  return out;
}
function renderRecentRepos() {
  const box = $("#recent-repos");
  box.innerHTML = "";
  const quick = el("button", "btn primary small", "Home");
  quick.title = "Just chat, no repo (runs from your home folder)";
  quick.onclick = () => newSession(state.home);
  box.appendChild(quick);
  recentRepos().filter(r => r.cwd !== state.home).slice(0, 11).forEach(r => {
    const c = el("button", "btn small", esc(r.name));
    c.title = tilde(r.cwd);
    c.onclick = () => newSession(r.cwd);
    box.appendChild(c);
  });
}

async function openSession(sid, cwd, title) {
  if (!state.open.has(sid)) {
    const r = await api().open_session(sid, cwd, title || "");
    const S = makeSession({ ...r, title });
    renderItems(S, r.items || []);
    for (const j of r.jobs || []) if (j.status === "running") jobEvent(S, j);  // ended ones are in the saved chat
    if (r.parts?.length) olderPartButton(S, r.parts);
    if (r.pending_fresh) add(S, freshCard(S, { from: r.parts?.[0]?.slice(0, 8) }));  // started fresh, first message not sent yet
  }
  activate(sid);
}
// A long conversation is several sessions joined by fresh starts. Scrolling back: the earlier parts load above.
function olderPartButton(S, parts) {
  const b = el("div", "note older-part", `<a class="lnk">Show earlier messages</a>`);
  S.inner.prepend(b);
  b.querySelector("a").onclick = async () => {
    b.querySelector("a").textContent = "Loading…";
    const r = await api().part_items(parts[0]);
    const box = el("div", "part");
    const T = { ...S, inner: box, el: el("div"), tools: new Map(), perms: new Map(), cur: null, think: null, stick: false };
    renderItems(T, r.items || []);
    box.querySelectorAll(":scope > .note").forEach(n => { if (/earlier messages from the saved session/.test(n.textContent)) n.remove(); });
    const before = S.el.scrollHeight;
    b.replaceWith(box);
    S.el.scrollTop += S.el.scrollHeight - before;  // stay where you were
    hydrate(S, box);
    if (parts.length > 1) olderPartButton(S, parts.slice(1));
  };
}
async function newSession(cwd) {
  closeModal();
  const r = await api().new_session(cwd);
  if (r.error) return toast(r.error, "error");
  makeSession(r);
  activate(r.sid);
  renderSidebar();
}
function newSessionDialog() {
  const box = openModal(`<h2>New session</h2><input class="pick-filter" placeholder="Filter folders" spellcheck="false"><div class="repo-pick"></div><div class="modal-acts"><button class="btn" data-new>New folder…</button><button class="btn" data-pick>Choose folder…</button><button class="btn ghost" data-close>Cancel</button></div>`);
  const list = box.querySelector(".repo-pick"), filter = box.querySelector(".pick-filter");
  const used = {};  // folder → when a session last ran there
  for (const x of state.sessions || []) if ((x.mtime || 0) > (used[x.cwd] || 0)) used[x.cwd] = x.mtime;
  const all = [{ cwd: state.home, name: "Home" }, ...recentRepos().filter(r => r.cwd !== state.home)]
    .map((r, i) => ({ ...r, t: used[r.cwd] || 0, i }))
    .sort((a, b) => (b.cwd === state.home) - (a.cwd === state.home) || (b.pinned || 0) - (a.pinned || 0) || b.t - a.t || a.i - b.i);
  let sel = 0, shown = [];
  const draw = () => {
    const q = filter.value.toLowerCase();
    shown = all.filter(r => !q || ((r.name || "") + " " + tilde(r.cwd)).toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = "";
    shown.forEach((r, i) => {
      const it = el("div", "it" + (i === sel ? " sel" : ""), `<b></b><span class="p"></span><span class="w"></span>`);
      it.querySelector("b").textContent = r.name || basename(r.cwd);
      it.querySelector(".p").textContent = "\u200e" + tilde(r.cwd) + "\u200e";  // keeps ~/ in front while the start is cut
      it.querySelector(".w").textContent = r.pinned ? "pinned" : r.t ? ago(r.t) : "";
      it.title = r.cwd;
      it.onclick = () => newSession(r.cwd);
      list.appendChild(it);
    });
  };
  filter.oninput = () => { sel = 0; draw(); };
  filter.onkeydown = e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = (sel + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % Math.max(1, shown.length); draw(); list.children[sel]?.scrollIntoView({ block: "nearest" }); }
    if (e.key === "Enter" && shown[sel]) newSession(shown[sel].cwd);
  };
  draw();
  setTimeout(() => filter.focus(), 30);
  box.querySelector("[data-pick]").onclick = async () => { const p = await api().pick_folder(); if (p) newSession(p); };
  box.querySelector("[data-new]").onclick = newFolderDialog;
}
async function newFolderDialog() {
  let parent = await api().default_new_folder_parent();
  const box = openModal(`<h2>New folder</h2><input type="text" class="pick-filter" placeholder="Folder name" spellcheck="false"><div class="nf-in">In <span class="nf-p"></span> <a href="#" data-where>Change…</a></div><div class="nf-err"></div><div class="modal-acts"><button class="btn ghost" data-back>Back</button><button class="btn primary" data-make>Create and start</button></div>`);
  const name = box.querySelector("input"), where = box.querySelector(".nf-p"), err = box.querySelector(".nf-err");
  const show = () => { where.textContent = "\u200e" + tilde(parent) + "\u200e"; where.title = parent; };
  show();
  box.querySelector("[data-where]").onclick = async e => { e.preventDefault(); const p = await api().pick_folder(parent); if (p) { parent = p; show(); } name.focus(); };
  box.querySelector("[data-back]").onclick = newSessionDialog;
  const make = async () => {
    const r = await api().create_folder(parent, name.value);
    if (r.error) { err.textContent = r.error; name.focus(); return; }
    newSession(r.path);
  };
  box.querySelector("[data-make]").onclick = make;
  name.oninput = () => { err.textContent = ""; };
  name.onkeydown = e => { if (e.key === "Enter") make(); };
  setTimeout(() => name.focus(), 30);
}

function activate(sid) {
  const prev = state.open.get(state.active);
  if (prev) { prev.draft = $("#input").value; }
  state.active = sid;
  const S = state.open.get(sid);
  for (const x of state.open.values()) x.el.hidden = x !== S;
  $("#empty").hidden = !!S;
  $("#composer").hidden = !S;
  syncDock();
  syncJobsNote();
  if (!S) return;
  S.unseen = false;
  S.jobFailed = false;
  $("#input").value = S.draft || "";
  autogrow();
  renderAttachments();
  syncComposer(S);
  renderSidebar();
  state.repo = {};
  renderBar();
  refreshRepo();
  document.body.classList.remove("view-full");
  syncViewTab(); loadView(S).then(() => { if (state.panel && state.tab === "view" && state.active === S.sid) renderPanel(); });
  scrollDown(S, true); S.stick = true; syncJump();
  $("#input").focus();
}

// The session moved on elsewhere (VS Code, the terminal): offer to bring those messages in.
function markStale(S, where) {
  S.stale = where || "elsewhere";
  let bar = S.el.querySelector(".stale-bar");
  if (!bar) {
    bar = el("div", "stale-bar");
    S.el.prepend(bar);
  }
  bar.innerHTML = `<span>New messages in this session from <b>${esc(S.stale)}</b>.</span>`;
  const b = btn("Reload  ⌘R", "primary", () => reloadSession(S.sid));
  bar.appendChild(b);
  renderSidebar();
}
async function reloadSession(sid) {
  const S = state.open.get(sid);
  if (!S) return;
  const r = await api().reload_session(sid);
  if (r.error) return toast(r.error, "error");
  S.inner.innerHTML = "";
  S.el.querySelector(".stale-bar")?.remove();
  S.tools.clear(); S.perms.clear(); S.cur = null; S.think = null; S.playing = new Set(); S.held = [];
  dropDocked(sid);
  S.stale = false;
  if (r.title) S.title = r.title;
  renderItems(S, r.items || []);
  if (r.parts?.length) olderPartButton(S, r.parts);  // reloading keeps the way back to earlier parts
  add(S, el("div", "note", "Reloaded. Your next message continues from here."));
  scrollDown(S, true);
  loadHistory();
}

function closeSession(sid, force) {
  const S = state.open.get(sid);
  if (!S) return;
  if (!force && (["running", "waiting", "starting"].includes(S.status) || jobsRunning(S).length)) { state.confirmClose = sid; renderSidebar(); return; }
  state.confirmClose = null;
  api().close_session(S.sid);
  S.el.remove();
  dropDocked(sid);
  clearInterval(S.timer);
  state.open.delete(S.sid);
  if (state.active === sid) {
    const next = [...state.open.values()].sort((a, b) => b.lastActive - a.lastActive)[0];
    state.active = null;
    if (next) activate(next.sid); else { activate(null); renderBar(); }
  }
  loadHistory();
}
function closeActive() { if (state.active) closeSession(state.active); }

// ---------- composer ----------
function syncComposer(S) {
  const busy = S.status === "running" || S.status === "waiting" || S.status === "starting";
  $("#send-btn").hidden = busy && !$("#input").value.trim();
  $("#stop-btn").hidden = !busy;
  $("#model-sel").value = S.model || "";
  $("#effort-sel").value = S.effort || "";
  syncModes(S);
  showCtx(S);
}
// One menu next to Send for model, effort and permission mode. It drives the three hidden selects, so their
// change handlers (saving per chat, the "Now using" line, the Bypass confirm) stay the only path.
const EFFORT_SHORT = { "": "Default", low: "Low", medium: "Med", high: "High", xhigh: "X-High", max: "Max" };
const MODE_SHORT = { auto: "Auto", manual: "Ask first", acceptEdits: "Accept edits", plan: "Plan", dontAsk: "Don't ask", bypassPermissions: "Bypass" };
// "Opus" with the description "Opus 5.5 · Best for everyday work" reads as "Opus 5.5"
const modelFull = o => { const head = (o?.title || "").split(" · ")[0]; return head && head.startsWith(o.textContent) ? head : o?.textContent || ""; };
const EFFORT_FULL = { "": "Default", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
// "Opus 5.5 · High effort": the model and effort as the menu names them, for the line a switch leaves in the chat
function runLabel(model, effort) {
  const o = [...$("#model-sel").options].find(x => x.value === model);
  return `${(o ? modelFull(o) : model) || "Default model"} · ${EFFORT_FULL[effort || ""] || effort} effort`;
}
const switchLine = text => el("div", "note switch", esc(text));
function syncRun() {
  const model = modelFull($("#model-sel").selectedOptions[0]) || "Default model";
  const eff = $("#effort-sel").value, mode = $("#mode-sel").value;
  const risky = mode === "bypassPermissions";
  $("#run-btn .lbl").innerHTML = [esc(model.replace(/^Default model$/, "Default")), eff ? esc(EFFORT_SHORT[eff]) : "", `<span class="${risky ? "risky" : ""}">${esc(MODE_SHORT[mode] || mode)}</span>`].filter(Boolean).join(" · ");
  if (!$("#run-menu").hidden) renderRunMenu();
}
function renderRunMenu() {
  const typed = $("#ctx-focus")?.value || "";  // keep a half-typed "what to keep" across redraws
  const m = $("#run-menu"), pick = (sel, v) => { const x = $(sel); if (x.value === v) return; x.value = v; x.dispatchEvent(new Event("change")); };
  const sub = t => (t || "").replace(/^[^·]*·\s*/, "");  // "Opus 5.5 · Best for everyday work" → "Best for everyday work"
  const opt = (sel, o, extra = "") => `<div class="it${o.value === $(sel).value ? " on" : ""}${extra}" data-sel="${sel}" data-v="${esc(o.value)}" title="${esc(o.title || "")}"><span class="ck">✓</span><span class="txt"><span class="a">${esc(sel === "#model-sel" ? modelFull(o) : o.textContent)}</span>${o.title ? `<span class="b">${esc(sub(o.title))}</span>` : ""}</span></div>`;
  m.innerHTML = `<div class="run-cols"><div class="run-col"><div class="hd">Model</div>${[...$("#model-sel").options].map(o => opt("#model-sel", o)).join("")}</div>
    <div class="run-col"><div class="hd">Permissions<span class="kbd">⇧Tab</span></div>
    ${[...$("#mode-sel").options].map(o => opt("#mode-sel", o, o.value === "bypassPermissions" ? " risky" : "")).join("")}</div></div>
    <div class="sep"></div><div class="hd">Effort</div>
    <div class="seg run-eff">${[...$("#effort-sel").options].map(o => `<button data-sel="#effort-sel" data-v="${o.value}" class="${o.value === $("#effort-sel").value ? "on" : ""}">${EFFORT_SHORT[o.value]}</button>`).join("")}</div>
    ${state.open.get(state.active) ? `<div class="sep"></div><div class="hd">Context</div><div id="run-ctx" class="run-ctx"></div>` : ""}`;
  m.querySelectorAll("[data-sel]").forEach(n => n.onclick = e => {
    e.stopPropagation();
    if (n.dataset.sel !== "#effort-sel") m.hidden = true;
    pick(n.dataset.sel, n.dataset.v);
    syncRun();
  });
  const S = state.open.get(state.active);
  if (S && $("#run-ctx")) { renderCtx(S); if (typed) $("#ctx-focus").value = typed; }
  fitRunMenu();
}
// The menu floats above the whole window, anchored to the chip, so a narrow chat column (side panel open, small
// window) never squeezes it or tucks it under the sidebar. Only a window too small for two columns stacks them.
function fitRunMenu() {
  const m = $("#run-menu");
  if (m.hidden) return;
  if (m.parentElement !== document.body) document.body.appendChild(m);
  const chip = $("#run-btn").getBoundingClientRect(), W = window.innerWidth, w = Math.min(660, W - 16);
  const left = Math.max(8, Math.min(chip.right - w, W - w - 8));
  m.classList.toggle("stack", w < 556);
  Object.assign(m.style, { width: w + "px", left: left + "px", bottom: window.innerHeight - chip.top + 8 + "px",
    maxHeight: Math.max(200, Math.min(760, chip.top - 16)) + "px" });
  m.style.setProperty("--ox", `${chip.left + chip.width / 2 - left}px`);
}
// A compaction in the chat: one quiet line; click to read the summary Claude carried forward.
function compactionRow(S, ev) {
  const how = ev.trigger === "manual" ? "Compacted" : "Compacted automatically";
  const freed = ev.pre && ev.post ? `, freed ${kfmt(Math.max(0, ev.pre - ev.post))} tokens` : "";
  const d = el("details", "note compaction", `<summary>${how}${freed} · <span class="lnk">Summary</span></summary><div class="msg-text compaction-body"></div>`);
  d.ontoggle = async () => {
    if (!d.open || d.dataset.loaded) return;
    let text = ev.summary;
    if (text == null) text = (await api().compaction_summary(S.sid)).summary;  // live: read it from the saved session
    d.dataset.loaded = "1";
    renderMarkdown(d.querySelector(".compaction-body"), text || "No summary saved.");
    hydrate(S, d.querySelector(".compaction-body"));
  };
  return d;
}
function showCompactionSummary(S) {
  api().compaction_summary(S.sid).then(c => {
    if (!c?.summary) return toast("This session hasn't been compacted yet.");
    const when = c.timestamp ? new Date(c.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
    const box = openModal(`<h2>Last compaction</h2><p class="modal-p">${esc([when, c.pre && c.post ? `${kfmt(c.pre)} → ${kfmt(c.post)} tokens` : ""].filter(Boolean).join(" · "))}</p>
      <div class="msg-text compaction-modal"></div><div class="modal-acts"><button class="btn ghost" data-close>Close</button></div>`);
    renderMarkdown(box.querySelector(".compaction-modal"), c.summary);
    hydrate(S, box.querySelector(".compaction-modal"));
  });
}

// ---------- context meter: how full the session is, and Compact now ----------
const CTX_WARN = 60, CTX_HIGH = 80;  // percent of the usable window (Claude Code compacts on its own near 100)
function ctxNumbers(S) {
  const u = S.ctxUsage || {};
  const max = u.maxTokens || 0, used = u.totalTokens || S.context || 0;
  const buffer = ((u.categories || []).find(c => c.kind === "buffer") || {}).tokens || 0;
  const compactAt = max ? max - buffer : 0;  // where Claude Code would compact on its own
  const fresh = +state.settings.auto_fresh || 0;  // Tether starts fresh before that, when it's on
  const usable = fresh && compactAt ? Math.min(fresh, compactAt) : compactAt;
  const pct = usable ? Math.min(100, Math.round(used / usable * 100)) : null;
  return { max, used, buffer, usable, pct, fresh: fresh && fresh < compactAt, level: pct == null ? "" : pct >= CTX_HIGH ? "high" : pct >= CTX_WARN ? "warn" : "ok" };
}
function showCtx(S) {  // context lives in the run menu; only redraw it while that menu is open
  if (!$("#run-menu").hidden && $("#run-ctx") && S.sid === state.active) renderCtx(S);
}
function renderCtx(S) {
  const box = $("#run-ctx"), n = ctxNumbers(S), u = S.ctxUsage || {};
  if (!box) return;
  const busy = ["running", "waiting", "starting"].includes(S.status);
  const used = (u.categories || []).filter(c => c.kind === "used" && c.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const word = { ok: "Plenty of room", warn: "Getting full", high: "Nearly full" }[n.level] || "";
  const old = box.querySelector("#ctx-focus"), typed = old?.value || "", hadFocus = old && document.activeElement === old;
  if (!n.used) { box.innerHTML = `<div class="ctx-sub">Nothing in context yet.</div>`; return; }
  box.innerHTML = `<div class="ctx-main">
      <div class="ctx-h"><b>${n.pct == null ? kfmt(n.used) + " tokens" : n.pct + "% full"}</b>${word ? `<span class="lvl ${n.level}">${word}</span>` : ""}</div>
      ${u.estimated ? `<div class="ctx-sub">As of the last reply${u.maxTokens ? "" : " · limit not known yet for this model"}. Getting the exact breakdown…</div>` : ""}
      ${n.usable && !u.estimated ? `<div class="ctx-stack">${used.map(c => `<span style="width:${c.tokens / n.usable * 100}%" title="${esc(c.name)} · ${kfmt(c.tokens)}"></span>`).join("")}</div>
      <div class="ctx-sub">${kfmt(n.used)} of ${kfmt(n.usable)} · ${n.fresh ? "then Tether starts fresh, carrying over notes and recall (Settings › Sessions)" : `auto-compacts after that${u.autocompactSource === "settings" ? ` (your ${kfmt(n.max)} limit in Claude settings)` : ""}`}</div>` : u.estimated ? "" : `<div class="ctx-sub">Getting the numbers…</div>`}
      <div class="ctx-last"><a class="lnk" id="ctx-summary">Last compaction summary</a> · <a class="lnk" id="ctx-handoff">Start fresh now</a></div>
      <div class="ctx-act">
        <input id="ctx-focus" type="text" placeholder="What to keep (optional)">
        <button class="btn primary small" id="ctx-compact" ${busy ? "disabled title='Wait for Claude to finish'" : ""}>Compact now</button>
      </div>
    </div>
    ${used.length ? `<div class="ctx-rows">${used.map(c => `<div><span>${esc(c.name)}</span><b>${kfmt(c.tokens)}</b></div>`).join("")}</div>` : ""}`;
  const input = box.querySelector("#ctx-focus"), close = () => { $("#run-menu").hidden = true; };
  input.value = typed; if (hadFocus) input.focus();
  box.querySelector("#ctx-compact").onclick = async e => {
    e.stopPropagation();
    const focus = input.value, r = await api().compact(S.sid, focus);
    if (r.error) return toast(r.error, "error");
    close();
    addUser(S, "/compact" + (focus ? " " + focus : ""));
  };
  box.querySelector("#ctx-summary").onclick = e => { e.stopPropagation(); close(); showCompactionSummary(S); };
  box.querySelector("#ctx-handoff").onclick = e => { e.stopPropagation(); close(); handoff(S.sid); };
  input.onclick = e => e.stopPropagation();
  input.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") box.querySelector("#ctx-compact").click(); if (e.key === "Escape") close(); };
}
async function loadCtx() {  // the exact breakdown, fetched when the run menu opens
  const S = state.open.get(state.active);
  if (!S) return;
  const u = await api().context_usage(S.sid);
  if (u?.error) toast(u.error, "error");
  else if (u?.totalTokens && (!S.ctxUsage || S.ctxUsage.estimated)) { S.ctxUsage = u; showCtx(S); }
}
// ---------- toolbox: screen tools behind one button, so the composer stays uncluttered ----------
function renderToolsMenu() {
  const m = $("#tools-menu"), key = state.hotkeys?.[state.settings?.circle_key];
  const items = [["circle", "Circle something on screen", key || ""]];
  if (state.marksUp) items.push(["clear", "Clear Claude's marks from the screen", ""]);
  m.innerHTML = items.map(([k, a, kbd]) => `<div class="it" data-t="${k}"><span class="a">${esc(a)}</span>${kbd ? `<span class="kbd">${esc(kbd)}</span>` : ""}</div>`).join("");
  m.querySelectorAll("[data-t]").forEach(n => n.onclick = e => {
    e.stopPropagation();
    m.hidden = true;
    if (n.dataset.t === "circle") api().start_circle();
    else { api().clear_marks(); state.marksUp = false; }
  });
}
function autogrow() { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(260, t.scrollHeight) + "px"; }
function insertText(text) {
  const t = $("#input");
  const s = t.selectionStart ?? t.value.length, e = t.selectionEnd ?? t.value.length;
  const pre = t.value.slice(0, s), sep = pre && !/\s$/.test(pre) ? " " : "";
  t.value = pre + sep + text + t.value.slice(e);
  t.selectionStart = t.selectionEnd = s + sep.length + text.length;
  autogrow();
  t.focus();
}
function renderAttachments() {
  const S = state.open.get(state.active);
  const box = $("#attachments");
  box.innerHTML = "";
  (S ? S.attachments : []).forEach((a, i) => {
    const c = el("div", "att rise" + (a.path ? " doc" : ""), `${a.path ? `<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>` : `<img src="data:${a.media_type};base64,${a.data}">`}<span>${esc(a.label || "image")}</span><button title="Remove">✕</button>`);
    if (a.path) c.title = tilde(a.path);
    c.querySelector("button").onclick = e => { e.stopPropagation(); S.attachments.splice(i, 1); renderAttachments(); };
    c.onclick = () => a.path ? showPeek(c, { ref: a.path, label: a.label }) : showPeek(c, { src: `data:${a.media_type};base64,${a.data}`, label: a.label });
    box.appendChild(c);
  });
  const groups = new Map();
  (S?.notes || []).forEach(x => groups.set(x.path, [...(groups.get(x.path) || []), x]));
  groups.forEach((list, path) => {  // notes left on the Shelf: one chip per file; click shows it, ✕ drops its notes
    const c = el("div", "att rise notes", `${NOTE_ICON}<span></span><button title="Remove these notes">✕</button>`);
    c.querySelector("span").textContent = `${list.length} note${list.length > 1 ? "s" : ""} · ${list[0].title}`;
    c.title = list.map(x => `${x.n}. ${x.text}`).join("\n");
    c.querySelector("button").onclick = e => { e.stopPropagation(); S.notes = S.notes.filter(x => x.path !== path); renderAttachments(); refreshNotePins(S); };
    c.onclick = () => openInView(S, path);
    box.appendChild(c);
  });
}
// Sending here while the same session is in use in VS Code (or the terminal) forks it: each side keeps
// its own copy and the file ends up interleaved. Ask first.
const BUSY_ELSEWHERE_SECONDS = 120;
async function checkElsewhere(S) {
  if (S.status === "new") return "send";
  const a = await api().session_activity(S.sid);
  const elsewhere = a.where && !["Tether", "Tether", "JordCode", "Claude Workbench"].includes(a.where);
  const recent = elsewhere && a.ago != null && a.ago < BUSY_ELSEWHERE_SECONDS;
  if (!recent && !a.stale) return "send";
  const when = a.ago == null ? "" : a.ago < 60 ? `${a.ago}s ago` : `${Math.round(a.ago / 60)} min ago`;
  return new Promise(resolve => {
    const box = openModal(`<h2>This session is in use in ${esc(a.where || "another app")}</h2>
      <p class="modal-p">${recent ? `It was last written from ${esc(a.where)} ${when}.` : `It has new messages from ${esc(a.where || "elsewhere")} that this window hasn't loaded.`}
      If you send from here while it's open there, each side carries on with its own copy and the conversation splits.</p>
      <p class="modal-p dim">Best: stop or finish it in ${esc(a.where || "the other app")} first, then reload here.</p>
      <div class="modal-acts"><button class="btn ghost" data-k="cancel">Cancel</button><button class="btn" data-k="reload">Reload, then send</button><button class="btn danger" data-k="send">Send anyway</button></div>`);
    let done = false;
    const finish = k => { if (done) return; done = true; closeModal(); resolve(k); };
    box.querySelectorAll("[data-k]").forEach(b => b.onclick = () => finish(b.dataset.k));
    const obs = new MutationObserver(() => { if ($("#modal").hidden) { obs.disconnect(); finish("cancel"); } });
    obs.observe($("#modal"), { attributes: true, attributeFilter: ["hidden"] });
  });
}

async function send() {
  const S = state.open.get(state.active);
  if (!S) return;
  const typed = $("#input").value.trim();
  if ((!typed && !S.attachments.length && !S.notes?.length) || S.sendingNotes) return;
  const files = S.attachments.filter(a => a.path).map(a => a.path);
  if (!["running", "waiting", "starting"].includes(S.status)) {
    const choice = await checkElsewhere(S);
    if (choice === "cancel") return;
    if (choice === "reload") { await reloadSession(S.sid); if (state.active !== S.sid) return; }
  }
  const sent = S.notes || [];
  let noted = { text: "", images: [] };
  if (sent.length) {  // drawing a page with its pins takes a second or two
    S.sendingNotes = true; $("#attachments").classList.add("wait");
    try { noted = await notesMessage(S); } finally { S.sendingNotes = false; $("#attachments").classList.remove("wait"); }
    S.notes = (S.notes || []).filter(x => !sent.includes(x));
    S.commenting = false; refreshNotePins(S);
    if (state.tab === "view" && state.panel && state.active === S.sid) renderView(S, $("#panel-body"), true);
  }
  const text = [typed, noted.text, files.length ? "Attached files:\n" + files.map(f => `- ${f}`).join("\n") : ""].filter(Boolean).join("\n\n");
  const images = [...S.attachments.splice(0).filter(a => !a.path), ...noted.images];
  $("#input").value = "";
  S.draft = "";
  autogrow();
  renderAttachments();
  hideSlash();
  const busy = ["running", "waiting", "starting"].includes(S.status);
  const m = addUser(S, text, images, busy);
  (S.pending ||= []).push({ text: text || (images.length ? "(see the attached image)" : ""), el: m });
  const r = await api().send(S.sid, text, images.map(({ data, media_type }) => ({ data, media_type })));
  if (r && r.error) add(S, el("div", "err", esc(r.error)));
  S.lastActive = Date.now() / 1000;
  renderSidebar();
}

// slash commands
let slashSel = 0;
function updateSlash() {
  const S = state.open.get(state.active);
  const v = $("#input").value;
  const m = v.match(/^\/([\w:-]*)$/);
  if (!S || !m || !S.commands.length) return hideSlash();
  const hits = S.commands.filter(c => c.toLowerCase().includes(m[1].toLowerCase())).slice(0, 12);
  if (!hits.length) return hideSlash();
  slashSel = Math.min(slashSel, hits.length - 1);
  const box = $("#slash");
  box.innerHTML = "";
  hits.forEach((c, i) => {
    const it = el("div", "it" + (i === slashSel ? " sel" : ""), `<span class="a">/${esc(c)}</span>`);
    it.onmousedown = e => { e.preventDefault(); pickSlash(c); };
    box.appendChild(it);
  });
  box.hidden = false;
  box.dataset.hits = JSON.stringify(hits);
}
function hideSlash() { $("#slash").hidden = true; slashSel = 0; }
function pickSlash(c) { $("#input").value = `/${c} `; hideSlash(); $("#input").focus(); }

// models
async function fillModels() {
  if (!state.models.length) state.models = await api().models();
  const sel = $("#model-sel");
  sel.innerHTML = `<option value="">Default model</option>` + state.models.filter(m => m.value !== "default").map(m =>
    `<option value="${esc(m.value)}" title="${esc(m.description || "")}">${esc(m.displayName || m.value)}</option>`).join("");
  const S = state.open.get(state.active);
  if (S) sel.value = S.model || "";
  syncRun();
}

// ---------- repo bar + panel ----------
// The repo a chat's tabs follow: the one it started in, or else the one Claude edited and committed in from it.
const repoDir = S => S.repo || S.cwd;
async function refreshRepo(fresh) {
  const S = state.open.get(state.active);
  if (!S) return;
  const sid = S.sid;
  const found = await api().chat_repos(sid, S.cwd);
  S.repos = found.repos;
  S.repo = found.picked || found.repos[0]?.top || "";
  const st = await api().repo_status(repoDir(S));
  if (state.active !== sid) return;
  state.repo = { ...state.repo, status: st };
  syncPanelTabs();
  renderBar();
  if (state.panel) renderPanel(fresh);
  if (st.git) {
    const pr = await api().repo_pr(repoDir(S), !!fresh);
    if (state.active !== sid) return;
    state.repo.pr = pr;
    renderBar();
    if (state.panel) renderPR();
  }
}
function renderBar() {
  const S = state.open.get(state.active);
  const left = $("#bar-repo"), right = $("#bar-right");
  left.innerHTML = right.innerHTML = "";
  if (!S) return;
  const st = state.repo.status;
  const home = S.cwd.replace(/\/+$/, "") === state.home;
  // The thread's title, then one quiet line about where it runs. Click the title to rename it.
  const title = el("div", "thread-title");
  title.textContent = S.title || "New session";
  title.title = "Rename";
  title.onclick = () => renameThread(S, title);
  left.appendChild(title);
  const crumbs = el("div", "crumbs");
  const add = (text, cls, tip, onclick) => {
    const c = el("span", cls || "", esc(text));
    if (tip) c.title = tip;
    if (onclick) { c.classList.add("click"); c.onclick = onclick; }
    crumbs.appendChild(c);
    return c;
  };
  const many = (S.repos || []).length > 1;
  const where = add(st && st.git ? st.name + (many ? " ▾" : "") : home ? "Home" : basename(S.cwd), "",
    st && st.git ? tilde(st.root) + (many ? " · Switch repo" : "") : tilde(S.cwd), many ? e => { e.stopPropagation(); repoMenu(S, where); } : null);
  if (st && st.git) {
    add(st.branch, "mono", st.upstream ? `Tracking ${st.upstream}` : "No upstream");
    if (st.ahead || st.behind) add(`${st.ahead ? "↑" + st.ahead : ""}${st.ahead && st.behind ? " " : ""}${st.behind ? "↓" + st.behind : ""}`, "mono " + (st.behind ? "warn" : ""), st.behind ? "Behind its upstream" : "Ahead of its upstream");
    const n = st.files.length;
    add(n ? `${n} changed` : "Clean", n ? "warn" : "", n ? "Show changes" : "", () => togglePanel(true, "changes"));
    const pr = state.repo.pr;
    if (pr) {
      const c = pr.checks;
      const done = pr.state === "MERGED" || pr.state === "CLOSED";
      const cls = done ? "" : c.failed ? "bad" : c.pending ? "warn" : c.total ? "ok" : "";
      add(`PR #${pr.number}${done ? " " + pr.state.toLowerCase() : pr.draft ? " draft" : ""}${!done && c.total ? (c.failed ? ` · ${c.failed} failing` : c.pending ? ` · ${c.pending} running` : " · checks pass") : ""}`, cls,
        `${pr.title} → ${pr.base}${pr.review ? " · " + pr.review.toLowerCase().replace(/_/g, " ") : ""}`, () => api().open_url(pr.url));
    }
  }
  if (st && st.databricks) add(`Databricks ${st.databricks.label || st.databricks.profile}`, "", `${st.databricks.profile || ""} ${st.databricks.host || ""}`.trim());
  left.appendChild(crumbs);
}
function renameThread(S, node) {
  const input = el("input", "thread-title-edit");
  input.value = S.title || "";
  node.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save && v && v !== S.title) { S.title = v; await api().set_meta(S.sid, "title", v); loadHistory(); }
    renderBar();
  };
  input.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
}
function togglePanel(on, tab) {
  state.panel = on ?? !state.panel;
  if (tab) setTab(tab);
  if (!state.panel) document.body.classList.remove("view-full");
  $("#panel").hidden = !state.panel;
  applyPanelW();
  $("#panel-btn").classList.toggle("on", state.panel);
  if (state.panel) { renderPanel(); renderPR(); }
}
// the panel button and ⌘\ open the panel on the Shelf (the other tabs are a click away); a second press closes it
function openPanelButton() { state.panel ? togglePanel(false) : togglePanel(true, state.active ? "view" : state.tab); }
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === tab));
  if (tab !== "view") document.body.classList.remove("view-full");
  applyPanelW();
}
function renderPR() {
  const pr = state.repo.pr, box = $("#pr-card");
  box.innerHTML = "";
  if (!pr) return;
  const c = pr.checks;
  box.innerHTML = `<div class="pt"></div><div class="pm"><span>#${pr.number} → ${esc(pr.base)}</span><span>${esc(pr.state.toLowerCase())}${pr.draft ? " · draft" : ""}</span>` +
    (c.total ? `<span class="${c.failed ? "chip bad" : ""}">${c.passed}/${c.total} checks passed${c.failed ? `, ${c.failed} failing` : ""}${c.pending ? `, ${c.pending} running` : ""}</span>` : "") +
    (pr.review ? `<span>${esc(pr.review.toLowerCase().replace(/_/g, " "))}</span>` : "") + `</div>`;
  box.querySelector(".pt").textContent = pr.title;
  box.querySelector(".pt").onclick = () => api().open_url(pr.url);
}
// Changes and History only for chats whose folder is a git repo; the others get Notes and Stats.
function syncPanelTabs() {
  const git = !!state.repo.status?.git;
  document.querySelectorAll('.tab[data-tab="changes"], .tab[data-tab="history"]').forEach(t => t.hidden = !git);
  if (!git && (state.tab === "changes" || state.tab === "history")) setTab("notes");
}
async function renderPanel(fresh) {
  const body = $("#panel-body"), S = state.open.get(state.active), st = state.repo.status;
  syncPanelTabs();
  $("#pr-card").hidden = true;  // the Changes tab shows PRs itself; the top bar keeps the one-line PR status
  body.classList.remove("view-body");
  $("#panel-refresh").hidden = state.tab === "view";  // View has its own reload
  if (S && state.tab === "view") return renderView(S, body);
  if (S && state.tab === "stats") return renderStats(S, body);
  if (S && state.tab === "notes") return renderNotes(S, body);
  if (!S || !st) { body.innerHTML = ""; return; }
  if (!st.git) { body.innerHTML = ""; return; }
  if (state.tab === "history") return renderHistory(S, body, fresh);
  return renderChanges(S, body, fresh);
}

// ---------- permission mode and fast mode ----------
const MODES = ["auto", "acceptEdits", "plan", "manual"];  // ⇧Tab cycles these; Don't ask and Bypass are picked on purpose
function syncModes(S) {
  const sel = $("#mode-sel");
  sel.value = S.modes.permission || S.permMode || state.settings.perm_mode || "auto";
  syncRun();
  const fb = $("#fast-btn"), blocked = S.fast && (S.modes.fast === "off" || !!S.modes.fast_reason);
  fb.hidden = !!state.settings.fast_unavailable;  // this account can't use it: no button (Settings › Advanced can check again)
  fb.classList.toggle("on", S.fast && !blocked);
  fb.classList.toggle("blocked", !!blocked);
  fb.title = blocked ? `${S.modes.fast_reason || "Fast mode isn't available for this account"}. Tether will use it if that changes.` : S.fast ? "Fast mode is on" : "Fast mode: same model, faster output";
}
async function setMode(S, mode) {
  if (mode === "bypassPermissions") {
    const ok = await confirmBox("Bypass permissions?", "Claude will run every command and edit every file without asking, for this session only. Commits, pushes and deploys still ask.", "Bypass");
    if (!ok) return syncModes(S);
  }
  S.permMode = mode;
  S.modes.permission = mode;
  api().set_permission_mode(S.sid, mode);
  syncModes(S);
}
function confirmBox(title, text, yes, kind = "danger") {
  return new Promise(resolve => {
    const box = openModal(`<h2>${esc(title)}</h2><p class="modal-p">${esc(text)}</p><div class="modal-acts"><button class="btn ghost" data-k="no">Cancel</button><button class="btn ${kind}" data-k="yes">${esc(yes)}</button></div>`);
    let done = false;
    const finish = v => { if (done) return; done = true; closeModal(); resolve(v); };
    box.querySelectorAll("[data-k]").forEach(b => b.onclick = () => finish(b.dataset.k === "yes"));
    const obs = new MutationObserver(() => { if ($("#modal").hidden) { obs.disconnect(); finish(false); } });
    obs.observe($("#modal"), { attributes: true, attributeFilter: ["hidden"] });
  });
}

// ---------- view: Full (thinking, tools, diffs) or Chat (just the conversation) ----------
function applyTheme(t, accent = state.settings?.accent, glass = state.settings?.transparency, frost = state.settings?.frost) {
  const dark = t === "dark" || (t !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const was = document.body.classList.contains("dark");
  document.body.classList.toggle("dark", dark);
  applyGlass(glass, dark, frost);
  applyAccent(accent);
  if (diag.cache.size && (was !== dark || accent !== state.diagAccent)) redrawDiagrams();
  state.diagAccent = accent;
}
// Settings › Appearance › Transparency (0–100): how much of the desktop shows through the window. 0 is an ordinary
// solid window with the blur off. The sidebar and message box stay more opaque than the window, so their text
// keeps 4.5:1 at the top of the range; past 70 the faint text colors darken a step for light mode (glass-clear).
// Past 55 the window's tint and the material's own tint (set_look) both fade out, down to nearly clear glass at 100.
// Frost (0–100) sets the blur radius on its own, so the two combine freely.
const GLASS = {
  dark: { page: [13, 19, 23], side: [44, 56, 64], comp: [30, 40, 47], solid: ["#0F1519", "#182126", "#1C252B"], side_k: .66 },
  light: { page: [247, 250, 251], side: [255, 255, 255], comp: [255, 255, 255], solid: ["#EDF2F4", "#F8FAFB", "#FFFFFF"], side_k: .75 },
};
function applyGlass(t, dark = document.body.classList.contains("dark"), frost = state.settings?.frost) {
  t = Math.max(0, Math.min(100, Number(t ?? 55)));
  const G = GLASS[dark ? "dark" : "light"], b = document.body.style, rgba = (c, a) => `rgba(${c.join(", ")}, ${a.toFixed(3)})`;
  const a = t <= 55 ? 1 - .72 * t / 100 : .604 - .544 * (t - 55) / 45;  // the window's tint: 55 (default) ≈ .60, 100 = .06
  b.setProperty("--page", t ? rgba(G.page, a) : G.solid[0]);
  b.setProperty("--side-bg", t ? rgba(G.side, a * G.side_k) : G.solid[1]);
  b.setProperty("--composer-bg", t ? rgba(G.comp, Math.max(t > 55 ? .72 - .3 * (t - 55) / 45 : .72, a)) : G.solid[2]);
  document.body.classList.toggle("glass-clear", t >= 70);
  document.body.classList.toggle("glass-solid", !t);
  frost = Math.max(0, Math.min(100, Number(frost ?? 50)));
  window.pywebview?.api?.set_look?.(dark, t, frost);  // frost: the blur itself
  state.glass = { t, a: t ? a : 1, dark, frost, side: a * G.side_k, comp: Math.max(t > 55 ? .72 - .3 * (t - 55) / 45 : .72, a) };
  adaptGlass();
}
// Settings › Appearance › Adjust to what's behind: about once a second each pane looks at what's behind it (backdrop in
// workbench.py) and keeps its faintest text at 4.5:1. It keeps the theme's colors when they read, takes the other
// theme's when those read instead, and otherwise adds only as much tint as it needs. Frost counts: the more blur, the
// more what's behind evens out. Without Screen Recording it assumes the worst behind, so text still reads.
const TONE_TEXT = { light: [83, 98, 107], dark: [166, 178, 185] };  // --text-3 of each theme
// How bright the window itself comes out (macOS's frosted layer plus the page tint) over pure black and pure white
// behind, by transparency: measured on screen, since the frosted layer adds far more than the tint alone.
const GLASS_SEEN = {
  light: [[0, .87, .87], [55, .789, .869], [70, .50, .87], [85, .197, .902], [100, .057, .97]],
  dark: [[0, .008, .008], [55, .018, .025], [70, .02, .03], [85, .008, .28], [100, .004, .75]],
};
function glassSeen(theme, t) {  // [over black, over white] at this transparency
  const tb = GLASS_SEEN[theme];
  const i = Math.max(1, tb.findIndex(r => r[0] >= t)), [t0, a0, b0] = tb[i - 1], [t1, a1, b1] = tb[i], f = (t - t0) / (t1 - t0 || 1);
  return [a0 + (a1 - a0) * f, b0 + (b1 - b0) * f];
}
const PANES = [["#side", "side"], ["#panel", "side"], ["#main", "side"], ["#composer", "comp", ".composer-box"]];
const relLum = c => { const f = v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
let adaptBusy = false;
async function adaptGlass() {
  const g = state.glass;
  if (!g || !g.t || state.settings?.glass_adapt === false) return PANES.forEach(([sel]) => setTone($(sel)));
  if (adaptBusy) return;
  adaptBusy = true;
  let b = null;
  try { b = await window.pywebview?.api?.backdrop?.(); } catch { b = null; } finally { adaptBusy = false; }
  if (state.glass !== g) return;  // the look changed meanwhile; that call does its own pass
  const W = innerWidth, H = innerHeight, even = g.frost / 100;
  for (const [sel, kind, inner] of PANES) {
    const el = $(sel);
    if (!el || el.hidden || !el.offsetWidth) continue;
    const r = (inner && el.querySelector(inner) || el).getBoundingClientRect();
    let lo = 0, hi = 1;  // nothing seen: plan for black and white behind
    if (b?.y) {
      const v = [];
      for (let y = Math.max(0, Math.floor(r.top / H * b.rows)); y < Math.min(b.rows, Math.ceil(r.bottom / H * b.rows)); y++)
        for (let x = Math.max(0, Math.floor(r.left / W * b.cols)); x < Math.min(b.cols, Math.ceil(r.right / W * b.cols)); x++) v.push(b.y[y * b.cols + x]);
      if (v.length) {
        v.sort((p, q) => p - q);
        const mean = v.reduce((s, x) => s + x, 0) / v.length;
        lo = v[Math.floor(v.length * .1)]; hi = v[Math.min(v.length - 1, Math.floor(v.length * .9))];
        lo += (mean - lo) * even; hi += (mean - hi) * even;
      }
    }
    setTone(el, pickTone(el, kind, lo, hi, g), kind);
  }
}
function pickTone(el, kind, lo, hi, g) {
  const own = g.dark ? "dark" : "light", other = g.dark ? "light" : "dark";
  const [blk, wht] = glassSeen(own, g.t), under = y => blk + (wht - blk) * y;  // the window itself over what's behind
  const base = kind === "page" ? 0 : g[kind];
  const need = (tone, ratio) => {  // the least tint of this tone that gets its faint text to `ratio`
    const t = relLum(TONE_TEXT[tone]), c = relLum(GLASS[tone][kind]);
    if (tone === "light") {  // dark text: the darkest spot behind decides
      const goal = ratio * (t + .05) - .05, u = under(lo);
      return u >= goal ? 0 : c <= goal ? 1 : (goal - u) / (c - u);
    }
    const goal = (t + .05) / ratio - .05, u = under(hi);  // light text: the brightest spot behind decides
    return u <= goal ? 0 : c >= goal ? 1 : (u - goal) / (u - c);
  };
  const reads = (tone, ratio = 4.5) => need(tone, ratio) <= base;
  const cur = el.dataset.tone || own;
  let tone;
  if (cur === other && reads(other) && !reads(own, 5)) tone = other;  // a little slack, so a pane doesn't flicker
  else if (reads(own)) tone = own;
  else if (reads(other)) tone = other;
  else tone = need(own, 4.5) <= need(other, 4.5) + .05 ? own : other;
  return { tone, alpha: Math.min(1, Math.max(base, need(tone, 4.5))) };
}
function setTone(el, pick, kind) {
  if (!el) return;
  const st = el.style;
  if (!pick) {
    el.classList.remove("tone-light", "tone-dark"); delete el.dataset.tone;
    ["--page", "--side-bg", "--composer-bg", "--main-tint", ...ACCENT_KEYS].forEach(k => st.removeProperty(k));
    return;
  }
  const { tone, alpha } = pick, g = state.glass, rgba = (c, a) => `rgba(${c.join(", ")}, ${a.toFixed(3)})`;
  el.classList.toggle("tone-light", tone === "light"); el.classList.toggle("tone-dark", tone === "dark");
  el.dataset.tone = tone;
  st.setProperty("--page", rgba(GLASS[tone].page, g.a));
  st.setProperty("--side-bg", rgba(GLASS[tone].side, kind === "side" ? alpha : g.side));
  st.setProperty("--composer-bg", rgba(GLASS[tone].comp, kind === "comp" ? alpha : g.comp));
  st.setProperty("--main-tint", kind === "page" && alpha > .005 ? rgba(GLASS[tone].page, alpha) : "transparent");
  const acc = accentVars(state.settings?.accent, tone === "dark");  // a picked accent, shaded for this pane's colors
  ACCENT_KEYS.forEach(k => acc ? st.setProperty(k, acc[k]) : st.removeProperty(k));
}
setInterval(() => { if (!document.hidden) adaptGlass(); }, 1200);
// Settings › Appearance › Accent color: one picked color becomes the five accent tokens, shaded per theme so
// accent text keeps 4.5:1 on the page and button labels keep 4.5:1 on the fill. "" = the theme's own teal.
const ACCENT_KEYS = ["--accent", "--accent-fill", "--accent-hover", "--on-accent", "--accent-soft", "--accent-line"];
function applyAccent(hex) {
  const b = document.body.style, v = accentVars(hex, document.body.classList.contains("dark"));
  ACCENT_KEYS.forEach(k => v ? b.setProperty(k, v[k]) : b.removeProperty(k));
  if (state.glass) adaptGlass();
}
function accentVars(hex, dark) {
  const rgb = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!rgb) return null;
  const n = parseInt(rgb[1], 16), base = [n >> 16, (n >> 8) & 255, n & 255];
  const lum = c => { const f = v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, c) => { const x = lum(a), y = lum(c); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (c, to, t) => c.map((v, i) => Math.round(v + (to[i] - v) * t));
  const reach = (c, to, bgs, min) => { for (let t = 0; t <= 1.0001; t += 0.04) { const m = mix(c, to, t); if (bgs.every(g => ratio(m, g) >= min)) return m; } return to; };
  const css = c => `rgb(${c.join(", ")})`, alpha = (c, a) => `rgba(${c.join(", ")}, ${a})`;
  const WHITE = [255, 255, 255], INK = [18, 20, 23], BLACK = [0, 0, 0];
  const grounds = dark ? [[13, 19, 23], [30, 38, 44], [38, 47, 54]] : [[236, 241, 243], [255, 255, 255], [226, 233, 236]];  // window glass, cards, sidebar glass
  const text = reach(base, dark ? WHITE : BLACK, grounds, 4.5);
  const label = ratio(WHITE, base) >= ratio(INK, base) ? WHITE : INK;
  const fill = reach(base, label === WHITE ? BLACK : WHITE, [label], 4.5);  // the picked color, nudged only if labels wouldn't read
  return {
    "--accent": css(text), "--accent-fill": css(fill), "--accent-hover": css(mix(fill, label === WHITE ? BLACK : WHITE, 0.14)),
    "--on-accent": css(label), "--accent-soft": alpha(text, dark ? 0.12 : 0.09), "--accent-line": alpha(text, dark ? 0.45 : 0.42),
  };
}
// Only follow the system when the theme is set to follow it. Setting the window's own appearance (set_look) fires this
// too, and re-applying saved settings then would undo a preview in Settings, frost and transparency included.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!["dark", "light"].includes(state.settings.theme) && $("#modal").hidden) applyTheme(state.settings.theme);
});
const TEXT_SIZES = [90, 100, 110, 125, 140, 160];
function applyText(size, boldAccent) {
  document.documentElement.style.setProperty("--fs-scale", String((Number(size) || 100) / 100));
  document.body.classList.toggle("bold-accent", !!boldAccent);
  requestAnimationFrame(() => glide($("#view-seg")));
}
async function stepText(dir) {  // ⌘+ / ⌘− / ⌘0
  const cur = Number(state.settings.text_size) || 100;
  const next = dir === 0 ? 100 : dir > 0 ? TEXT_SIZES.find(v => v > cur) : TEXT_SIZES.findLast(v => v < cur);
  if (!next || next === cur) return;
  state.settings.text_size = next;  // before the save returns, so quick repeat presses keep stepping
  applyText(next, state.settings.bold_accent);
  $("#toast .t.textsize")?.remove();  // one size toast, not a stack
  toast(`Text size ${next}%`, "textsize");
  await api().save_settings({ text_size: next });
}

const VIEWS = {
  full: { name: "Full", text: "Everything as it happens: thinking, every command and tool call with its output, and file diffs." },
  thinking: { name: "Thinking", text: "Claude's thinking and replies, and a working line with the current step. Commands and tool calls stay hidden." },
  chat: { name: "Chat", text: "Just your messages and Claude's replies. A working line shows what it's doing." },
};
function setView(v, save = true) {
  state.view = ["chat", "thinking"].includes(v) ? v : "full";
  $("#chats").classList.toggle("view-chat", state.view === "chat");
  $("#chats").classList.toggle("view-thinking", state.view === "thinking");
  if (state.view === "thinking") document.querySelectorAll("#chats details.thinking").forEach(d => { d.open = true; });
  document.querySelectorAll("#view-seg button").forEach(b => b.classList.toggle("on", b.dataset.v === state.view));
  glide($("#view-seg"));
  if (save) { $("#chats").classList.remove("switching"); void $("#chats").offsetWidth; $("#chats").classList.add("switching"); }
  if (save) api().save_settings({ view: state.view }).then(s => { state.settings = s; });
  const S = state.open.get(state.active);
  if (S) scrollDown(S, true);
}

// A segmented control's thumb slides to the selected button.
function glide(seg) {
  const on = seg.querySelector("button.on"), th = seg.querySelector(".thumb");
  if (!on || !th) return;
  th.style.left = on.offsetLeft + "px"; th.style.width = on.offsetWidth + "px";
}

// ---------- session stats (only here, never in the chat) ----------
const usd = v => v == null ? "–" : v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(v < 1 ? 3 : 2)}`;
const tok = n => n == null ? "–" : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString();
const dur = ms => { if (!ms) return "–"; const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor(m % 1440 / 60)}h`; };
const day = iso => iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "–";
const modelName = m => {
  const long = /\[1m\]$/.test(m);
  const parts = m.replace(/^claude-/, "").replace(/\[1m\]$/, "").split("-");
  const nums = parts.slice(1).filter(p => /^\d{1,2}$/.test(p));
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + (nums.length ? " " + nums.join(".") : "") + (long ? " (1M)" : "");
};
const tailPath = p => { const seg = p.split("/").filter(Boolean); return seg.length > 3 ? "…/" + seg.slice(-3).join("/") : p; };

// ---------- notes: what a fresh session needs from this one; and handing off to one ----------
async function renderNotes(S, body) {
  const d = await api().notes_get(S.sid);
  if (state.tab !== "notes" || state.active !== S.sid) return;
  const when = d.updated ? new Date(d.updated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const prog = S.notesProg ? ` · reading ${S.notesProg}` : "";
  body.innerHTML = `<div class="notes-top"><span class="dim">${d.busy ? "Updating" + prog : when ? `Updated ${when}` : "No notes yet"}${d.items.length ? ` · ${d.items.length} notes` : ""}${d.cost ? ` · ${d.cost < 0.01 ? "under $0.01" : "$" + d.cost.toFixed(2)} so far` : ""}</span>
      <button class="btn ghost small" id="notes-up" ${d.busy ? "disabled" : ""}>Update now</button></div>
    ${d.parents.length ? `<div class="notes-from dim">Continues an earlier session; recall searches both.</div>` : ""}
    <div class="notes-list"></div>
    <div class="notes-add"><select id="notes-sec">${d.sections.map(s => `<option>${s}</option>`).join("")}</select><input id="notes-text" placeholder="Add a note"><button class="btn ghost small" id="notes-addbtn">Add</button></div>
    <div class="notes-hand"><button class="btn" id="notes-handoff">Start fresh now</button>
      <p class="dim">${+state.settings.auto_fresh ? `Tether does this by itself at ${kfmt(+state.settings.auto_fresh)} tokens.` : "Automatic fresh starts are off (Settings › Sessions)."} The fresh session gets these notes, where this one left off, and recall into its full history.</p></div>`;
  const list = body.querySelector(".notes-list");
  for (const sec of d.sections) {
    const rows = d.items.filter(i => i.s === sec);
    if (!rows.length) continue;
    const g = el("section", "notes-sec", `<h3>${sec}</h3>`);
    rows.sort((a, b) => (a.status === "done") - (b.status === "done"));
    for (const it of rows) {
      const r = el("div", "note-it" + (it.status === "done" ? " done" : ""), `<span class="t"></span><span class="acts">${sec === "Open" && it.status !== "done" ? `<button class="x" data-op="done" title="Done">✓</button>` : ""}<button class="x" data-op="drop" title="Remove">×</button></span>`);
      r.querySelector(".t").textContent = it.t;
      r.title = (it.from ? "From an earlier session · " : "") + (it.at ? `line ${it.at}${it.ts ? " · " + it.ts : ""}` : it.by === "you" ? "Added by you" : "");
      r.querySelectorAll("[data-op]").forEach(b => b.onclick = async () => { await api().notes_edit(S.sid, b.dataset.op, it.id); renderNotes(S, body); });
      g.appendChild(r);
    }
    list.appendChild(g);
  }
  hydrate(S, list);
  if (!d.items.length) list.appendChild(el("div", "panel-empty", d.busy ? "Reading the conversation…" : "Tether starts notes once a session gets long. Update now to start them here."));
  body.querySelector("#notes-up").onclick = () => { api().notes_update(S.sid); renderNotes(S, body); };
  const addIt = async () => { const t = body.querySelector("#notes-text").value.trim(); if (!t) return; await api().notes_edit(S.sid, "add", { s: body.querySelector("#notes-sec").value, t }); renderNotes(S, body); };
  body.querySelector("#notes-addbtn").onclick = addIt;
  body.querySelector("#notes-text").onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") addIt(); };
  body.querySelector("#notes-handoff").onclick = () => handoff(S.sid);
}
async function handoff(sid) {
  const cur = state.open.get(sid);
  if (cur && ["running", "waiting", "starting"].includes(cur.status)) return toast("Wait for Claude to finish, then start fresh.");
  const ok = await confirmBox("Start fresh now?", "Tether brings this session's notes up to date, then continues in a fresh session with them, where this one left off, and recall into its full history. Your next message goes to the fresh one.", "Start fresh", "primary");
  if (!ok) return;
  toast("Preparing a fresh start…");
  const r = await api().handoff(sid);
  if (!r || r.error) return toast(r?.error || "Couldn't start it.", "error");
  freshStart({ ...r, old: sid, auto: false });
}
// The divider where one part of a long conversation hands over to the next.
function freshCard(S, ev) {
  const why = ev.auto && ev.context ? `The chat reached ${kfmt(ev.context)} tokens, so it continues fresh here. ` : "";
  const d = el("details", "note handoff", `<summary title="${why}Claude has the notes and can look up anything from before."><span>Fresh start · <span class="lnk">What carried over</span></span></summary><div class="msg-text handoff-body"></div>`);
  d.ontoggle = async () => {
    const b = d.querySelector(".handoff-body");
    if (!d.open || b.innerHTML) return;
    const txt = ev.carried || (await api().carry_text(S.sid)) || "";
    renderMarkdown(b, txt.replace(/^\[(Tether|Tether) handoff\]\s*/, "")); hydrate(S, b);
  };
  return d;
}
// Shouldn't happen (Tether waits for the reply and any job before switching), but if the old part still answers after
// the chat moved on, say so in the chat instead of losing it.
function lateReply(oldSid) {
  const N = state.open.get(state.moved?.[oldSid]);
  if (!N || N.lateNoted?.has(oldSid)) return;
  (N.lateNoted ||= new Set()).add(oldSid);
  const n = el("div", "note late", `The previous session finished a reply after the fresh start · <span class="lnk">Open it</span>`);
  n.querySelector(".lnk").onclick = () => openSession(oldSid, N.cwd, N.title);
  add(N, n);
}
// The server rolled a session over: the chat carries straight on in the new part.
function freshStart(ev) {
  ev = { ...ev, old: ev.old || ev.from };  // the server names the previous part "from"
  const old = state.open.get(ev.old);
  const N = makeSession({ ...ev, items: [] });
  N.title = ev.title;
  if (old) {
    [...old.inner.childNodes].filter(n => !n.classList?.contains("working")).forEach(n => N.inner.appendChild(n));
    N.draft = old.draft; N.ctxUsage = null;
    old.el.remove(); clearInterval(old.timer); state.open.delete(ev.old);
  }
  (state.moved ||= {})[ev.old] = N.sid;
  add(N, freshCard(N, { ...ev, from: ev.old?.slice(0, 8) }));
  if (state.active === ev.old || !state.active) activate(N.sid);
  renderSidebar(); loadHistory();
}

// Stats › Loaded in this session. Claude Code reports connectors when asked (no tokens); a "loaded" event refills this.
const CONN_STATE = { connected: ["ok", "Connected"], pending: ["", "Connecting"], "needs-auth": ["bad", "Sign in needed"], failed: ["bad", "Failed"], disabled: ["", "Off"] };
const connName = n => n === "workbench" ? "Tether" : (n.replace(/(-local)?(-mcp|-server)$/, "") || n).replace(/^./, ch => ch.toUpperCase());
async function fillLoaded(box, sid, refresh) {
  const L = await api().loaded(sid, refresh);
  if (!box.isConnected || !L) return;
  box.querySelectorAll(":scope > :not(.st-h)").forEach(n => n.remove());
  const row = (left, cls, mid, right, tip) => { const r = el("div", "st-conn", `<span class="st ${cls}">${cls === "ok" || cls === "bad" ? `<span class="dot"></span>` : ""}${esc(left)}</span><span class="n"></span>${right ? `<span class="g">${esc(right)}</span>` : ""}`); r.querySelector(".n").textContent = mid; if (tip) r.title = tip; box.appendChild(r); };
  if (!L.mcp) row("Starting", "", "Claude is starting up");
  else L.mcp.forEach(m => { const [cls, word] = CONN_STATE[m.status] || ["", m.status]; row(word, cls, connName(m.name), m.status === "connected" ? `${m.tools} tool${m.tools === 1 ? "" : "s"}` : "", m.error || m.name); });
  const skills = L.skills || [], mine = L.user_skills || [];
  row("Plugins", "", (L.plugins || []).join(", ") || "None");
  if (mine.length) row("Your skills", "", mine.join(", "));
  const built = skills.filter(k => !k.includes(":") && !mine.includes(k));
  if (L.skills || L.agents?.length) row("Built in", "", [L.skills ? `${built.length} skills` : "", L.agents?.length ? `${L.agents.length} agents` : ""].filter(Boolean).join(" · "), "", [...built, ...(L.agents || [])].join(", "));
}
async function renderStats(S, body) {
  body.innerHTML = `<div class="panel-empty">Reading the session…</div>`;
  const sid = S.sid;
  const s = await api().session_stats(sid);
  if (state.active !== sid || state.tab !== "stats") return;
  body.innerHTML = "";
  if (s.error) { body.appendChild(el("div", "panel-empty", esc(s.error))); return; }
  const c = s.cost || {}, ms = c.models || [];
  const sum = k => ms.reduce((a, m) => a + (m[k] || 0), 0);
  const totalTok = sum("cache_read") + sum("cache_write") + sum("output") + sum("input");
  if (s.parts) body.appendChild(el("div", "st-note", `Whole chat · ${s.parts.length} sessions`));
  const tiles = el("div", "st-tiles");
  [[usd(c.usd), "Cost"], [s.turns.toLocaleString(), "Your messages"], [tok(s.context), "Context now"],
   [String(s.compactions), s.last_compaction ? `Compactions · last ${new Date(s.last_compaction).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "Compactions"]]
    .forEach(([v, l]) => tiles.appendChild(el("div", "st-tile", `<div class="v">${esc(v)}</div><div class="l">${esc(l)}</div>`)));
  body.appendChild(tiles);
  const sec = (title, rows, cls = "") => { const b = el("div", "st-sec" + (cls ? " " + cls : ""), `<div class="st-h">${esc(title)}</div>`); rows.forEach(r => b.appendChild(r)); body.appendChild(b); return b; };
  const kv = (k, v, grey) => el("div", "st-kv", `<span>${esc(k)}</span>${grey ? `<span class="g">${esc(grey)}</span>` : ""}<b>${esc(v)}</b>`);
  const bar = (label, n, max, right, grey) => el("div", "st-bar", `<div class="top"><span>${esc(label)}</span>${grey ? `<span class="g">${esc(grey)}</span>` : ""}<b>${esc(right)}</b></div><div class="track"><div style="width:${max ? Math.max(1.5, n / max * 100) : 0}%"></div></div>`);
  const line = t => el("div", "st-line", esc(t));
  if (ms.length) {
    const replies = {};  // replies per model, keyed by the shown name so the cost and reply lists line up
    s.models.forEach(([m, n]) => { const k = modelName(m); replies[k] = (replies[k] || 0) + n; });
    const maxC = Math.max(...ms.map(m => m.usd || 0));
    const cost = sec("Cost by model", ms.map(m => { const r = replies[modelName(m.model)]; return bar(modelName(m.model), m.usd || 0, maxC, usd(m.usd), r ? `${r.toLocaleString()} repl${r === 1 ? "y" : "ies"}` : ""); }));
    cost.appendChild(line(`${tok(totalTok)} tokens · ${totalTok ? Math.round(sum("cache_read") / totalTok * 100) : 0}% cache reads`));
    if (c.unknown_model_cost) cost.appendChild(el("div", "st-note", "Some models had no known price, so the cost is a lower bound."));
    if (c.missing) cost.appendChild(el("div", "st-note", `${c.missing} session${c.missing === 1 ? " has" : "s have"} no cost record, so the cost is a lower bound.`));
  } else {
    sec("Cost by model", [el("div", "st-note", "No cost record in this session yet.")]);
  }
  fillLoaded(sec("Loaded in this session", [], "st-loaded"), S.sid, true);
  const totalTools = s.tools.reduce((a, t) => a + t[1], 0);
  const work = sec("Work", [kv("Tool calls", totalTools.toLocaleString(), s.tool_errors ? `${s.tool_errors} failed` : ""),
    kv("Lines changed", c.lines_added != null ? `+${c.lines_added.toLocaleString()} −${(c.lines_removed || 0).toLocaleString()}` : "–"), kv("Files edited", String(s.files_total))]);
  if (s.tools.length) work.appendChild(line(s.tools.slice(0, 5).map(([n, v]) => `${n.startsWith("mcp__") ? n.split("__").pop() : n} ${v.toLocaleString()}`).join(" · ")));
  s.files.forEach((x, i) => { const r = el("div", "st-file" + (i > 2 ? " more" : ""), `<a class="path" data-path="${esc(x.path)}" title="${esc(x.short)}">${esc(tailPath(x.short))}</a><span>${x.edits}×</span>`); work.appendChild(r); });
  if (s.files.length > 3) {
    const more = el("button", "st-more", s.files_total > s.files.length ? `${s.files.length - 3} more of ${s.files_total} files` : `${s.files.length - 3} more files`);
    more.onclick = () => { work.classList.add("all"); more.remove(); };
    work.appendChild(more);
  }
  sec("Time", [kv("Started", day(s.first)), kv("Last activity", day(s.last)), kv("Claude working", dur(c.api_ms)),
    ...(s.where.length ? [kv("Ran in", s.where.map(([w, n]) => `${w} ${n.toLocaleString()}`).join(" · "))] : [])]);
  if (s.parts) sec("Sessions in this chat", s.parts.map((p, i) => kv(`${day(p.first)} – ${i === 0 ? "now" : day(p.last)}`, usd(p.usd), `${p.turns.toLocaleString()}${i === 0 ? " · current" : ""}`)));
  body.appendChild(el("div", "st-note", `${s.parts ? "Session files" : "Session file"} ${s.size_mb} MB · ${esc(sid)}`));
  // most of a long session's file is old screenshots; offer to drop the ones before the last compaction
  api().slim_info(sid).then(p => {
    if (!p || p.error || p.removable < 20e6 || state.tab !== "stats" || state.active !== S.sid) return;
    const mb = n => `${Math.round(n / 1e6)} MB`;
    const b = el("div", "st-sec slim", `<div class="st-h">Transcript size</div>
      <p class="st-note">${mb(p.removable)} of this file is screenshots from before the last compaction. Claude no longer has them in context, so removing them doesn't change how the session resumes.</p>
      <button class="btn small" ${p.blocked ? `disabled title="${esc(p.blocked)}"` : ""}>Remove old screenshots (${mb(p.size)} → about ${mb(p.size - p.removable * 1.0)})</button>
      ${p.blocked ? `<p class="st-note">${esc(p.blocked)}</p>` : ""}`);
    b.querySelector("button").onclick = async () => {
      if (!await confirmBox("Remove old screenshots?", `Images from before the last compaction are replaced with a short note. The original file is kept as a compressed backup in Tether's support folder, which you can delete later.`, "Remove", "primary")) return;
      const r = await api().slim_session(sid, true);
      if (r.error) return toast(r.error, "error");
      toast(`Transcript is now ${mb(r.new_size)} (was ${mb(r.size)}).`);
      renderPanel();
    };
    body.appendChild(b);
  });
}

// ---------- files ----------
// Images go in as images, like a paste; any other file goes as its path and Claude opens it with Read.
async function attachFiles() {
  const S = state.open.get(state.active);
  if (!S) return;
  const got = await api().pick_files();
  if (got.error) return toast(got.error, "error");
  got.files.forEach(f => S.attachments.push(f));
  renderAttachments();
  $("#input").focus();
}

window.onDropped = got => {
  $("#dropzone").hidden = true;
  const S = state.open.get(state.active);
  if (!S) return toast("Open a session to attach files.");
  if (got.error) return toast(got.error, "error");
  got.files.forEach(f => S.attachments.push(f));
  renderAttachments();
  $("#input").focus();
};

// ---------- ⌘K: sessions, repos and actions in one list ----------
const pal = { items: [], sel: 0 };
function openPalette() {
  $("#palette-scrim").hidden = $("#palette").hidden = false;
  requestAnimationFrame(() => { $("#palette").classList.add("show"); $("#palette-scrim").classList.add("show"); });
  const q = $("#pal-q"); q.value = ""; q.focus();
  renderPalette();
}
function closePalette() {
  if ($("#palette").hidden) return false;
  $("#palette").classList.remove("show"); $("#palette-scrim").classList.remove("show");
  setTimeout(() => { if (!$("#palette").classList.contains("show")) $("#palette").hidden = $("#palette-scrim").hidden = true; }, 200);
  if (state.active) $("#input").focus();
  return true;
}
function paletteActions() {
  const S = state.open.get(state.active), A = (name, keys, run, when = true) => when && { name, keys, run };
  return [A("New session", "⌘N", newSessionDialog), A("Settings", "⌘,", settingsDialog),
    A("Full view", "", () => setView("full")), A("Thinking view", "", () => setView("thinking")), A("Chat view", "", () => setView("chat")),
    A("Changes and history", "", () => togglePanel(true, state.repo.status?.git ? "changes" : "notes"), !!S), A("Notes", "", () => togglePanel(true, "notes"), !!S), A("Stats", "⌘I", () => togglePanel(true, "stats"), !!S), A("Shelf", "⌘J", () => togglePanel(true, "view"), !!S),
    A("Continue in a new session", "", () => handoff(S.sid), !!S), A("Reload this session", "⌘R", () => reloadSession(S.sid), !!S), A("Close this session", "⌘W", closeActive, !!S),
    A(state.showArchived ? "Hide archived sessions" : "Show archived sessions", "", () => $("#archived-btn").click())].filter(Boolean);
}
function renderPalette() {
  const q = $("#pal-q").value.trim().toLowerCase(), hit = t => !q || t.toLowerCase().includes(q);
  const acts = paletteActions().filter(a => hit(a.name)).slice(0, q ? 6 : 4).map(a => ({ kind: "Actions", label: a.name, sub: a.keys, run: a.run }));
  const sess = (state.sessions || []).filter(s => hit(`${s.title} ${s.cwd} ${s.group || ""} ${s.branch || ""}`)).slice(0, q ? 12 : 6)
    .map(s => ({ kind: "Sessions", label: s.title || "New session", sub: (state.open.has(s.id) ? "Open · " : "") + (s.group || basename(s.cwd)) + " · " + ago(s.mtime), run: () => openSession(s.id, s.cwd, s.title) }));
  const repos = recentRepos().filter(r => hit(`${r.name} ${r.cwd}`)).slice(0, q ? 6 : 3).map(r => ({ kind: "New session in", label: r.name, sub: tilde(r.cwd), run: () => newSession(r.cwd) }));
  pal.items = q ? [...sess, ...repos, ...acts] : [...acts, ...sess, ...repos];
  pal.sel = Math.min(pal.sel, Math.max(0, pal.items.length - 1));
  let last = "";
  $("#pal-res").innerHTML = pal.items.map((it, i) => (it.kind !== last ? `<div class="lab">${esc(last = it.kind)}</div>` : "") +
    `<div class="it${i === pal.sel ? " kb" : ""}" data-i="${i}"><span class="a">${esc(it.label)}</span><span class="m">${esc(it.sub || "")}</span></div>`).join("") || `<div class="lab">Nothing matches</div>`;
  $("#pal-res").querySelectorAll(".it").forEach(n => { n.onclick = () => runPalette(+n.dataset.i); n.onmousemove = () => { if (pal.sel !== +n.dataset.i) { pal.sel = +n.dataset.i; markPalette(); } }; });
}
function markPalette() { $("#pal-res").querySelectorAll(".it").forEach(n => n.classList.toggle("kb", +n.dataset.i === pal.sel)); $("#pal-res .it.kb")?.scrollIntoView({ block: "nearest" }); }
function runPalette(i) { const it = pal.items[i]; if (!it) return; closePalette(); it.run(); }

// ---------- modal + settings ----------
function openModal(html) {
  const m = $("#modal"), box = m.querySelector(".modal-box");
  box.innerHTML = html;
  m.hidden = false;
  box.querySelectorAll("[data-close]").forEach(b => b.onclick = closeModal);
  return box;
}
function closeModal() { $("#modal").hidden = true; $(".modal-box").classList.remove("sheet"); applyTheme(state.settings.theme); applyText(state.settings.text_size, state.settings.bold_accent); }

async function settingsDialog() {
  const { settings: s, hotkeys, mics } = await api().get_settings();
  if (!state.models?.length) state.models = await api().models();  // the model list for new chats
  const opts = (pairs, v) => pairs.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? "selected" : ""}>${esc(l)}</option>`).join("");
  const keys = v => opts(Object.entries(hotkeys), v);
  const row = (label, control, tip) => `<div class="setrow"${tip ? ` title="${esc(tip)}"` : ""}><label>${label}</label>${control}</div>`;
  const sw = (k, on) => `<label class="switch"><input type="checkbox" data-k="${k}" ${on ? "checked" : ""}><span class="track"></span></label>`;
  const sec = (title, rows) => `<section class="set-sec"><h3>${title}</h3>${rows}</section>`;
  const box = openModal(`<h2>Settings</h2>
    ${sec("Sessions", row("Keep notes for long sessions", sw("keep_notes", s.keep_notes !== false), "Haiku keeps running notes once a session gets long (about a cent per update). Recall and Continue in a new session use them")
      + row("Start fresh automatically", `<select data-k="auto_fresh">${opts([["0", "Never (compact instead)"], ["150000", "At 150k tokens"], ["200000", "At 200k tokens (recommended)"], ["300000", "At 300k tokens"]], String(s.auto_fresh ?? 200000))}</select>`, "When a conversation gets long, Tether continues it in a fresh session with its notes and recall into the old one. Cheaper than letting it grow; nothing for you to do")
      + row("Model for new chats", `<select data-k="model">${opts([["", "Claude Code default"], ...(state.models || []).filter(m => m.value !== "default").map(m => [m.value, m.displayName || m.value])], s.model)}</select>`,
      "The model picker by the message box changes only the chat you're in")
      + row("Effort for new chats", `<select data-k="effort">${opts([["", "Claude Code default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]], s.effort)}</select>`)
      + row("Start new sessions in", `<select data-k="perm_mode">${opts([["", "Claude Code default"], ...[...$("#mode-sel").options].map(o => [o.value, o.text])], s.perm_mode)}</select>`,
      "Also applies when you open a past session. The mode menu by the message box changes only the session you're in"))}
    ${sec("Appearance", row("Theme", `<select data-k="theme">${opts([["system", "Match system"], ["dark", "Dark"], ["light", "Light"]], s.theme)}</select>`)
      + row("Transparency", `<span class="range-pick"><input type="range" min="0" max="100" step="1" data-k="transparency" value="${esc(s.transparency ?? 55)}"><span class="mono">${esc(s.transparency ?? 55)}%</span></span>`, "How much of your desktop shows through the window. 0 is a solid window")
      + row("Frost", `<span class="range-pick"><input type="range" min="0" max="100" step="1" data-k="frost" value="${esc(s.frost ?? 50)}"><span class="mono">${esc(s.frost ?? 50)}%</span></span>`, "How strongly the desktop behind the window is blurred. 0 is sharp, 50 is the macOS default")
      + row("Adjust to what's behind", sw("glass_adapt", s.glass_adapt !== false), "Each part of the window checks what's behind it about once a second, and switches to dark or light text, or adds a little tint, so text stays readable")
      + row("Accent color", `<span class="accent-pick"><input type="color" data-accent value="${esc(s.accent || "#0B6E86")}"><input type="text" class="mono" data-k="accent" value="${esc(s.accent || "")}" placeholder="Default" spellcheck="false"><button class="btn ghost small" data-accent-reset ${s.accent ? "" : "hidden"}>Default</button></span>`, "Any color. Tether shades it for light and dark so text and buttons stay readable")
      + row("Text size", `<select data-k="text_size">${opts(TEXT_SIZES.map(v => [String(v), v === 100 ? "100% (default)" : v + "%"]), String(s.text_size ?? 100))}</select>`, "Every font in the window. ⌘+ and ⌘− step it, ⌘0 resets")
      + row("Color bold words", sw("bold_accent", s.bold_accent !== false), "Bold words in Claude's replies take the accent color, so the key points stand out. Links get an underline to stay distinct")
      + row("Reply animation", `<select data-k="reply_anim">${opts([["blur", "Blur in"], ["scan", "Scan line"], ["pop", "Pop through"], ["off", "Off"]], s.reply_anim || "blur")}</select>`, "How a reply lands: words come into focus, a glowing bar sweeps each line, or letters pop up through the glass, hang in the air and settle. Either way the whole reply is in within about a second and the chat glides with it. Your Mac's Reduce motion setting turns it off")
      + row("While Claude works", `<select data-k="working_anim">${opts([["mix", "A different one each time"], ["runner", "Runner"], ["ninja", "Ninja"], ["dragon", "Dragon"], ["soccer", "Soccer player"], ["snake", "Snake"], ["wizard", "Wizard"], ["dot", "Simple dot"]], s.working_anim)}</select>`, "The animation on the working line. Your Mac's Reduce motion setting turns it off"))}
    ${sec("Voice", row("Hold to talk", `<select data-k="voice_key">${keys(s.voice_key)}</select>`, "Works from any app")
      + row("Microphone", `<select data-k="mic">${opts([["", "System default"], ...mics.map(m => [m, m])], s.mic)}</select>`)
      + row("Send when you stop talking", sw("auto_send_dictation", s.auto_send_dictation)))}
    ${sec("Screen", row("Circle to explain", `<select data-k="circle_key">${keys(s.circle_key)}</select>`)
      + row("Keep Claude's marks for", `<select data-k="mark_linger">${opts([["10", "10 seconds"], ["30", "30 seconds"], ["60", "1 minute"], ["300", "5 minutes"], ["0", "Until my next message"]], String(s.mark_linger))}</select>`))}
    ${sec("Shelf", row("Show items from", `<select data-k="shelf_hours">${opts([["24", "The last day"], ["72", "The last 3 days"], ["168", "The last week"], ["0", "The whole chat"]], String(s.shelf_hours ?? 24))}</select>`, "Older ones wait under Earlier in the Shelf's item menu"))}
    ${sec("Notifications", row("When a session finishes or needs me", sw("notify", s.notify), "Only while Tether is in the background"))}
    <section class="set-sec"><h3>Advanced</h3>
      ${row("Stream Claude's thinking", sw("show_thinking", s.show_thinking), "Applies to sessions started after you change it")}
      ${row("Speech model", `<select data-k="whisper_model">${opts([["tiny", "Tiny (fastest)"], ["base", "Base"], ["small", "Small"], ["medium", "Medium (most accurate)"]], s.whisper_model)}</select>`)}
      ${row("Words to listen for", `<textarea class="field" data-k="vocabulary">${esc(s.vocabulary)}</textarea>`, "Names and terms the speech model should spell right")}
      ${row("Pinned folders", `<textarea class="field" data-k="pinned" placeholder="One per line">${esc((s.pinned || []).join("\n"))}</textarea>`, "Always offered first in New session")}
      ${row("History", `<select data-k="history_days">${opts([["14", "2 weeks"], ["45", "45 days"], ["90", "90 days"], ["365", "1 year"]], String(s.history_days))}</select>`)}
      ${s.fast_unavailable ? row("Fast mode", `<span class="dim">${esc(s.fast_unavailable)}</span> <button class="btn ghost small" id="fast-recheck">Check again</button>`, "Shows the Fast button again; it hides itself if your account still can't use it") : ""}
      ${row("claude command", `<input type="text" data-k="claude_path" value="${esc(s.claude_path)}" placeholder="Found automatically">`)}
    </section>
    <div class="modal-acts"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-save>Save</button></div>`);
  sheetNav(box);
  box.querySelector("#fast-recheck")?.addEventListener("click", async e => {
    state.settings = await api().save_settings({ fast_unavailable: "" });
    e.target.closest(".setrow").remove();
    const S = state.open.get(state.active); if (S) syncModes(S);
  });
  const accentHex = box.querySelector("[data-k=accent]"), accentWell = box.querySelector("[data-accent]"), accentReset = box.querySelector("[data-accent-reset]");
  const previewAccent = () => { const v = accentHex.value.trim(); accentReset.hidden = !v; applyAccent(/^#?[0-9a-f]{6}$/i.test(v) ? v : ""); };
  accentWell.oninput = () => { accentHex.value = accentWell.value.toUpperCase(); previewAccent(); };
  accentHex.oninput = () => { let v = accentHex.value.trim(); if (/^[0-9a-f]{6}$/i.test(v)) v = "#" + v; if (/^#[0-9a-f]{6}$/i.test(v)) accentWell.value = v; previewAccent(); };
  accentHex.onchange = () => { const v = accentHex.value.trim(); accentHex.value = /^#?[0-9a-f]{6}$/i.test(v) ? "#" + v.replace("#", "").toUpperCase() : ""; previewAccent(); };
  accentReset.onclick = () => { accentHex.value = ""; accentWell.value = "#0B6E86"; previewAccent(); };
  const glassIn = box.querySelector("[data-k=transparency]"), frostIn = box.querySelector("[data-k=frost]");
  const previewLook = () => {
    glassIn.nextElementSibling.textContent = glassIn.value + "%"; frostIn.nextElementSibling.textContent = frostIn.value + "%";
    frostIn.disabled = !+glassIn.value;  // a solid window has nothing to blur
    applyTheme(box.querySelector("[data-k=theme]").value, accentHex.value.trim(), glassIn.value, frostIn.value);
  };
  box.querySelector("[data-k=theme]").onchange = glassIn.oninput = frostIn.oninput = previewLook;  // preview straight away
  frostIn.disabled = !+glassIn.value;
  const previewText = () => applyText(box.querySelector("[data-k=text_size]").value, box.querySelector("[data-k=bold_accent]").checked);
  box.querySelector("[data-k=text_size]").onchange = box.querySelector("[data-k=bold_accent]").onchange = previewText;
  box.querySelector("[data-close]").addEventListener("click", () => applyTheme(state.settings.theme));
  box.querySelector("[data-save]").onclick = async () => {
    const out = {};
    box.querySelectorAll("[data-k]").forEach(i => {
      const k = i.dataset.k;
      out[k] = i.type === "checkbox" ? i.checked : ["mark_linger", "history_days", "shelf_hours", "auto_fresh", "text_size", "transparency", "frost"].includes(k) ? Number(i.value)
        : k === "pinned" ? i.value.split("\n").map(x => x.trim()).filter(Boolean)
        : k === "accent" ? (/^#?[0-9a-f]{6}$/i.test(i.value.trim()) ? "#" + i.value.trim().replace("#", "").toUpperCase() : "") : i.value;
    });
    if (out.perm_mode === "bypassPermissions" && s.perm_mode !== out.perm_mode &&  // the confirm replaces this dialog, so values are read first
        !await confirmBox("Bypass permissions for every session?", "Every new or reopened session will run commands and edit files without asking. Commits, pushes and deploys still ask.", "Bypass")) delete out.perm_mode;
    state.settings = await api().save_settings(out);
    applyTheme(state.settings.theme);
    showKeys();
    closeModal();
    loadHistory();
  };
}
// Settings as a sheet: the sections listed on the left, one shown at a time; Save and Cancel stay put.
function sheetNav(box) {
  const secs = [...box.querySelectorAll(".set-sec")];
  const nav = el("nav", "sheet-nav", `<span class="nhl"></span>`), pages = el("div", "sheet-pages");
  const show = i => {
    secs.forEach((x, j) => { x.hidden = j !== i; });
    nav.querySelectorAll("button").forEach((b, j) => b.classList.toggle("on", j === i));
    const on = nav.querySelectorAll("button")[i], hl = nav.querySelector(".nhl");
    hl.style.top = on.offsetTop + "px"; hl.style.height = on.offsetHeight + "px";
  };
  secs.forEach((x, i) => { const b = el("button", "", esc(x.querySelector("h3").textContent)); b.onclick = () => show(i); nav.appendChild(b); pages.appendChild(x); });
  box.querySelector("h2").after(nav);
  nav.after(pages);
  box.classList.add("sheet");
  requestAnimationFrame(() => show(0));
}
function showKeys() {
  const h = state.hotkeys, s = state.settings;
  $("#keys-hint").textContent = "";
  $("#mic-btn").title = `Dictate: hold ${h[s.voice_key] || "the voice key"} anywhere, or click to start and stop`;
}

// ---------- wiring ----------
function wire() {
  $("#new-btn").onclick = newSessionDialog;
  $("#settings-btn").onclick = settingsDialog;
  $("#archived-btn").onclick = () => { state.showArchived = !state.showArchived; state.search = ""; renderSidebar(); };
  $("#search").onclick = openPalette;
  $("#palette-scrim").onclick = closePalette;
  $("#pal-q").oninput = () => { pal.sel = 0; renderPalette(); };
  $("#pal-q").onkeydown = e => {
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = pal.items.length || 1; pal.sel = (pal.sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n; markPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(pal.sel); }
    else if (e.key === "Escape") closePalette();
  };
  const pk = $("#peek");
  pk.querySelector("[data-peek=grow]").onclick = growPeek;
  pk.querySelector("[data-peek=close]").onclick = closePeek;
  pk.querySelector("[data-peek=open]").onclick = () => peek.ref && api().open_path(peek.sid, peek.ref, "file");
  pk.querySelector("[data-peek=panel]").onclick = async () => {  // keep it beside the chat
    const S = state.open.get(peek.sid);
    if (!S) return;
    if (peek.ref) {
      const it = await api().view_open(S.sid, peek.ref, true);
      closePeek(); await loadView(S); return openInView(S, it.path);
    }
    if (peek.src) {
      const it = { path: `mem:${Date.now()}`, src: peek.src, title: peek.label || "Picture", type: "image", from: "you" };
      (S.viewMem ||= []).push(it); closePeek(); await loadView(S); return openInView(S, it.path);
    }
  };
  wirePanelGrip();
  pk.onkeydown = e => {
    if (e.key === " ") { e.preventDefault(); e.stopPropagation(); growPeek(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePeek(); }
  };
  document.addEventListener("mousedown", e => { if (!pk.hidden && !pk.contains(e.target) && !e.target.closest("a.path, .tool .row, img, .att")) closePeek(); });
  // the header and the top of the sidebar are the title bar: drag to move, double-click to zoom
  document.querySelectorAll(".pywebview-drag-region").forEach(n => n.addEventListener("dblclick", e => { if (e.target === n) api().zoom(); }));
  // files dragged over the window: a drop zone; the drop itself is handled in Python, which knows the paths
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  document.addEventListener("dragenter", e => { if (!hasFiles(e)) return; dragDepth++; $("#dropzone").hidden = false; });
  document.addEventListener("dragleave", e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $("#dropzone").hidden = true; } });
  document.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", e => {
    dragDepth = 0;
    if (!hasFiles(e)) return;
    e.preventDefault();
    const names = [...e.dataTransfer.files].map(f => f.name);
    api().dropped(names).then(window.onDropped, () => { $("#dropzone").hidden = true; toast("Couldn't attach those files.", "error"); });
  });
  new ResizeObserver(() => document.documentElement.style.setProperty("--dock-h", $("#composer").offsetHeight + "px")).observe($("#composer"));
  window.addEventListener("resize", () => { glide($("#view-seg")); placePeek(); fitRunMenu(); if (state.panel) applyPanelW(); });
  $("#panel-btn").onclick = () => openPanelButton();
  document.querySelectorAll("#view-seg button").forEach(b => { b.title = `${VIEWS[b.dataset.v].text} (⌘D)`; b.onclick = () => setView(b.dataset.v); });
  $("#run-btn").onclick = e => { e.stopPropagation(); const m = $("#run-menu"); m.hidden = !m.hidden; if (!m.hidden) { renderRunMenu(); loadCtx(); } };
  $("#tools-btn").onclick = e => { e.stopPropagation(); const m = $("#tools-menu"); m.hidden = !m.hidden; if (!m.hidden) { renderToolsMenu(); api().marks_up().then(v => { state.marksUp = !!v; if (!m.hidden) renderToolsMenu(); }, () => {}); } };
  $("#mode-sel").onchange = e => { const S = state.open.get(state.active); if (S) setMode(S, e.target.value); };
  $("#fast-btn").onclick = () => {
    const S = state.open.get(state.active);
    if (!S) return;
    if (!S.fast && S.modes.fast === "off" && S.modes.fast_reason) toast(S.modes.fast_reason + ".");
    S.fast = !S.fast;
    api().set_fast(S.sid, S.fast);
    syncModes(S);
  };
  $("#panel-refresh").onclick = () => refreshRepo(true);
  document.querySelectorAll(".tab").forEach(t => t.onclick = () => { setTab(t.dataset.tab); togglePanel(true); });
  $("#send-btn").onclick = send;
  $("#stop-btn").onclick = () => api().interrupt(state.active);
  $("#mic-btn").onclick = () => api().mic(!state.dictating);
  $("#file-btn").onclick = attachFiles;
  $("#model-sel").onchange = $("#effort-sel").onchange = () => {
    const S = state.open.get(state.active);
    if (!S) return;
    const was = S.inner.lastElementChild?.classList.contains("switch") ? S.inner.lastElementChild : null;
    const from = was ? was.from : runLabel(S.model, S.effort);
    S.model = $("#model-sel").value; S.effort = $("#effort-sel").value;
    const to = runLabel(S.model, S.effort);
    const line = from === to ? `Back to ${to}` : `Switched to ${to} (was ${from})`;
    api().set_model(S.sid, S.model, S.effort, line, !!was);
    was?.remove();  // clicking through effort levels: one line, updated
    const n = add(S, switchLine(line));
    n.from = from;
    syncRun();
  };
  const input = $("#input");
  input.addEventListener("input", () => { autogrow(); updateSlash(); const S = state.open.get(state.active); if (S) syncComposer(S); });
  input.addEventListener("keydown", e => {
    const slash = !$("#slash").hidden;
    if (slash && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault(); const n = JSON.parse($("#slash").dataset.hits).length;
      slashSel = (slashSel + (e.key === "ArrowDown" ? 1 : n - 1)) % n; updateSlash(); return;
    }
    if (slash && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault(); pickSlash(JSON.parse($("#slash").dataset.hits)[slashSel]); return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const S = state.open.get(state.active);
      if (S) { const cur = $("#mode-sel").value; setMode(S, MODES[(MODES.indexOf(cur) + 1) % MODES.length]).then(() => toast($("#mode-sel").selectedOptions[0].textContent)); }
    }
  });
  input.addEventListener("paste", e => {
    const S = state.open.get(state.active);
    for (const item of e.clipboardData.items) {
      if (!item.type.startsWith("image/")) continue;
      e.preventDefault();
      const f = item.getAsFile(), rd = new FileReader();
      rd.onload = () => { S.attachments.push({ data: rd.result.split(",")[1], media_type: item.type, label: "pasted image" }); renderAttachments(); };
      rd.readAsDataURL(f);
    }
  });
  document.addEventListener("click", e => {
    const pa = e.target.closest("a.path");
    if (pa) {
      e.preventDefault();
      const kind = pa.dataset.kind, ref = (pa.dataset.abs || pa.dataset.path) + (pa.dataset.line ? `:${pa.dataset.line}` : "");
      if (kind !== "dir" && !e.metaKey && !e.altKey) return showPeek(pa, { ref, label: basename(pa.dataset.abs || pa.dataset.path) });
      api().open_path(state.active, ref, kind === "dir" ? "folder" : e.metaKey ? "folder" : e.altKey ? "editor" : "file").then(r => r.kind === "missing" && toast("Not found: " + r.path));
      return;
    }
    const a = e.target.closest("a[data-href]");
    if (a) { e.preventDefault(); api().open_url(a.dataset.href); return; }
    const c = e.target.closest("[data-copy]");
    if (c) { api().copy(c.closest(".code").querySelector("code").textContent); c.textContent = "copied"; setTimeout(() => c.textContent = "copy", 1200); return; }
    if (!e.target.closest("#ctx-menu")) $("#ctx-menu").hidden = true;
    if (!e.target.closest("#run-wrap, #run-menu")) $("#run-menu").hidden = true;
    if (!e.target.closest("#tools-wrap")) $("#tools-menu").hidden = true;
    if ($("#view-menu") && !e.target.closest("#view-menu")) $("#view-menu").hidden = true;
  });
  $("#modal").addEventListener("mousedown", e => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", e => {
    if (state.circling && (e.key === "Enter" || e.key === "Escape")) { e.preventDefault(); api().circle_key(e.key); return; }
    const S = state.open.get(state.active);
    if (e.metaKey && e.key === "n") { e.preventDefault(); newSessionDialog(); }
    else if (e.metaKey && e.key === "k") { e.preventDefault(); $("#palette").hidden ? openPalette() : closePalette(); }
    else if (e.metaKey && e.key === "\\") { e.preventDefault(); openPanelButton(); }
    else if (e.metaKey && e.key === "d") { e.preventDefault(); setView({ full: "thinking", thinking: "chat", chat: "full" }[state.view] || "full"); }
    else if (e.metaKey && e.key === "i") { e.preventDefault(); (state.panel && state.tab === "stats") ? togglePanel(false) : togglePanel(true, "stats"); }
    else if (e.metaKey && e.key === "j") { e.preventDefault(); if (state.active) (state.panel && state.tab === "view") ? togglePanel(false) : togglePanel(true, "view"); }
    else if (e.metaKey && e.key === "w") { e.preventDefault(); closeActive(); }
    else if (e.metaKey && e.key === "r") { e.preventDefault(); if (state.active) reloadSession(state.active); }
    else if (e.metaKey && e.key === ",") { e.preventDefault(); settingsDialog(); }
    else if (e.metaKey && (e.key === "=" || e.key === "+")) { e.preventDefault(); stepText(1); }
    else if (e.metaKey && (e.key === "-" || e.key === "_")) { e.preventDefault(); stepText(-1); }
    else if (e.metaKey && e.key === "0") { e.preventDefault(); stepText(0); }
    else if (e.metaKey && /^[1-9]$/.test(e.key)) {
      const list = [...state.open.values()].sort((a, b) => b.lastActive - a.lastActive);
      if (list[+e.key - 1]) { e.preventDefault(); activate(list[+e.key - 1].sid); }
    }
    else if (S && S.perms.size && e.metaKey && (e.key === "Enter" || e.key === "Backspace")) {
      e.preventDefault(); const rid = [...S.perms.keys()][0]; answer(S, rid, e.key === "Enter" ? "allow" : "deny");
    }
    else if (e.key === "Escape") {
      if (closePeek() || closePalette()) return;
      if ($("#view-menu") && !$("#view-menu").hidden) { $("#view-menu").hidden = true; return; }
      if (closeNoteBox()) return;
      if (S?.commenting && state.panel && state.tab === "view") return setCommenting(S, false);
      if (document.body.classList.contains("view-full")) { document.body.classList.remove("view-full"); applyPanelW(); renderPanel(); return; }
      if (!$("#run-menu").hidden) $("#run-menu").hidden = true;
      else if (!$("#tools-menu").hidden) $("#tools-menu").hidden = true;
      else if (!$("#ctx-menu").hidden) $("#ctx-menu").hidden = true;
      else if (!$("#modal").hidden) closeModal();
      else if (!$("#slash").hidden) hideSlash();
      else if (S && (S.status === "running" || S.status === "waiting")) api().interrupt(S.sid);
    }
  });
  setInterval(() => { if (state.active && document.hasFocus()) refreshRepo(); }, 60000);
  setInterval(() => { if (document.hasFocus()) loadHistory(); }, 120000);
}

// ---------- updates: a glowing icon in the sidebar when GitHub has a newer Tether ----------
const upd = { info: null, waiting: false, timer: 0 };
async function checkUpdate(force = false) {
  const r = await api().update_status(force).catch(() => null);
  if (r && r.ok) upd.info = r;
  const b = $("#update-btn");
  b.hidden = !(upd.info?.behind > 0);
  b.classList.toggle("wait", upd.waiting);
  b.title = b.ariaLabel = upd.waiting ? "Updating when chats finish" : "Update available";
}
function updateDialog() {
  const i = upd.info || {};
  const list = (i.changes || []).map(c => `<li>${esc(c)}</li>`).join("") + (i.more ? `<li>and ${i.more} more</li>` : "");
  if (i.dirty || i.ahead) {
    const box = openModal(`<h2>Update Tether</h2><p class="modal-p">Tether's own files were changed on this Mac, so it can't update by itself.</p>
      <div class="modal-acts"><button class="btn primary" data-k="ok">OK</button></div>`);
    box.querySelector("[data-k]").onclick = closeModal;
    return;
  }
  const box = openModal(`<h2>Update Tether</h2>${list ? `<ul class="upd-list">${list}</ul>` : ""}<p class="modal-p" id="upd-p">Tether restarts to finish. Open chats come back.</p>
    <div class="modal-acts"><button class="btn ghost" data-k="no">${upd.waiting ? "Don't update" : "Cancel"}</button><button class="btn primary" data-k="yes" id="upd-go">Update and restart</button></div>`);
  api().update_busy().then(n => {
    if (!n) return;
    $("#upd-p").textContent = `${n === 1 ? "A chat is" : n + " chats are"} still working. Tether updates when ${n === 1 ? "it finishes" : "they finish"}, then restarts. Open chats come back.`;
    $("#upd-go").textContent = upd.waiting ? "Keep waiting" : `Update when ${n === 1 ? "it finishes" : "they finish"}`;
  });
  box.querySelector('[data-k="no"]').onclick = () => { if (upd.waiting) stopWaiting(); closeModal(); };
  box.querySelector('[data-k="yes"]').onclick = () => { closeModal(); runUpdate(); };
}
function stopWaiting() { upd.waiting = false; clearTimeout(upd.timer); checkUpdate(); }
async function runUpdate() {
  const chats = [...state.open.values()].filter(S => S.status !== "new").map(S => ({ sid: S.sid, cwd: S.cwd, title: S.title || "" }));
  const r = await api().update_now(chats, state.active || "");
  if (r.busy) {  // try again until every chat is done
    upd.waiting = true; checkUpdate();
    clearTimeout(upd.timer); upd.timer = setTimeout(() => upd.waiting && runUpdate(), 3000);
    return;
  }
  upd.waiting = false;
  if (r.error) { checkUpdate(true); return toast(r.error, "error"); }
  toast("Updating Tether…");
}
async function reopenAfterUpdate() {
  const r = await api().take_reopen();
  for (const c of r.chats || []) await openSession(c.sid, c.cwd, c.title).catch(() => {});
  if (r.active && state.open.has(r.active)) activate(r.active);
  if (r.chats?.length) renderSidebar();
}

window.addEventListener("pywebviewready", async () => {
  const r = await api().ready();
  state.settings = r.settings; state.hotkeys = r.hotkeys; state.home = r.home;
  wire();
  applyTheme(r.settings.theme);
  applyText(r.settings.text_size, r.settings.bold_accent);
  setView(r.settings.view || "full", false);
  showKeys();
  await loadHistory();
  fillModels();
  reopenAfterUpdate();
  $("#update-btn").onclick = updateDialog;
  setTimeout(checkUpdate, 15000);  // GitHub is asked at most every 6 hours; this only reads the answer
  setInterval(checkUpdate, 3600 * 1000);
});
document.addEventListener("mousedown", e => { const p = $("#jobs-pop"); if (p && !p.hidden && !e.target.closest("#jobs-wrap")) p.hidden = true; });
