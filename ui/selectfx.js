// Text highlight (Settings › Appearance › Text highlight). Selected text in the chat, side panel, previews and dialogs
// gets Tether's own highlight: one rounded box per line, a little gap between lines, in the accent color (--hl-c at
// --hl-a). The Mac's selection stays underneath for copying, just transparent (html.hl-hide).
// The boxes are plain divs in a layer inside the scroll area (.hl-layer), so they scroll with the text and moving one is
// cheap: no picture is rebuilt and nothing behind is repainted. They sit over the text and blend with it (screen on
// light text, multiply on dark), so the letters keep their own color and the tint shows only around them.
// On mouse selections an effect plays (CSS animations in app.css, except Liquid):
//   glow    as you let go, the selection flashes brighter with a soft halo, then settles
//   liquid  while you drag, the boxes glide after the pointer instead of jumping
//   marker  as you let go, the color paints across each line from the left, one line after another
// The message box and other fields keep the Mac's own highlight. Very large selections do too.
(() => {
  const ZONES = "#chats, #panel-body, #peek, .modal-box";
  const HOSTS = ".chat, #panel-body, .peek-b, .sheet-pages, .modal-box, #peek";  // where a layer goes: the nearest of these
  const FIXED = "button, .seg, .thinking summary, .perm .acts, .tool .row, .rp-merged > summary";  // can't be selected
  const MAX_NODES = 4000, MAX_LINES = 600;
  const PADX = 2, PADY = 1.5;  // box padding around the letters
  const root = document.documentElement;
  const layers = new Map();  // host -> { el, pos: its own inline position, put back when the layer goes }
  let about = new WeakMap();  // element -> what lines() needs from its style; dropped when the selection ends
  let drag = null, raf = 0, cur = null, shown = [], sig = "", fxEnd = 0, pending = 0;

  const mode = () => {
    const m = state.settings?.select_anim ?? "glow";
    return matchMedia("(prefers-reduced-motion: reduce)").matches || !["glow", "liquid", "marker"].includes(m) ? "" : m;
  };
  const field = n => !!n?.closest?.("textarea, input, [contenteditable]");
  const sel = () => {
    const s = getSelection();
    if (!s.rangeCount || s.isCollapsed) return null;
    const r = s.getRangeAt(0), el = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
    return el?.closest(ZONES) && !field(el) && !field(r.startContainer.childNodes?.[r.startOffset]) ? r : null;  // a text box's own selection isn't drawn
  };
  const key = r => r ? [r.startOffset, r.endOffset, r.toString().length].join(":") : "";

  // The selected text as pieces of text nodes, in reading order.
  function pieces(range) {
    const out = [], c = range.commonAncestorContainer;
    const add = (n, s, e) => { if (e > s && !n.parentElement?.closest(FIXED)) out.push({ n, s, e }); };
    if (c.nodeType === 3) add(c, range.startOffset, range.endOffset);
    else {
      const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      let n = range.startContainer;
      if (n.nodeType !== 3) { const k = n.childNodes[range.startOffset]; w.currentNode = k || n; n = k?.nodeType === 3 ? k : w.nextNode(); }
      else w.currentNode = n;
      for (let seen = 0; n; n = w.nextNode()) {
        if (!range.intersectsNode(n)) { if (out.length) break; continue; }
        if (++seen > MAX_NODES) return null;
        add(n, n === range.startContainer ? range.startOffset : 0, n === range.endContainer ? range.endOffset : n.data.length);
      }
    }
    return out;
  }

  const lum = c => { const v = (c.match(/[\d.]+/g) || [0, 0, 0]).map(Number); return (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255; };
  function look(el) {
    let a = about.get(el);
    if (!a) {
      const cs = getComputedStyle(el);
      a = { host: el.matches(HOSTS), clips: cs.display !== "inline" && (cs.overflowX !== "visible" || cs.overflowY !== "visible"), light: lum(cs.color) > 0.5 };
      about.set(el, a);
    }
    return a;
  }
  // Which layer a piece goes in, and the visible part of any scroll box between it and that layer (a wide code block).
  function where(el, memo) {
    if (memo.has(el)) return memo.get(el);
    const a = look(el);
    let w = null;
    if (a.host) w = { host: el, clip: null, cut: el };
    else if (el.parentElement && el !== document.body) {
      const up = where(el.parentElement, memo);
      if (up && a.clips) {
        const r = el.getBoundingClientRect(), l = r.left + el.clientLeft, t = r.top + el.clientTop;
        let c = { l, t, r: l + el.clientWidth, b: t + el.clientHeight };
        if (up.clip) c = { l: Math.max(c.l, up.clip.l), t: Math.max(c.t, up.clip.t), r: Math.min(c.r, up.clip.r), b: Math.min(c.b, up.clip.b) };
        w = { host: up.host, clip: c, cut: el };
      } else w = up;
    }
    memo.set(el, w);
    return w;
  }

  // One box per line, in the layer's own coordinates (so they scroll with it), in reading order.
  function lines(range) {
    const ps = pieces(range);
    if (!ps) return null;
    const memo = new Map(), groups = new Map(), sub = document.createRange();
    for (const p of ps) {
      const el = p.n.parentElement, w = el && where(el, memo);
      if (!w) continue;
      sub.setStart(p.n, p.s); sub.setEnd(p.n, p.e);
      const rs = [...sub.getClientRects()].filter(q => q.width >= 1 && q.height >= 1);
      if (!rs.length) continue;
      if (!groups.has(w.cut)) groups.set(w.cut, { w, rs: [], light: look(el).light });
      groups.get(w.cut).rs.push(...rs);
    }
    const out = [];
    for (const { w, rs, light } of groups.values()) {
      rs.sort((a, b) => a.top - b.top);
      const rows = [], merged = [];
      for (const q of rs) {  // group into lines first: a code span sits a little lower than the words around it
        const row = rows.find(x => Math.abs(x.t - q.top) < 5 || (q.top < x.b - 4 && q.bottom > x.t + 4));
        if (row) { row.q.push(q); row.b = Math.max(row.b, q.bottom); } else rows.push({ t: q.top, b: q.bottom, q: [q] });
      }
      for (const row of rows) {  // then pieces on a line that touch become one box
        row.q.sort((a, b) => a.left - b.left);
        let m = null;
        for (const q of row.q) {
          if (m && q.left - m.r < 8) { m.r = Math.max(m.r, q.right); m.t = Math.min(m.t, q.top); m.b = Math.max(m.b, q.bottom); }
          else merged.push(m = { l: q.left, r: q.right, t: q.top, b: q.bottom });
        }
      }
      const ls = merged.map(m => ({ x: m.l - PADX, y: m.t - PADY, w: m.r - m.l + 2 * PADX, h: m.b - m.t + 2 * PADY, ct: m.t, cl: m.l }));
      ls.sort((a, b) => a.y - b.y || a.x - b.x);
      for (let i = 1; i < ls.length; i++) {  // keep a gap between a line and the one above it
        const p = ls[i - 1], q = ls[i];
        if (q.y < p.y + p.h + 2 && q.y > p.y + 2 && q.x < p.x + p.w && p.x < q.x + q.w) {
          const mid = (p.y + p.h + q.y) / 2;
          p.h = Math.max(mid - 1 - p.y, 4); q.h -= mid + 1 - q.y; q.y = mid + 1;
        }
      }
      const h = w.host, hb = h.getBoundingClientRect(), dx = hb.left + h.clientLeft - h.scrollLeft, dy = hb.top + h.clientTop - h.scrollTop;
      for (const l of ls) {
        if (w.clip) {  // cut to what the scroll box shows
          const c = w.clip, x2 = Math.min(l.x + l.w, c.r), y2 = Math.min(l.y + l.h, c.b);
          l.x = Math.max(l.x, c.l); l.y = Math.max(l.y, c.t); l.w = x2 - l.x; l.h = y2 - l.y;
          if (l.w < 1 || l.h < 1) continue;
        }
        out.push({ host: h, light, x: l.x - dx, y: l.y - dy, w: l.w, h: l.h, ct: l.ct, cl: l.cl });
      }
    }
    if (out.length > MAX_LINES) return null;
    return out.sort((a, b) => a.ct - b.ct || a.cl - b.cl);
  }

  function layer(h) {
    let L = layers.get(h);
    if (L && !L.el.isConnected) { drop(h); L = null; }  // the area was redrawn
    if (!L) {
      const el = document.createElement("div");
      el.className = "hl-layer";
      const pos = getComputedStyle(h).position === "static" ? h.style.position : null;  // the layer needs a positioned box to sit in
      if (pos !== null) h.style.position = "relative";
      h.appendChild(el);
      layers.set(h, L = { el, pos });
    }
    return L;
  }
  function drop(h) {
    const L = layers.get(h);
    if (!L) return;
    L.el.remove();
    if (L.pos !== null) h.style.position = L.pos;
    layers.delete(h);
  }
  // Put the boxes in place; l.d is a box's start delay for Highlighter.
  function draw(ls) {
    const by = new Map();
    for (const l of ls) { if (!by.has(l.host)) by.set(l.host, []); by.get(l.host).push(l); }
    for (const h of [...layers.keys()]) if (!by.has(h)) drop(h);
    for (const [h, group] of by) {
      const box = layer(h).el, kids = box.children;
      while (kids.length < group.length) box.appendChild(document.createElement("div")).className = "hl-box";
      while (kids.length > group.length) box.lastChild.remove();
      group.forEach((l, i) => {
        const b = kids[i], s = b.style;
        s.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px)`;
        s.width = `${Math.max(l.w, 0).toFixed(1)}px`; s.height = `${l.h.toFixed(1)}px`;
        if (b.classList.contains("ink") === l.light) b.classList.toggle("ink");  // dark text: multiply, so it stays dark
        s.setProperty("--d", `${l.d || 0}ms`);
      });
    }
  }

  function stopFx() {
    clearTimeout(fxEnd); fxEnd = 0;
    root.classList.remove("hl-fx-glow", "hl-fx-marker");
  }
  function clear() {  // back to the Mac's own highlight (or none)
    cancelAnimationFrame(raf); raf = 0; cur = null; shown = []; sig = "";
    stopFx();
    for (const h of [...layers.keys()]) drop(h);
    root.classList.remove("hl-hide");
    about = new WeakMap();
    ro.disconnect();
  }
  function settle() {  // the selection as it is now
    const r = sel(), ls = r && lines(r);
    if (!ls?.length) { clear(); return; }
    const k = key(r);
    if (cur && cur.key !== k) stopFx();
    cur = { key: k, lines: ls };
    if (raf) return;  // Liquid is gliding toward it
    const s = ls.map(l => [l.x, l.y, l.w, l.h].map(Math.round).join(",")).join(";");
    if (s === sig && root.classList.contains("hl-hide")) return;  // nothing moved
    sig = s; shown = ls;
    draw(ls);
    root.classList.add("hl-hide");
    watch();
  }
  function play(fx) {  // restart the CSS animation on the boxes now drawn
    stopFx();
    let total = 750;
    if (fx === "marker") { cur.lines.forEach((l, i) => { l.d = Math.min(i * 70, 420); }); draw(cur.lines); total = 340 + Math.min((cur.lines.length - 1) * 70, 420); }
    void root.offsetWidth;
    root.classList.add(`hl-fx-${fx}`);
    fxEnd = setTimeout(stopFx, total);
  }

  // Liquid: each drawn box chases the box it should be; new lines grow from their left edge, dropped ones shrink away.
  function liquid() {
    const r = sel(), ls = r && lines(r);
    if (!ls?.length) { clear(); return; }
    cur = { key: key(r), lines: ls };
    root.classList.add("hl-hide");
    sig = "";
    if (raf) return;
    let last = performance.now();
    const tick = now => {
      raf = 0;
      const k = 1 - Math.exp(-Math.min(now - last, 50) / 45);
      last = now;
      const used = new Set(), next = [];
      let moving = false;
      for (const g of cur.lines) {
        let s = shown.find(s => !used.has(s) && s.host === g.host && Math.abs(s.y - g.y) < g.h / 2);
        if (!s) s = { x: g.x, y: g.y, w: 0, h: g.h };
        used.add(s);
        const d = { host: g.host, light: g.light, ct: g.ct, cl: g.cl };
        for (const p of ["x", "y", "w", "h"]) { d[p] = s[p] + (g[p] - s[p]) * k; if (Math.abs(g[p] - d[p]) < 0.4) d[p] = g[p]; else moving = true; }
        next.push(d);
      }
      for (const s of shown) if (!used.has(s) && s.w > 1 && s.host.isConnected) { next.push({ ...s, w: s.w * (1 - k) }); moving = true; }
      shown = next;
      draw(shown);
      watch();
      if (moving) raf = requestAnimationFrame(tick);
      else if (drag === null) { sig = ""; settle(); }  // arrived after you let go: hand over
    };
    raf = requestAnimationFrame(tick);
  }

  // Text moving under the boxes (a reply arriving, a row opening, a resize, a code block scrolled sideways): draw again
  // on the next frame.
  const later = () => { if (cur && !pending) pending = requestAnimationFrame(() => { pending = 0; if (cur) settle(); }); };
  const ro = new ResizeObserver(later);
  function watch() {
    ro.disconnect();
    for (const h of layers.keys()) { ro.observe(h); for (const c of h.children) if (!c.classList.contains("hl-layer")) ro.observe(c); }
  }
  const ours = r => (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest(".hl-layer")
    || (r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every(n => n.classList?.contains("hl-layer")));
  const mo = new MutationObserver(rs => { if (!rs.every(ours)) later(); });
  document.querySelectorAll("#chats, #panel-body").forEach(z => mo.observe(z, { childList: true, subtree: true, characterData: true }));
  addEventListener("resize", later);
  addEventListener("scroll", e => { if (cur && !layers.has(e.target)) later(); }, true);  // a layer's own area scrolls the boxes with it

  let queued = 0;
  document.addEventListener("selectionchange", () => {
    if (queued) return;
    queued = requestAnimationFrame(() => {  // at most once a frame
      queued = 0;
      if (drag !== null && mode() === "liquid") liquid();
      else settle();
    });
  });
  document.addEventListener("mousedown", e => {
    drag = e.button === 0 && mode() && !field(e.target) && e.target.closest?.(ZONES) ? key(sel()) || "-" : null;
    if (drag !== null) about = new WeakMap();
  }, true);
  document.addEventListener("mouseup", () => {
    if (drag === null) return;
    const before = drag, m = mode();
    drag = null;
    requestAnimationFrame(() => requestAnimationFrame(() => {  // after the last selectionchange has drawn
      if (m === "liquid") { if (!raf) settle(); return; }  // otherwise the glide hands over once it arrives
      const r = sel();
      if (!r || key(r) === before) return;
      settle();
      if (cur && root.classList.contains("hl-hide")) play(m);
    }));
  }, true);
  addEventListener("blur", () => { drag = null; });
})();
