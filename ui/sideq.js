// Side question (/btw, ⌘/ or the message box button): ask about this chat in a popout that grows out of the
// message box. A throwaway copy of the chat answers (side_ask in workbench.py); nothing goes into the chat unless
// you press Ask in chat. Minimize (or Esc) tucks it into a tab on the box; each chat keeps its own.
window.SideQ = (() => {
  const IC = {
    aside: `<svg viewBox="0 0 24 24"><path d="M5 5h14v10H10l-4 4v-4H5z"/><path d="M9 9.5h6M9 12h3.5"/></svg>`,
    min: `<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>`,
    x: `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
    up: `<svg viewBox="0 0 24 24"><path d="M7 14l5-5 5 5"/></svg>`,
    copy: `<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/></svg>`,
    chat: `<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
  };
  const $ = id => document.getElementById(id);
  const st = S => (S.sq ||= { mode: "none", items: [], ready: false });
  const front = S => S && S.sid === state.active;
  let qn = 0, waitT = null, shownFor = null;

  function build() {
    const w = $("sq-wrap");
    w.innerHTML = `<div class="sq-w" id="sq-w" hidden><span class="sq-fil l"></span><span class="sq-fil r"></span>
      <div class="sq-pop" id="sq-pop"><button class="sq-tab" id="sq-tab"></button>
        <div class="sq-pc" id="sq-pc">
          <div class="sq-sweep" id="sq-sweep" hidden></div>
          <div class="sq-h"><span class="sq-tag">${IC.aside}Side question</span>
            <button class="sq-ib" data-a="min" title="Minimize (Esc)">${IC.min}</button><button class="sq-ib" data-a="close" title="Close">${IC.x}</button></div>
          <div class="sq-list" id="sq-list"></div>
          <div class="sq-field"><textarea id="sq-in" rows="1" placeholder="Ask about this chat" spellcheck="true"></textarea><span class="kbd">↵</span></div>
          <div class="sq-ft" id="sq-ft"></div>
        </div></div></div>`;
    $("sq-tab").onclick = () => open(cur());
    $("sq-pc").addEventListener("click", e => {
      const b = e.target.closest("[data-a]"); if (!b) return;
      const S = cur(); if (!S) return;
      ({ min: () => minimize(S), close: () => close(S), copy: () => copyLast(S, b), chat: () => askInChat(S) })[b.dataset.a]?.();
    });
    const i = $("sq-in");
    i.addEventListener("input", () => { i.style.height = "auto"; i.style.height = Math.min(i.scrollHeight, 120) + "px"; fit(); });
    i.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); const S = cur(); if (S && i.value.trim()) submit(S, i.value.trim()); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); const S = cur(); if (S) minimize(S); }
    });
    $("sq-list").addEventListener("scroll", () => { const l = $("sq-list"); l.dataset.stick = l.scrollHeight - l.scrollTop - l.clientHeight < 8 ? "1" : ""; });
  }
  const cur = () => state.open.get(state.active);

  // ----- drawing -----
  const waiting = q => q && !q.done;
  function listHTML(q) {
    if (!q.items.length) return "";
    const last = q.items[q.items.length - 1];
    return q.items.slice(0, -1).map((it, k) => `<div class="sq-old" data-k="${k}"><span class="q"></span></div>`).join("") +
      `<div class="sq-q"></div>` + (waiting(last) && !last.a
        ? `<div class="sq-reading"><i></i>Reading this chat · <span id="sq-secs">${Math.round((Date.now() - last.t0) / 1000)}s</span></div><div class="sq-ghost" style="width:92%"></div><div class="sq-ghost" style="width:62%"></div>`
        : `<div class="sq-a msg-text${last.anim ? " in" : ""}"></div>`);
  }
  function drawList(S) {
    const q = st(S), l = $("sq-list"), last = q.items[q.items.length - 1];
    const stick = l.dataset.stick !== "" || !l.childElementCount;
    l.innerHTML = listHTML(q);
    l.hidden = !q.items.length;
    l.querySelectorAll(".sq-old").forEach(n => { const it = q.items[+n.dataset.k]; n.querySelector(".q").textContent = it.q; n.title = "Show this answer";
      n.onclick = () => { q.items.push(...q.items.splice(+n.dataset.k, 1)); drawAll(S); }; });
    if (last) {
      l.querySelector(".sq-q").textContent = last.q;
      const a = l.querySelector(".sq-a");
      if (a) { if (last.err) { a.classList.add("err"); a.textContent = last.err; } else window.renderMarkdown(a, last.a || ""); last.anim = false; }
    }
    $("sq-sweep").hidden = !waiting(last);
    $("sq-in").placeholder = q.items.length ? "Ask another" : "Ask about this chat";
    const answered = last && last.done && !last.err && last.a;
    $("sq-ft").innerHTML = (answered ? `<button class="sq-act" data-a="copy">${IC.copy}<span>Copy</span></button><button class="sq-act" data-a="chat" title="Send this question to the chat as a normal message">${IC.chat}<span>Ask in chat</span></button>` : "");
    if (stick) l.scrollTop = l.scrollHeight;
    clearInterval(waitT);
    if (waiting(last)) waitT = setInterval(() => { const e = $("sq-secs"); if (e) e.textContent = Math.round((Date.now() - last.t0) / 1000) + "s"; else clearInterval(waitT); }, 500);
  }
  function tabHTML(q) {
    const last = q.items[q.items.length - 1];
    if (waiting(last)) return `<span class="rd wait"></span>Reading this chat`;
    if (q.ready) return `<span class="rd"></span>Answer ready${IC.up}`;
    return `<span class="ico">${IC.aside}</span>Side question${IC.up}`;
  }
  // keep the popout and its curved joins clear of the box's rounded corners (.sq-w sits 36px from the right)
  const popW = () => { const b = document.querySelector("#composer .composer-box"); return Math.max(200, Math.min(400, (b?.clientWidth || 600) - 72)); };
  // size the popout for its state; CSS transitions do the motion
  function fit(instant) {
    const S = cur(); if (!S) return;
    const q = st(S), w = $("sq-w"), pop = $("sq-pop"), pc = $("sq-pc"), tab = $("sq-tab");
    const W = popW();
    pc.style.width = W + "px";
    pc.classList.toggle("narrow", W < 340);
    if (instant) pop.classList.add("sq-still");
    let size;
    if (q.mode === "open") size = [W, pc.offsetHeight];
    else if (q.mode === "tab") size = [tab.offsetWidth, 30];
    else size = [Math.min(W, 150), 0];
    pop.style.width = size[0] + "px"; pop.style.height = size[1] + "px";
    pop.classList.toggle("is-open", q.mode === "open"); pop.classList.toggle("is-tab", q.mode === "tab");
    pop.classList.toggle("ready", q.mode === "tab" && q.ready);
    w.classList.toggle("gone", q.mode === "none");
    $("composer").classList.toggle("sq-on", q.mode !== "none");
    if (instant) { pop.offsetWidth; pop.classList.remove("sq-still"); }
  }
  function drawAll(S, instant) {
    if (!front(S)) return;
    const q = st(S), w = $("sq-w");
    if (q.mode === "none" && w.hidden) return;
    w.hidden = false;
    $("sq-tab").innerHTML = tabHTML(q);
    drawList(S);
    fit(instant);
  }
  let redrawT = null;  // a timer, not a frame callback: those pause while Tether is behind other windows
  const redraw = S => { if (redrawT) return; redrawT = setTimeout(() => { redrawT = null; if (front(S)) drawAll(S); }, 30); };

  // ----- actions -----
  function open(S, focus = true) {
    if (!S) return;
    const q = st(S);
    if (q.mode !== "open") { q.mode = "open"; q.ready = false; drawAll(S); renderSidebar(); }
    if (focus) setTimeout(() => $("sq-in").focus({ preventScroll: true }), 60);
  }
  function minimize(S) {
    const q = st(S);
    if (q.mode !== "open") return;
    if (!q.items.length) return close(S);
    q.mode = "tab"; drawAll(S);
    $("input").focus({ preventScroll: true });
  }
  function close(S) {
    const q = st(S);
    q.mode = "none"; q.items = []; q.ready = false;
    api().side_close(S.sid);
    drawAll(S); renderSidebar();
    setTimeout(() => { if (st(S).mode === "none" && front(S)) $("sq-w").hidden = true; }, 450);
    $("input").focus({ preventScroll: true });
  }
  function toggle(S) { if (!S) return; st(S).mode === "open" ? minimize(S) : open(S); }
  async function submit(S, text) {
    const q = st(S), last = q.items[q.items.length - 1];
    if (waiting(last)) return toast("Still answering the last side question.");
    const it = { qid: `q${++qn}`, q: text, a: "", done: false, t0: Date.now() };
    const earlier = q.items.filter(x => x.done && !x.err && x.a).map(x => ({ q: x.q, a: x.a }));
    q.items.push(it);
    $("sq-in").value = ""; $("sq-in").style.height = "";
    $("sq-list").dataset.stick = "1";
    drawAll(S);
    const r = await api().side_ask(S.sid, it.qid, text, earlier);
    if (r && r.error) { it.done = true; it.err = r.error; redraw(S); }
  }
  function ask(S, text) { open(S); if (text) submit(S, text); }
  function copyLast(S, b) {
    const last = st(S).items.slice(-1)[0]; if (!last?.a) return;
    api().copy(last.a);
    const t = b.querySelector("span"); if (t) { t.textContent = "Copied"; setTimeout(() => t.textContent = "Copy", 1200); }
  }
  function askInChat(S) {
    const last = st(S).items.slice(-1)[0]; if (!last) return;
    $("input").value = last.q; autogrow();
    minimize(S);
    send();
  }
  function onEvent(S, ev) {
    const q = st(S), it = q.items.find(x => x.qid === ev.qid);
    if (!it) return;
    if (ev.kind === "delta") { if (!it.a) it.anim = true; it.a += ev.text || ""; }
    else if (ev.kind === "done") { it.done = true; if (!ev.ok && !it.a) it.err = ev.error || "The side question didn't finish."; if (q.mode === "tab") q.ready = true; else if (q.mode === "open" && !front(S)) q.ready = true; }
    else if (ev.kind === "error") { it.done = true; if (!it.a) it.err = ev.text || "The side question stopped."; if (q.mode !== "none") q.ready = q.mode === "tab"; }
    if (ev.kind !== "delta") renderSidebar();
    if (front(S)) redraw(S);
  }
  // another chat came to the front: show its own popout as it was, without motion
  function show(S) {
    if (!$("sq-w")) build();
    const w = $("sq-w");
    if (!S) { w.hidden = true; $("composer").classList.remove("sq-on"); return; }
    const q = st(S);
    if (shownFor !== S.sid && q.mode === "open" && q.ready) q.ready = false;
    shownFor = S.sid;
    if (q.mode === "none") { w.hidden = true; $("composer").classList.remove("sq-on"); clearInterval(waitT); return; }
    w.hidden = false;
    drawAll(S, true);
  }
  window.addEventListener("resize", () => { const S = cur(); if (S && st(S).mode !== "none") fit(true); });
  return { show, toggle, ask, onEvent, open, minimize, close, IC };
})();
