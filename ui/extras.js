// Tether extras: answer buttons under a reply that asks something, Waiting on you (one list across chats),
// two chats side by side, Pick on the Shelf, and Restart when idle. app.js calls in through a few hooks.
const Extras = (() => {
  const going = S => ["running", "starting", "waiting"].includes(S.status);
  const IC = {
    yes: `<svg class="i" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
    no: `<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
    pen: `<svg class="i" viewBox="0 0 24 24"><path d="M4 20l1-4L16.5 4.5l3 3L8 19z"/></svg>`,
    open: `<svg class="i" viewBox="0 0 24 24"><path d="M9 6h9v9M18 6 7 17"/></svg>`,
    split: `<svg class="i" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M12 5v14"/></svg>`,
    one: `<svg class="i" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/></svg>`,
    send: `<svg class="i" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
    restart: `<svg class="i" viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.2-5.1M19 4v4h-4"/></svg>`,
  };
  let ready = false;

  // Send `text` to a chat as if you had typed it there, whether or not it's the chat in front.
  // A fresh start moves a chat to a new session; buttons drawn before it still hold the old one, so follow the move.
  function current(S) {
    for (let i = 0; S && i < 20 && state.moved?.[S.sid] && state.open.has(state.moved[S.sid]); i++) S = state.open.get(state.moved[S.sid]);
    return S;
  }
  async function quickSend(S, text) {
    S = current(S);
    if (!S || !text) return;
    S.unseen = false;  // you answered it, so you've seen it
    if (going(S)) { holdMessage(S, text, []); renderSidebar(); return; }
    const choice = await checkElsewhere(S);
    if (choice === "cancel") return;
    if (choice === "reload") await reloadSession(S.sid);
    S.lastActive = Date.now() / 1000;
    const m = addUser(S, text, [], false);
    (S.pending ||= []).push({ text, el: m });
    const r = await api().send(S.sid, text, []);
    if (r && r.error) add(S, errRow(S, r.error));
    renderSidebar();
  }

  // ---------- answer buttons ----------
  // Claude ends a reply that asks something with "<answers>Yes, push | No</answers>" (asked for in engine.APP_PROMPT).
  // The line is hidden (markdown.js) and its answers become buttons under the reply; your next message removes them.
  const ANS_RE = /<answers>([\s\S]*?)<\/answers>\s*$/;
  const plain = t => (t || "").replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  function parseAsk(src) {
    src = (src || "").trimEnd();
    const m = ANS_RE.exec(src);
    const answers = m ? m[1].split("|").map(x => x.trim()).filter(Boolean).slice(0, 6) : [];
    let q = plain(window.stripAnswers(src).trimEnd().split(/\n\s*\n/).pop());
    if (!answers.length && !/\?["”')\]]*$/.test(q)) return null;
    if (q.length > 280) q = "…" + q.slice(-280);
    return { q, answers, at: Date.now() };
  }
  const lastReply = S => [...S.inner.querySelectorAll(":scope > .msg-text")].pop();
  function clearAnswers(S) { S.inner.querySelectorAll(":scope > .answers").forEach(n => n.remove()); }
  function answerButton(label, primary, small) {
    const m = /^(\d{1,2}|[A-Z])[.:)]?\s+(.+)$/.exec(label);
    const icon = m ? "" : /^(yes|ok|go|push|build|do it|allow|run|deploy|send|ship)\b/i.test(label) ? IC.yes : /^(no|don'?t|cancel|skip|not |stop|leave|deny)\b/i.test(label) ? IC.no : "";
    const b = el("button", "btn ans" + (small ? " small" : "") + (primary ? " primary" : ""), icon + (m ? `<span class="n">${esc(m[1])}</span><span>${esc(m[2])}</span>` : `<span>${esc(label)}</span>`));
    return b;
  }
  function drawAnswers(S) {
    clearAnswers(S);
    if (!S.ask?.answers.length) return;
    const row = el("div", "answers");
    S.ask.answers.forEach((a, i) => { const b = answerButton(a, i === 0); b.onclick = () => quickSend(S, a); row.appendChild(b); });
    const o = el("button", "btn ans ghost", IC.pen + "<span>Other answer</span>");
    o.onclick = () => { const C = current(S); if (C && C.sid !== state.active) activate(C.sid); $("#input").focus(); };
    row.appendChild(o);
    add(S, row);
  }
  function turnEnd(S, ev) {
    clearAnswers(S); S.ask = null;
    S.doneAt = Date.now();
    const src = lastReply(S)?._c?.src || "";
    S.lastSaid = plain(window.stripAnswers(src).trimEnd().split(/\n\s*\n/).pop()).slice(0, 280);
    if (ev && ev.ok === false) return sync();
    if (S.held?.length) return sync();  // a queued message of yours goes next
    S.ask = parseAsk(src);
    if (S.ask && (S.sid === state.active || split.has(S.sid))) S.ask.seen = true;  // it came in while you were looking
    drawAnswers(S);
    sync();
  }
  function userSpoke(S) { if (!S.ask && !S.inner.querySelector(":scope > .answers")) return; S.ask = null; clearAnswers(S); if (!S.replaying) sync(); }
  function carryAsk(old, N) {  // a fresh start: the question still stands in the new session, buttons redrawn for it
    if (!old?.ask) return;
    N.ask = old.ask; drawAnswers(N);
  }
  function fromHistory(S) {  // a saved chat whose last word was a question: its buttons come back
    const kids = [...S.inner.children].filter(n => !n.matches(".note, .footnote, .working, .answers"));
    const last = kids.pop();
    if (!last?.matches(".msg-text") || !last._c?.src) return;
    S.ask = parseAsk(last._c.src);
    if (S.ask) { S.ask.old = true; drawAnswers(S); }  // old: not listed under Waiting on you unless a restart reopened it
  }

  // ---------- Waiting on you ----------
  // Every open chat that needs you: an approval, a question at the end of a reply, a reply you haven't seen, a failed job.
  let waitOpen = false, waitKey = "", sent = [];
  function waitingItems() {  // the chats on screen (the one in front, or both sides of a split) are left out: you can see them
    const out = [], here = new Set(sp.on ? sp.sides : [state.active]);
    for (const S of state.open.values()) {
      if (here.has(S.sid)) continue;
      for (const h of S.handoffs?.values() || []) out.push({ S, id: "h" + h.id, kind: "Handoff", at: (h.at || 0) * 1000, handoff: h });
      for (const [rid, card] of S.perms) {
        if (!card.ev) continue;
        out.push({ S, id: "p" + rid, kind: card.ev.kind === "question" ? "Question" : card.ev.kind === "plan" ? "Plan" : "Permission", at: card.at, rid, ev: card.ev });
      }
      if (S.perms.size || going(S)) continue;
      if (S.ask && !S.ask.old && !S.ask.seen) out.push({ S, id: "a" + S.sid + S.ask.at, kind: "Question", at: S.ask.at, ask: S.ask });
      else if (S.unseen) out.push({ S, id: "d" + S.sid + (S.doneAt || 0), kind: "Finished", at: S.doneAt || Date.now(), text: S.lastSaid || "" });
      if (S.jobFailed) out.push({ S, id: "j" + S.sid, kind: "Job failed", at: Date.now(), text: "A background job in this chat failed." });
    }
    return out.sort((a, b) => b.at - a.at);
  }
  function note(S, text) { sent.push({ title: S.title || "New session", text, until: Date.now() + 1600 }); setTimeout(() => { sent = sent.filter(x => x.until > Date.now()); renderWaiting(true); }, 1700); }
  function renderWaiting(force) {
    const box = $("#waiting");
    if (!waitOpen || !box) return;
    const items = waitingItems();
    const key = items.map(x => x.id).join("|") + "#" + sent.length;
    if (!force && key === waitKey) { box.querySelectorAll(".wt-i .ago").forEach((n, i) => { if (items[i]) n.textContent = ago(items[i].at / 1000); }); return; }
    waitKey = key;
    box.innerHTML = `<div class="wt-in"><div class="wt-h">Waiting on you</div></div>`;
    const inner = box.firstChild;
    for (const s of sent) { const d = el("div", "wt-i done", `<div class="wt-hd"><span class="wt-dot ok"></span><b></b><span class="k">Sent</span></div><div class="wt-q"></div>`); d.querySelector("b").textContent = s.title; d.querySelector(".wt-q").textContent = s.text; inner.appendChild(d); }
    if (!items.length && !sent.length) { inner.appendChild(el("div", "wt-empty", "Nothing is waiting on you.")); return; }
    for (const x of items) {
      const S = x.S, d = el("div", "wt-i", `<div class="wt-hd"><span class="wt-dot ${x.kind === "Finished" ? "ok" : x.kind === "Job failed" ? "bad" : "warn"}"></span><b></b><span class="k">${x.kind}</span><span class="ago">${ago(x.at / 1000)}</span></div><div class="wt-q"></div><div class="wt-acts"></div>`);
      d.querySelector("b").textContent = S.title || "New session";
      const q = d.querySelector(".wt-q"), acts = d.querySelector(".wt-acts");
      const act = (b, fn) => { b.onclick = fn; acts.appendChild(b); };
      const openIt = primary => act(el("button", "btn small ans" + (primary ? " primary" : " ghost"), IC.open + "<span>Open chat</span>"), () => activate(S.sid));
      if (x.ev) {
        const ev = x.ev;
        if (ev.kind === "question") { q.textContent = (ev.questions || []).map(z => z.question).join(" · "); openIt(true); }
        else if (ev.kind === "plan") { q.textContent = "A plan is ready for you to review."; openIt(true); }
        else {
          q.textContent = ev.tool === "Bash" ? "Run this command?" : `Allow ${ev.label}?`;
          if (ev.detail) { const pre = el("pre"); pre.textContent = ev.detail.length > 400 ? ev.detail.slice(0, 400) + "…" : ev.detail; q.after(pre); }
          const yes = ev.tool === "Bash" ? "Run" : "Allow";
          act(answerButton(yes, true, true), () => { answer(S, x.rid, "allow"); note(S, yes); });
          act(answerButton("Deny", false, true), () => { answer(S, x.rid, "deny"); note(S, "Deny"); });
          openIt(false);
        }
      } else if (x.handoff) {
        const h = x.handoff;
        q.textContent = `From ${h.from_title}: ${h.text.replace(/\s+/g, " ").slice(0, 240)}${h.text.length > 240 ? "…" : ""}`;
        act(answerButton("Send", true, true), () => { note(S, "Sent the handoff"); sendHandoff(S, h); });
        openIt(false);
      } else if (x.ask) {
        q.textContent = x.ask.q;
        x.ask.answers.forEach((a, i) => act(answerButton(a, i === 0, true), () => { note(S, a); quickSend(S, a); }));
        openIt(!x.ask.answers.length);
      } else { q.textContent = x.text; openIt(true); }
      inner.appendChild(d);
    }
  }
  function openWaiting() { waitOpen = true; waitKey = ""; $("#main").classList.add("waiting"); $("#side").classList.add("waiting"); $("#waiting").hidden = false; renderWaiting(true); sync(); }
  function closeWaiting() { if (!waitOpen) return false; waitOpen = false; $("#main").classList.remove("waiting"); $("#side").classList.remove("waiting"); $("#waiting").hidden = true; sync(); return true; }

  // ---------- two chats side by side ----------
  // Both chats stay live. The one you click is the chat in front: the message box, approvals and the Running note
  // move under it, and the other side shows a quiet box that takes you there.
  const sp = { on: false, sides: [], pct: 50 };

  // Motion: whatever changes the split runs inside morph(). It measures where things were, makes the change, then
  // plays the difference: a chat that comes in slides from its own edge, the one that stays glides its text to the
  // new place, the message box glides with the chat in front, and a chat that leaves slides out the way it came.
  // Only positions move (no width animating frame by frame), so long chats stay smooth. Reduce motion turns it off.
  const EASE = "cubic-bezier(.22, 1, .36, 1)", DUR = 420;
  let moving = false, anims = [];
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shown = () => [...state.open.values()].filter(S => !S.el.hidden);
  function play(node, frames, opts, done) {
    const a = node.animate(frames, { duration: DUR, easing: EASE, ...opts });
    anims.push(a);
    a.onfinish = a.oncancel = () => { anims = anims.filter(x => x !== a); done && done(); };
  }
  function morph(fn) {
    const chats = $("#chats"), comp = $("#composer");
    if (moving || still() || !chats || document.body.classList.contains("mini")) { moving = true; try { return fn(); } finally { moving = false; } }
    anims.slice().forEach(a => a.finish());
    const wasOn = sp.on, c0 = chats.getBoundingClientRect();
    const textLeft = S => S.inner.getBoundingClientRect().left + parseFloat(getComputedStyle(S.inner).paddingLeft || 0);
    const before = new Map(shown().map(S => [S, { box: S.el.getBoundingClientRect(), text: textLeft(S),
      top: S.el.scrollTop, pad: getComputedStyle(S.el).paddingTop, ipl: getComputedStyle(S.inner).paddingLeft, ipr: getComputedStyle(S.inner).paddingRight }]));
    const cbox = () => comp && !comp.hidden && comp.querySelector(".composer-box");
    const k0 = cbox() ? cbox().getBoundingClientRect() : null;
    moving = true;
    try { fn(); } finally { moving = false; }
    const now = shown(), c = chats.getBoundingClientRect();
    if (!wasOn && !sp.on) return;  // plain switch between chats: Tether's own fade does that
    chats.style.overflow = "hidden";
    let left = 0;
    const end = () => { if (--left <= 0) chats.style.overflow = ""; };
    const go = (node, frames, opts, done) => { left++; play(node, frames, opts, () => { done && done(); end(); }); };
    for (const S of now) {
      const b = before.get(S);
      if (b) {  // stays: the chat glides so its text starts where it was, and opens up from its old edges as it grows
        const nb = S.el.getBoundingClientRect(), dx = b.text - textLeft(S);
        if (Math.abs(dx) > 1) {
          const l = Math.max(0, b.box.left - (nb.left + dx)), r = Math.max(0, nb.right + dx - b.box.right);
          go(S.el, [{ transform: `translateX(${dx}px)`, clipPath: `inset(0 ${r}px 0 ${l}px)` }, { transform: "none", clipPath: "inset(0 0 0 0)" }]);
        }
      } else if (wasOn && sp.on) {  // a chat from the sidebar takes a side: it settles in place
        go(S.el, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 280 });
      } else {  // the new side slides in from its own edge
        const r = S.el.getBoundingClientRect(), dir = S.el.classList.contains("split-a") ? -1 : 1;
        go(S.el, [{ transform: `translateX(${dir * r.width}px)`, opacity: .35 }, { transform: "none", opacity: 1 }]);
      }
    }
    if (wasOn && !sp.on) for (const [S, b] of before) {  // leaves: it slides out the way it came, then hides
      if (now.includes(S) || !state.open.has(S.sid)) continue;
      const dir = (b.box.left + b.box.right) / 2 < (c0.left + c0.right) / 2 ? -1 : 1;
      Object.assign(S.el.style, { left: b.box.left - c0.left + "px", right: c0.right - b.box.right + "px", paddingTop: b.pad, zIndex: 2 });
      Object.assign(S.inner.style, { paddingLeft: b.ipl, paddingRight: b.ipr });
      S.el.classList.add("split-leave");
      S.el.scrollTop = b.top;
      go(S.el, [{ transform: "none", opacity: 1 }, { transform: `translateX(${dir * b.box.width}px)`, opacity: .35 }], { duration: 360 }, () => {
        S.el.classList.remove("split-leave");
        ["left", "right", "paddingTop", "zIndex"].forEach(k => S.el.style[k] = "");
        S.inner.style.paddingLeft = S.inner.style.paddingRight = "";
      });
    }
    if (k0 && cbox()) {  // the message box glides under the chat in front; growing, it opens up from its old edges
      const k1 = cbox().getBoundingClientRect(), r = getComputedStyle(cbox()).borderRadius;
      if (k1.width <= k0.width + 1) {
        const dx = (k0.left + k0.right) / 2 - (k1.left + k1.right) / 2;
        if (Math.abs(dx) > 1) go(comp, [{ transform: `translateX(${dx}px)` }, { transform: "none" }]);
      } else {
        go(cbox(), [{ transform: `translateX(${k0.left - k1.left}px)`, clipPath: `inset(0 ${k1.width - k0.width}px 0 0 round ${r})` },
                    { transform: "none", clipPath: `inset(0 0 0 0 round ${r})` }]);
      }
    }
    if (!wasOn && sp.on) {  // names, the line between and the quiet box fade in once the sides are moving
      document.querySelectorAll(".split-head, .split-grip, #split-stub").forEach(n => !n.hidden &&
        go(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 160, fill: "backwards", easing: "ease-out" }));
    }
  }

  const split = {
    isOn: () => sp.on,
    moving: () => moving,
    morph,
    has: sid => sp.on && sp.sides.includes(sid),
    toggle() {
      if (sp.on) return split.off();
      const cur = state.open.get(state.active);
      const other = [...state.open.values()].filter(S => S !== cur).sort((a, b) => b.lastActive - a.lastActive)[0];
      if (!cur || !other) return toast("Open a second chat first, then split.");
      morph(() => { sp.sides = [cur.sid, other.sid]; sp.on = true; split.layout(); });
    },
    async beside(s) {  // from a chat's menu: it opens on the right of the chat in front
      const cur = state.active;
      if (!cur || cur === s.id) return;
      if (document.body.classList.contains("mini")) setMini(false);
      if (sp.on) morph(() => { sp.on = false; for (const S of state.open.values()) S.el.hidden = S.sid !== cur; split.layout(); });
      await openSession(s.id, s.cwd, s.title, true);  // loads behind the chat you're in, so nothing flashes
      if (!state.open.has(cur) || !state.open.has(s.id) || state.active !== cur) return;
      morph(() => { sp.sides = [cur, s.id]; sp.on = true; activate(s.id); });
    },
    off(quiet) {  // quiet: no motion (the mini window has its own)
      if (!sp.on) return;
      const f = () => {
        sp.on = false;
        for (const S of state.open.values()) S.el.hidden = S.sid !== state.active;
        split.layout();
      };
      if (quiet) { moving = true; try { f(); } finally { moving = false; } } else morph(f);
    },
    drop(sid) { if (split.has(sid)) { sp.on = false; split.layout(); } },
    onActivate(sid, prev) {
      if (!sp.on) return;
      if (!sid || !state.open.has(sid)) { sp.on = false; return split.layout(); }
      if (!sp.sides.includes(sid)) sp.sides[Math.max(0, sp.sides.indexOf(prev))] = sid;  // a chat from the sidebar takes the side you were on
      split.layout();
    },
    layout() {
      const main = $("#main"), b = $("#split-btn");
      if (!main) return;
      const [A, B] = sp.sides.map(id => state.open.get(id));
      if (sp.on && (!A || !B || A === B)) sp.on = false;
      main.classList.toggle("split", sp.on);
      for (const S of state.open.values()) S.el.classList.remove("split-a", "split-b");
      if (b) { b.hidden = !(sp.on || state.open.size > 1) || document.body.classList.contains("mini"); b.innerHTML = sp.on ? IC.one + "<span>One chat</span>" : IC.split + "<span>Split</span>"; b.title = sp.on ? "Back to one chat" : "Two chats side by side"; }
      const fi = sp.on ? sp.sides.indexOf(state.active) : -1;
      main.classList.toggle("focus-a", fi === 0); main.classList.toggle("focus-b", fi === 1);
      document.querySelectorAll(".split-head, .split-grip").forEach(n => n.hidden = !sp.on);
      $("#split-stub").hidden = !sp.on;
      if (!sp.on) return;
      main.style.setProperty("--split", sp.pct + "%");
      A.el.classList.add("split-a"); B.el.classList.add("split-b"); A.el.hidden = B.el.hidden = false;
      split.paint();
    },
    paint() {  // names, states and the quiet box: redrawn whenever a status changes
      if (!sp.on) return;
      sp.sides.forEach((id, i) => {
        const S = state.open.get(id), h = document.querySelector(`.split-head.${i ? "b" : "a"}`);
        if (!S || !h) return;
        const st = liveStatus(S);
        h.classList.toggle("on", id === state.active);
        h.querySelector(".nm").textContent = S.title || "New session";
        h.querySelector(".st").innerHTML = `<span class="wt-dot ${st === "waiting" ? "warn" : st === "running" || st === "starting" ? "run" : st === "done" ? "ok" : st === "exited" ? "bad" : ""}"></span>${esc(STATUS_WORDS[st] || "")}`;
      });
      const O = state.open.get(sp.sides.find(id => id !== state.active)), t = $("#split-stub .t");
      if (!O || !t) return;
      const draft = (O.draft || "").trim().split("\n")[0];
      t.textContent = O.perms.size ? "Needs you" : draft || (going(O) ? "Queue a message" : "Message Claude");
      $("#split-stub").classList.toggle("warn", !!O.perms.size);
      $("#split-stub").classList.toggle("has", !!draft && !O.perms.size);
    },
  };
  function wireSplit() {
    const chats = $("#chats");
    for (const k of ["a", "b"]) {
      const h = el("div", "split-head " + k, `<span class="nm"></span><span class="st"></span><span class="spacer"></span><button class="icb" title="Close this side">${IC.no}</button>`);
      h.hidden = true;
      h.onclick = e => {
        const i = k === "a" ? 0 : 1, id = sp.sides[i], other = sp.sides[1 - i];
        if (e.target.closest("button")) { morph(() => { split.off(); if (state.open.has(other)) activate(other); }); return; }
        if (id !== state.active) activate(id, true);
      };
      chats.appendChild(h);
    }
    const g = el("div", "split-grip"); g.hidden = true; g.title = "Drag to resize";
    g.onmousedown = e => {
      e.preventDefault();
      const r = chats.getBoundingClientRect();
      const move = ev => { sp.pct = Math.max(25, Math.min(75, ((ev.clientX - r.left) / r.width) * 100)); $("#main").style.setProperty("--split", sp.pct + "%"); };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); document.body.classList.remove("split-drag"); };
      document.body.classList.add("split-drag");
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    };
    g.ondblclick = () => { sp.pct = 50; $("#main").style.setProperty("--split", "50%"); };
    chats.appendChild(g);
    chats.addEventListener("mousedown", e => {  // a click anywhere in the other half brings that chat in front
      if (!sp.on) return;
      const c = e.target.closest(".chat"), S = c && [...state.open.values()].find(x => x.el === c);
      if (S && S.sid !== state.active) activate(S.sid, true);
    }, true);
    $("#split-stub").onclick = () => { const id = sp.sides.find(x => x !== state.active); if (id) activate(id); };
    $("#split-btn").onclick = () => split.toggle();
  }

  // ---------- Pick on the Shelf ----------
  // A page marks its options with data-tether-option="1" (and, if it likes, data-tether-label). This script, added to
  // the sealed page, gives each a Pick button and tells Tether what's ticked; Tether sends the choice as your reply.
  const PICK_JS = `<script>(()=>{const picked=new Set(),ACC="#0B6E86";
const st=document.createElement("style");st.textContent=".tether-pick{all:revert;display:inline-flex;align-items:center;gap:6px;margin:10px 0 0;padding:5px 10px;border:1px solid rgba(128,128,128,.55);border-radius:8px;background:transparent;color:inherit;font:500 12px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;line-height:1.3}.tether-pick i{width:12px;height:12px;border:1.5px solid currentColor;border-radius:3.5px;box-sizing:border-box;opacity:.7}.tether-pick.on{background:"+ACC+";border-color:"+ACC+";color:#fff}.tether-pick.on i{background:#fff;opacity:1;box-shadow:inset 0 0 0 2px "+ACC+"}[data-tether-picked]{outline:2px solid "+ACC+";outline-offset:2px}";
const els=()=>[...document.querySelectorAll("[data-tether-option]")];
const label=e=>(e.dataset.tetherLabel||(e.querySelector("h1,h2,h3,h4,h5,b,strong")||{}).textContent||"").replace(/\\s+/g," ").trim().replace(/^(option\\s*)?[0-9A-Za-z]{1,2}\\s*[·.:)—-]\\s*/i,"").slice(0,80);
const post=()=>parent.postMessage({tetherPick:{picked:[...picked],options:els().map(e=>({id:e.dataset.tetherOption,label:label(e)}))}},"*");
const paint=()=>els().forEach(e=>{const on=picked.has(e.dataset.tetherOption),b=e.querySelector(":scope > .tether-pick");if(on)e.setAttribute("data-tether-picked","");else e.removeAttribute("data-tether-picked");if(b){b.classList.toggle("on",on);b.lastChild.textContent=on?"Picked":"Pick";}});
let busy=false;
const scan=()=>{const all=els();if(!all.length)return;if(!st.isConnected)(document.head||document.documentElement).appendChild(st);busy=true;
all.forEach(e=>{if(e.querySelector(":scope > .tether-pick"))return;const b=document.createElement("button");b.type="button";b.className="tether-pick";b.appendChild(document.createElement("i"));b.appendChild(document.createTextNode("Pick"));
b.addEventListener("click",ev=>{ev.preventDefault();ev.stopPropagation();const id=e.dataset.tetherOption;picked.has(id)?picked.delete(id):picked.add(id);paint();post();});e.appendChild(b);});
paint();busy=false;};
addEventListener("load",()=>{scan();new MutationObserver(()=>{if(!busy)scan();}).observe(document.documentElement,{childList:true,subtree:true});});
addEventListener("message",e=>{if(e.source!==parent||!e.data||!e.data.tetherPickClear)return;picked.clear();paint();});
})()<\/script>`;
  let pick = null;
  function pickText(full) {
    const opts = pick.options.filter(o => pick.picked.includes(o.id));
    const ids = opts.map(o => o.id), names = opts.map(o => o.label).filter(Boolean);
    const tail = full && names.length === opts.length ? ` (${names.join(" + ")})` : "";
    if (ids.length === 1) return `Build option ${ids[0]}${tail}.`;
    return `Combine options ${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}${tail}.`;
  }
  function onPick(d, frame) {
    const bar = document.querySelector("#panel-body .vw-pick");
    if (!bar) return;
    pick = { picked: (d.picked || []).map(String), options: (d.options || []).map(o => ({ id: String(o.id), label: String(o.label || "") })), frame };
    if (!pick.picked.length) { bar.hidden = true; bar.innerHTML = ""; return; }
    if (!bar.querySelector("input")) {
      bar.innerHTML = `<span class="lbl"></span><input placeholder="Add a note (optional)" spellcheck="true"><button class="btn small primary ans">${IC.send}<span>Send</span></button>`;
      const go = () => {
        const S = state.open.get(state.active); if (!S || !pick?.picked.length) return;
        const n = bar.querySelector("input").value.trim();
        quickSend(S, pickText(true) + (n ? " " + n : ""));
        pick.frame?.contentWindow?.postMessage({ tetherPickClear: 1 }, "*");
        bar.hidden = true; bar.innerHTML = "";
      };
      bar.querySelector("button").onclick = go;
      bar.querySelector("input").onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); go(); } };
    }
    bar.querySelector(".lbl").textContent = pickText(false);
    bar.hidden = false;
  }

  // ---------- handoffs between chats ----------
  // Claude in one chat calls hand_off (wb_mcp.py), which leaves a file for the chat it names. Here it becomes a card
  // in that chat: what it says, with Send, Edit (into the message box) and Dismiss. Nothing is sent until you click.
  // Unsent ones come back after a restart. You can also start one from a chat's menu or ⌘K.
  let hoBusy = false;
  const handoffMessage = h => `Handoff from the chat “${h.from_title}”:\n\n${h.text}`;
  async function loadHandoffs() {
    if (hoBusy || !ready) return;
    hoBusy = true;
    try {
      for (const h of await api().handoffs().catch(() => []) || []) {
        let S = state.open.get(h.to_sid);
        if (S?.handoffs?.has(h.id)) continue;
        if (!S) { await openSession(h.to_sid, h.to_cwd, h.to_title, true).catch(() => {}); S = state.open.get(h.to_sid); }
        if (!S) continue;
        (S.handoffs ||= new Map()).set(h.id, h);
        h.el = handoffCard(S, h);
        add(S, h.el);
      }
    } finally { hoBusy = false; }
    renderSidebar();
  }
  function handoffCard(S, h) {
    const d = el("div", "handoff", `<div class="ho-hd"><span class="wt-dot run"></span><span class="k">Handoff</span><span>from <b></b></span><span class="ago"></span></div><div class="ho-body"></div><div class="ho-acts"></div>`);
    d.querySelector("b").textContent = h.from_title;
    d.querySelector(".ago").textContent = ago(h.at || Date.now() / 1000);
    window.renderMarkdown(d.querySelector(".ho-body"), h.text);
    const acts = d.querySelector(".ho-acts"), btn = (label, primary, fn, icon = "") => {
      const b = icon ? el("button", "btn ans small" + (primary ? " primary" : " ghost"), icon + `<span>${label}</span>`) : answerButton(label, primary, true);
      if (!primary && !icon) b.classList.add("ghost");
      b.onclick = fn; acts.appendChild(b);
    };
    btn("Send", true, () => sendHandoff(S, h));
    btn("Edit", false, () => editHandoff(S, h), IC.pen);
    btn("Dismiss", false, () => doneHandoff(S, h, "Dismissed"), IC.no);
    return d;
  }
  function doneHandoff(S, h, how) {
    S.handoffs?.delete(h.id);
    api().handoff_done(h.id);
    if (h.el) { h.el.classList.add("done"); h.el.querySelector(".ho-acts").innerHTML = `<span class="ho-st">${esc(how)}</span>`; }
    renderSidebar();
  }
  function sendHandoff(S, h) { doneHandoff(S, h, "Sent"); quickSend(S, handoffMessage(h)); }
  function editHandoff(S, h) {
    if (state.active !== S.sid) activate(S.sid);
    const box = $("#input"), cur = box.value.trim();
    box.value = (cur ? cur + "\n\n" : "") + handoffMessage(h);
    autogrow(); box.focus(); box.setSelectionRange(box.value.length, box.value.length);
    doneHandoff(S, h, "Moved to the message box");
  }
  function handoffDialog(s) {  // s: the chat that hands off (a sidebar row's session, or the chat in front)
    if (!s?.id) return;
    const byId = new Map((state.sessions || []).map(x => [x.id, x]));
    const name = id => state.open.get(id)?.title || byId.get(id)?.title || "New session";
    const seen = new Set([s.id]), opts = [];
    const push = (id, group) => { if (!seen.has(id)) { seen.add(id); opts.push({ id, group, title: name(id) }); } };
    for (const S of state.open.values()) if (S.status !== "new") push(S.sid, "Open");
    for (const x of state.sessions || []) if (x.pinned && !x.archived) push(x.id, "Pinned");
    for (const x of (state.sessions || []).filter(x => !x.archived && !x.scratch).sort((a, b) => b.mtime - a.mtime).slice(0, 20)) push(x.id, "Recent");
    if (!opts.length) return toast("Open another chat first.");
    const groups = ["Open", "Pinned", "Recent"].map(g => { const o = opts.filter(x => x.group === g); return o.length ? `<optgroup label="${g}">${o.map(x => `<option value="${esc(x.id)}">${esc(x.title)}</option>`).join("")}</optgroup>` : ""; }).join("");
    const box = openModal(`<h2>Hand off to another chat</h2>
      <label class="ho-f"><span>To</span><select class="field" data-k="to">${groups}</select></label>
      <label class="ho-f"><span>What should it do?</span><textarea class="field" data-k="ask" rows="4" placeholder="Check the change log job and tell me if it ran"></textarea></label>
      <div class="modal-acts"><button class="btn ghost" data-close>Cancel</button><button class="btn primary ans" data-k="go">${IC.send || ""}<span>Hand off</span></button></div>`);
    const ta = box.querySelector("[data-k=ask]");
    setTimeout(() => ta.focus(), 50);
    const go = async () => {
      const to = box.querySelector("[data-k=to]").value, ask = ta.value.trim();
      if (!ask) { ta.focus(); return; }
      closeModal();
      let S = state.open.get(s.id);
      if (!S) { await openSession(s.id, s.cwd, s.title, true).catch(() => {}); S = state.open.get(s.id); }
      if (!S) return toast("Couldn't open that chat.", "error");
      quickSend(S, `Hand this off to the chat “${name(to)}” (id ${to}): ${ask}\n\nUse hand_off with to="${to}". Write the ask first, then what that chat needs to know from this one.`);
      toast(`“${S.title || "This chat"}” is writing the handoff`);
    };
    box.querySelector("[data-k=go]").onclick = go;
    ta.onkeydown = e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } };
  }

  // ---------- Restart when idle ----------
  // Waits until no chat is replying, waiting on an approval, or running a job; then Tether quits, starts again and
  // reopens the same chats. The sidebar also offers it when Tether's own files changed on this Mac since it started.
  const rs = { waiting: false, timer: 0, chats: [], auto: false, mode: "restart", snooze: 0 };  // chats: what it waits for, [{sid, title, why}]

  // Settings › Updates › Update on its own when idle. A new version on GitHub, or Tether's own files changed on this
  // Mac, starts the same wait as Restart when idle. On its own it also waits for you: no message box holding text
  // (a restart doesn't keep it) and no typing for a minute. A GitHub update waits while this Mac has changes not on
  // GitHub, so work in progress is never set aside. Cancel pauses it for an hour.
  let lastKey = 0;
  addEventListener("keydown", () => { lastKey = Date.now(); }, true);
  function autoCheck(kind) {  // kind: "update" (GitHub has a newer Tether) or "restart" (files changed here)
    if (!state.settings?.auto_update || Date.now() < rs.snooze || rs.waiting || upd.waiting) return;
    const i = upd.info || {};
    if (kind === "update" && !(i.behind > 0 && !i.dirty && !i.ahead)) return;
    rs.auto = true; rs.mode = kind; runRestart(false);
  }
  function yourHolds() {
    const out = [];
    for (const S of state.open.values()) {
      const t = (S.sid === state.active ? $("#input").value : S.draft || "").trim();
      if (t) out.push({ sid: S.sid, title: S.title || "New session", why: "message not sent" });
    }
    if (Date.now() - lastKey < 60000) out.push({ sid: "", title: "You", why: "typed in the last minute" });
    return out;
  }
  const busyChats = () => [...state.open.values()].filter(S => going(S) || jobsRunning(S).length);
  async function runRestart(force) {
    const again = () => { clearTimeout(rs.timer); rs.timer = setTimeout(() => rs.waiting && runRestart(false), 3000); };
    if (rs.auto && !force) {
      const hold = yourHolds();
      if (hold.length) { rs.waiting = true; rs.chats = hold; again(); return sync(); }
    }
    const chats = [...state.open.values()].filter(S => S.status !== "new").map(S => ({ sid: S.sid, cwd: S.cwd, title: S.title || "" }));
    const r = await (rs.mode === "update" ? api().update_now(chats, state.active || "") : api().restart_now(chats, state.active || "", !!force, rs.auto && !force))
      .catch(e => ({ error: String(e) }));
    if (r.busy) { rs.waiting = true; rs.chats = r.chats || []; clearTimeout(rs.timer); rs.timer = setTimeout(() => rs.waiting && runRestart(false), 3000); return sync(); }
    const mode = rs.mode, auto = rs.auto;
    rs.waiting = false; rs.chats = []; rs.auto = false; rs.mode = "restart"; sync();
    if (r.error) { if (auto) rs.snooze = Date.now() + 3600e3; return toast(r.error, "error"); }
    toast(mode === "update" ? "Updating Tether…" : "Restarting Tether…");
  }
  function cancelRestart() {
    if (rs.auto) { rs.snooze = Date.now() + 3600e3; toast("Won't update on its own for an hour"); }
    rs.waiting = false; rs.chats = []; rs.auto = false; rs.mode = "restart"; clearTimeout(rs.timer); sync();
  }
  // Under "Restarts when idle": each chat it's waiting for and why (replying, needs your answer, a job or agent
  // running). Click one to go there. The list comes from Tether's own check, the same one that decides the restart.
  function paintRestartList(line) {
    const box = line.querySelector(".rl-list"), list = rs.chats.slice(0, 4);
    const key = JSON.stringify(list) + state.active;
    if (box.dataset.k === key) return;
    box.dataset.k = key; box.innerHTML = "";
    for (const c of list) {
      const b = el(c.sid ? "button" : "div", "rl-row" + (c.why === "needs your answer" ? " warn" : "") + (c.sid ? "" : " you"), `<span class="nm"></span><span class="why"></span>`);
      b.querySelector(".nm").textContent = (state.open.get(c.sid)?.title) || c.title;
      b.querySelector(".why").textContent = c.why;
      b.title = c.sid ? `${b.querySelector(".nm").textContent} · ${c.why}. Go to this chat` : `${b.querySelector(".nm").textContent} · ${c.why}`;
      b.onclick = () => { if (state.open.has(c.sid)) activate(c.sid); };
      box.appendChild(b);
    }
    if (rs.chats.length > list.length) box.appendChild(el("div", "rl-more", `and ${rs.chats.length - list.length} more`));
  }
  function restartDialog(changed) {
    const n = busyChats().length;
    if (rs.waiting) {
      const box = openModal(`<h2>Restarting when idle</h2><p class="modal-p">Tether restarts when ${n === 1 ? "1 chat finishes" : `${n} chats finish`}, then reopens your chats.</p>
        <div class="modal-acts"><button class="btn ghost" data-k="stop">Don't restart</button><button class="btn primary" data-close>Keep waiting</button></div>`);
      box.querySelector('[data-k="stop"]').onclick = () => { closeModal(); cancelRestart(); };
      return;
    }
    const why = changed ? "Tether's files changed on this Mac. A restart loads them. " : "";
    const box = openModal(`<h2>Restart Tether</h2><p class="modal-p">${why}${n ? `${n === 1 ? "A chat is" : n + " chats are"} still working. Restart when idle waits for ${n === 1 ? "it" : "them"} to finish, then reopens your chats.` : "Your open chats come back after the restart."}</p>
      <div class="modal-acts"><button class="btn ghost" data-close>Cancel</button>${n ? `<button class="btn ans" data-k="now">${IC.restart}<span>Restart now</span></button><button class="btn primary ans" data-k="idle">${IC.restart}<span>Restart when idle</span></button>`
        : `<button class="btn primary ans" data-k="idle">${IC.restart}<span>Restart now</span></button>`}</div>`);
    box.querySelector('[data-k="idle"]').onclick = () => { closeModal(); rs.auto = false; rs.mode = "restart"; runRestart(false); };
    box.querySelector('[data-k="now"]')?.addEventListener("click", async () => {
      closeModal();
      const ok = await confirmBox("Restart now?", `${n === 1 ? "A chat is" : n + " chats are"} still working. Restarting now stops ${n === 1 ? "it" : "them"} in the middle.`, "Restart now");
      if (ok) runRestart(true);
    });
  }
  async function checkChanged() {
    const r = await api().code_changed().catch(() => null);
    const b = $("#restart-btn");
    if (b) b.hidden = !r?.changed;
    if (r?.changed) autoCheck("restart");
  }

  // ---------- kept in step with the rest ----------
  function sync() {
    if (!ready) return;
    const n = waitingItems().length, row = $("#waiting-row");
    row.hidden = !n && !waitOpen;
    row.classList.toggle("on", waitOpen);
    row.querySelector(".c").textContent = n || "";
    row.querySelector(".wt-dot").className = "wt-dot " + (n ? "warn" : "");
    renderWaiting();
    split.layout();
    const line = $("#restart-line"), k = rs.chats.length;
    line.hidden = !rs.waiting;
    if (rs.waiting) {
      const up = rs.mode === "update";
      line.querySelector(".t").textContent = k ? `${up ? "Update" : "Restart"} waits for` : up ? "Updating…" : "Restarting…";  // short: Cancel shares the line
      paintRestartList(line);
    }
    $("#restart-btn").classList.toggle("wait", rs.waiting);
  }
  function init() {
    ready = true;
    wireSplit();
    $("#waiting-row").onclick = () => waitOpen ? closeWaiting() : openWaiting();
    $("#restart-line .lnk-btn").onclick = cancelRestart;
    $("#restart-btn").onclick = () => restartDialog(true);
    setTimeout(loadHandoffs, 2500);  // unsent ones from before a restart
    setInterval(loadHandoffs, 30000);
    setTimeout(checkChanged, 20000);
    setInterval(checkChanged, 60000);
    setInterval(() => { if (waitOpen) renderWaiting(); }, 30000);
    sync();
  }

  return { init, sync, autoCheck, loadHandoffs, handoffDialog, turnEnd, userSpoke, fromHistory, carryAsk, quickSend, openWaiting, closeWaiting, split, PICK_JS, onPick, restartDialog };
})();
