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
  function toYou(q) {  // the last sentence (after its last colon) speaks to you: "Should I push?", "Which do you want?"
    const last = q.split(/(?<=[.!])\s+/).pop().split(/:\s+/).pop();
    return /\b(you|your|I|me|we|us|let's|shall|should)\b/i.test(last);
  }
  function parseAsk(src) {
    src = (src || "").trimEnd();
    const m = ANS_RE.exec(src);
    const answers = m ? m[1].split("|").map(x => x.trim()).filter(Boolean).slice(0, 6) : [];
    let q = plain(window.stripAnswers(src).trimEnd().split(/\n\s*\n/).pop());
    if (!answers.length && !/\?["”')\]]*$/.test(q)) return null;
    if (!answers.length && !toYou(q)) return null;  // e.g. "…and the open question: can X do Y?" describes a question, doesn't ask you
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
    if (S.ask && (S.sid === state.active || split.has(S.sid)) && document.hasFocus()) S.ask.seen = true;  // it came in while you were looking
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
  function waitingItems(all) {  // the chats on screen (the one in front, or every pane of a split) are left out: you can see them
    const out = [], here = all ? new Set() : new Set(sp.on ? sp.sides : [state.active]);  // all: for the floating panel, shown while Tether is away
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

  // ---------- up to four chats in a split ----------
  // Every chat in the split stays live. The one you click is the chat in front: the message box, approvals and the
  // Running note move under it, and each other pane shows a quiet box that takes you there. Layouts: two or three
  // side by side, one large with two stacked, four in a grid. A pane can be empty (after ✕, or when its chat closes);
  // it then lists chats to put there.
  const LAYOUTS = {
    "2": { n: 2, name: "Two side by side", pic: `<path d="M12 1v14"/>` },
    "3": { n: 3, name: "Three side by side", pic: `<path d="M8.3 1v14M15.7 1v14"/>` },
    "1+2": { n: 3, name: "One large, two stacked", pic: `<path d="M13 1v14M13 8h10"/>` },
    "4": { n: 4, name: "Four in a grid", pic: `<path d="M12 1v14M1 8h22"/>` },
  };
  const GEO = { "2": { x: 50 }, "3": { x: 33.34, x2: 66.67 }, "1+2": { x: 56, y: 50 }, "4": { x: 50, y: 50 } };
  const PIC = d => `<svg class="lp" viewBox="0 0 24 16"><rect x="1" y="1" width="22" height="14" rx="2.5"/>${d || ""}</svg>`;
  const sp = { on: false, layout: "2", sides: [], geo: JSON.parse(JSON.stringify(GEO)), mem: {}, target: null };
  const THREE_MIN = 820;  // three columns narrower than this are too thin to read
  // each pane's box in the chat area, in percent: [left, top, right, bottom]
  function paneRects(k = sp.layout) {
    const g = sp.geo[k];
    return k === "3" ? [[0, 0, g.x, 100], [g.x, 0, g.x2, 100], [g.x2, 0, 100, 100]]
      : k === "1+2" ? [[0, 0, g.x, 100], [g.x, 0, 100, g.y], [g.x, g.y, 100, 100]]
      : k === "4" ? [[0, 0, g.x, g.y], [g.x, 0, 100, g.y], [0, g.y, g.x, 100], [g.x, g.y, 100, 100]]
      : [[0, 0, g.x, 100], [g.x, 0, 100, 100]];
  }
  const box = (n, [l, t, r, b]) => Object.assign(n.style, { left: l + "%", top: t + "%", right: 100 - r + "%", bottom: 100 - b + "%" });
  const unbox = n => ["left", "top", "right", "bottom"].forEach(k => n.style[k] = "");
  const real = () => sp.sides.filter(id => id && state.open.has(id));
  const byRecent = () => [...state.open.values()].sort((a, b) => b.lastActive - a.lastActive);

  // Motion: whatever changes the split runs inside morph(). It measures where things were, makes the change, then
  // plays the difference: a chat that comes in slides from its own edge, the one that stays glides its text to the
  // new place, the message box glides with the chat in front, and a chat that leaves slides out the way it came.
  // Only positions move (no width animating frame by frame), so long chats stay smooth. Reduce motion turns it off.
  const EASE = "cubic-bezier(.22, 1, .36, 1)", DUR = 420;
  let moving = false, anims = [];
  const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shown = () => [...state.open.values()].filter(S => !S.el.hidden);
  // Motion timer: what a change costs on this Mac, one line each in Tether.log ("[motion] …"). once(): how long the
  // change held the page, the wait for the first drawn frame, then the gaps between frames while it moves.
  // stream(): the same gaps for something that goes on as long as you drag (a pane line, the window's edge).
  const load = () => { const on = shown(); return `${on.length} chat${on.length === 1 ? "" : "s"} shown, ${on.reduce((n, S) => n + S.inner.childElementCount, 0)} blocks`; };
  const gapsLine = g => { if (!g.length) return "no frames"; const s = g.slice().sort((a, b) => a - b); return `${g.length} frames, typical ${Math.round(s[s.length >> 1])} ms, worst ${Math.round(s[s.length - 1])} ms, ${g.filter(x => x > 34).length} over 34 ms`; };
  const say = line => { try { api().motion_log(line); } catch (e) {} };
  const timer = {
    once(label, ms = 700, t0 = performance.now()) {
      return () => {  // call when the change has been made
        const held = performance.now() - t0, gaps = [];
        let last = 0, first = 0;
        const tick = () => {
          const now = performance.now();
          if (!last) first = now - t0 - held; else gaps.push(now - last);
          last = now;
          if (now - t0 - held < ms) requestAnimationFrame(tick);
          else say(`${label} · ${load()} · held ${Math.round(held)} ms, first frame +${Math.round(first)} ms · ${gapsLine(gaps)}`);
        };
        requestAnimationFrame(tick);
      };
    },
    stream(label) {
      const gaps = []; let last = 0;
      return { frame() { const now = performance.now(); if (last && now - last < 250) gaps.push(now - last); last = now; },
               end() { if (gaps.length > 2) say(`${label} · ${load()} · ${gapsLine(gaps)}`); } };
    },
  };
  // Each animation is made holding its first frame, and starts only once that frame has been drawn. Laying out a
  // long chat for a new pane can take longer than the motion itself; started straight away, it would be over
  // before anything showed.
  let held = [], heldAt = 0;
  function play(node, frames, opts, done) {
    const a = node.animate(frames, { duration: DUR, easing: EASE, fill: "backwards", ...opts });
    a.pause();
    anims.push(a); held.push(a);
    a.onfinish = a.oncancel = () => { anims = anims.filter(x => x !== a); done && done(); };
    if (!heldAt) heldAt = requestAnimationFrame(() => requestAnimationFrame(() => {
      heldAt = 0;
      const go = held; held = [];
      for (const x of go) if (x.playState === "paused") x.play();
    }));
  }
  function morph(fn) {
    const chats = $("#chats"), comp = $("#composer");
    if (moving || still() || !chats || document.body.classList.contains("mini")) { moving = true; try { return fn(); } finally { moving = false; } }
    anims.slice().forEach(a => a.finish());
    const wasOn = sp.on, c0 = chats.getBoundingClientRect(), from = sp.on ? sp.layout : "1", began = performance.now();
    const textLeft = S => S.inner.getBoundingClientRect().left + parseFloat(getComputedStyle(S.inner).paddingLeft || 0);
    const before = new Map(shown().map(S => [S, { box: S.el.getBoundingClientRect(), text: textLeft(S), inner: S.inner.getBoundingClientRect().top,
      top: S.el.scrollTop, end: S.el.scrollHeight - S.el.scrollTop - S.el.clientHeight < 60,
      pad: getComputedStyle(S.el).paddingTop, ipl: getComputedStyle(S.inner).paddingLeft, ipr: getComputedStyle(S.inner).paddingRight }]));
    const parts = () => [...chats.querySelectorAll(".split-head, .split-stub, .split-empty, .split-grip")].filter(n => !n.hidden);
    const pb = new Map(parts().map(n => [n, n.getBoundingClientRect()]));
    const cbox = () => comp && !comp.hidden && comp.querySelector(".composer-box");
    const k0 = cbox() ? cbox().getBoundingClientRect() : null;
    moving = true;
    try { fn(); } finally { moving = false; }
    const now = shown(), c = chats.getBoundingClientRect();
    if (!wasOn && !sp.on) return;  // plain switch between chats: Tether's own fade does that
    const to = sp.on ? sp.layout : "1", stop = timer.once(from === to ? `split ${to}, pane change` : `split ${from} to ${to}`, 700, began);
    queueMicrotask(stop);  // after the animations below are set up
    chats.style.overflow = "hidden";
    let left = 0;
    const end = () => { if (--left <= 0) chats.style.overflow = ""; };
    const go = (node, frames, opts, done) => { left++; play(node, frames, opts, () => { done && done(); end(); }); };
    const same = (a, b) => Math.abs(a.left - b.left) < 2 && Math.abs(a.top - b.top) < 2 && Math.abs(a.right - b.right) < 2 && Math.abs(a.bottom - b.bottom) < 2;
    const holds = (r, x, y) => x > r.left && x < r.right && y > r.top && y < r.bottom;
    // which way a pane slides: [x, y] pointing away from the box that sits next to it (the one giving it room, or taking its room)
    const awayFrom = (r, o) => !o ? [(r.left + r.right) / 2 < (c.left + c.right) / 2 - 1 ? -1 : 1, 0]
      : o.bottom <= r.top + 2 ? [0, 1] : o.top >= r.bottom - 2 ? [0, -1] : o.right <= r.left + 2 ? [1, 0] : o.left >= r.right - 2 ? [-1, 0]
      : [(r.left + r.right) / 2 < (c.left + c.right) / 2 - 1 ? -1 : 1, 0];
    const nowBox = new Map(now.map(S => [S, S.el.getBoundingClientRect()]));
    for (const S of now) {
      const b = before.get(S), nb = nowBox.get(S);
      if (b) {  // stays: it glides from where it was, its words holding their place, and opens up from its old edges as it grows
        const sameW = Math.abs(nb.width - b.box.width) < 2;
        if (b.end && !sameW) S.el.scrollTop = S.el.scrollHeight;  // its lines re-wrapped: keep it on the newest ones
        const dx = sameW ? b.box.left - nb.left : b.text - textLeft(S);
        const dy = sameW ? b.inner - S.inner.getBoundingClientRect().top : b.box.top - nb.top;
        const l = Math.max(0, b.box.left - (nb.left + dx)), r = Math.max(0, nb.right + dx - b.box.right);
        const t = Math.max(0, b.box.top - (nb.top + dy)), u = Math.max(0, nb.bottom + dy - b.box.bottom);
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || l > 1 || r > 1 || t > 1 || u > 1)
          go(S.el, [{ transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(${t}px ${r}px ${u}px ${l}px)` }, { transform: "none", clipPath: "inset(0 0 0 0)" }]);
        if (b.end && sameW && nb.height < b.box.height - 2) S.el.scrollTo({ top: S.el.scrollHeight, behavior: "smooth" });  // it got shorter: ease down to the newest lines
        continue;
      }
      const cx = (nb.left + nb.right) / 2, cy = (nb.top + nb.bottom) / 2;
      if ([...before.values()].some(o => same(o.box, nb))) {  // it takes a pane another chat had: it settles in place
        go(S.el, [{ opacity: 0, transform: "translateY(12px) scale(.985)" }, { opacity: 1, transform: "none" }], { duration: 300 });
      } else {  // a new pane slides in from the far side of the chat that made room for it
        const host = now.find(O => before.has(O) && holds(before.get(O).box, cx, cy));
        const [ux, uy] = awayFrom(nb, host ? nowBox.get(host) : null);
        S.el.style.zIndex = 2;
        go(S.el, [{ transform: `translate(${ux * nb.width}px, ${uy * nb.height}px)`, opacity: .35 }, { transform: "none", opacity: 1 }], null, () => { S.el.style.zIndex = ""; });
      }
    }
    if (wasOn) for (const [S, b] of before) {  // leaves: it slides out the way it came, then hides
      if (now.includes(S) || !state.open.has(S.sid)) continue;
      if (now.some(O => !before.has(O) && same(nowBox.get(O), b.box))) continue;  // another chat took its pane: that one settles over it
      const cx = (b.box.left + b.box.right) / 2, cy = (b.box.top + b.box.bottom) / 2;
      const taker = now.find(O => before.has(O) && holds(nowBox.get(O), cx, cy));  // the chat that grows into its room
      const gone = !taker && sp.on;  // its pane is still there, empty: it fades where it is
      const [ux, uy] = gone ? [0, 0] : awayFrom(b.box, taker ? before.get(taker).box : null);
      Object.assign(S.el.style, { left: b.box.left - c0.left + "px", right: c0.right - b.box.right + "px", top: b.box.top - c0.top + "px", bottom: c0.bottom - b.box.bottom + "px", paddingTop: b.pad, zIndex: 1 });
      Object.assign(S.inner.style, { paddingLeft: b.ipl, paddingRight: b.ipr });
      S.el.classList.add("split-leave");
      S.el.scrollTop = b.top;
      go(S.el, gone ? [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.985)" }]
        : [{ transform: "none", opacity: 1 }, { transform: `translate(${ux * b.box.width}px, ${uy * b.box.height}px)`, opacity: .35 }], { duration: gone ? 220 : 360 }, () => {
        S.el.classList.remove("split-leave");
        ["left", "right", "top", "bottom", "paddingTop", "zIndex"].forEach(k => S.el.style[k] = "");
        S.inner.style.paddingLeft = S.inner.style.paddingRight = "";
        if (sp.on) split.layout();  // it's back in a pane already: put its box back
      });
    }
    if (k0 && cbox()) {  // the message box glides under the chat in front; growing, it opens up from its old edges
      const k1 = cbox().getBoundingClientRect(), r = getComputedStyle(cbox()).borderRadius;
      const dy = k0.bottom - k1.bottom;
      if (k1.width <= k0.width + 1 || Math.abs(dy) > 1) {
        const dx = (k0.left + k0.right) / 2 - (k1.left + k1.right) / 2;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) go(comp, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }]);
      } else {
        go(cbox(), [{ transform: `translateX(${k0.left - k1.left}px)`, clipPath: `inset(0 ${k1.width - k0.width}px 0 0 round ${r})` },
                    { transform: "none", clipPath: `inset(0 0 0 0 round ${r})` }]);
      }
    }
    for (const n of parts()) {  // names, quiet boxes, empty panes and the lines between: the ones already up glide, new ones fade in
      const o = pb.get(n), r = n.getBoundingClientRect();
      if (!o) { go(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: wasOn ? 90 : 160, fill: "backwards", easing: "ease-out" }); continue; }
      const dx = o.left - r.left, dy = o.top - r.top, grow = n.classList.contains("split-grip") ? 0 : Math.max(0, r.width - o.width);
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || grow > 1)
        go(n, [{ transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(0 ${grow}px 0 0)` }, { transform: "none", clipPath: "inset(0 0 0 0)" }]);
    }
  }

  // Which chats a layout starts with: the ones it had last time if they're still open, else the panes you have now,
  // then the chat in front and your most recent other chats.
  function sidesFor(k) {
    const n = LAYOUTS[k].n, open = id => id && state.open.has(id);
    const mem = (sp.mem[k] || []).map(id => open(id) ? id : null);
    let sides = sp.on ? sp.sides.filter(open) : mem.filter(Boolean).length >= 2 ? mem : [];
    sides = sides.slice(0, n);
    while (sides.length < n) sides.push(null);
    if (state.active && !sides.includes(state.active)) {
      const i = sides.indexOf(null);
      if (i >= 0) sides[i] = state.active; else sides[0] = state.active;
    }
    const more = [...(sp.on ? mem.filter(Boolean) : []), ...byRecent().map(S => S.sid)].filter(id => !sides.includes(id));
    for (let i = 0; i < n; i++) if (!sides[i]) { const id = more.find(x => !sides.includes(x)); if (id) sides[i] = id; }
    return sides;
  }
  const tooNarrow = () => ($("#chats")?.clientWidth || 0) < THREE_MIN;
  function layoutBlock(k) {  // why a layout can't be picked right now, in a few words; "" when it can
    return k === "3" && tooNarrow() ? "window too narrow" : "";  // fewer open chats than panes is fine: the spare panes ask for a chat
  }

  const split = {
    isOn: () => sp.on,
    moving: () => moving,
    morph,
    has: sid => sp.on && sp.sides.includes(sid),
    toggle() { return sp.on ? split.off() : split.set("2"); },
    set(k) {  // from the Split button's menu
      if (!LAYOUTS[k]) return split.off();
      if (state.open.size < 2) return toast("Open a second chat first, then split.");
      if (layoutBlock(k)) return;
      if (sp.on && sp.layout === k) return;
      morph(() => {
        sp.sides = sidesFor(k); sp.layout = k; sp.on = true;
        for (const S of state.open.values()) S.el.hidden = !sp.sides.includes(S.sid);
        split.layout();
      });
    },
    async beside(s) {  // from a chat's menu: beside the chat in front, or one more pane in a split that's up
      const cur = state.active;
      if (!cur || cur === s.id) return;
      if (document.body.classList.contains("mini")) setMini(false);
      if (sp.on) {
        if (sp.sides.includes(s.id)) return activate(s.id);
        const gap = sp.sides.findIndex(id => !id || !state.open.has(id));
        if (gap >= 0) return assign(gap, s.id);
        const next = { "2": tooNarrow() ? "1+2" : "3", "3": "4", "1+2": "4" }[sp.layout];
        if (!next) return toast("The split is full. Click a pane's name to change its chat.");
        await openSession(s.id, s.cwd, s.title, true);
        if (!sp.on || !state.open.has(s.id)) return;
        return morph(() => { sp.sides = [...sp.sides.slice(0, LAYOUTS[next].n - 1), s.id]; sp.layout = next; activate(s.id); });
      }
      await openSession(s.id, s.cwd, s.title, true);  // loads behind the chat you're in, so nothing flashes
      if (!state.open.has(cur) || !state.open.has(s.id) || state.active !== cur) return;
      morph(() => { sp.sides = [cur, s.id]; sp.layout = "2"; sp.on = true; activate(s.id); });
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
    drop(sid) {  // that chat closed: its pane empties; with one chat left the split ends
      if (!split.has(sid)) return;
      sp.sides[sp.sides.indexOf(sid)] = null;
      if (sp.layout === "2" || real().filter(id => id !== sid).length < 2) sp.on = false;
      split.layout();
    },
    onActivate(sid, prev) {
      if (!sp.on) return;
      if (!sid || !state.open.has(sid)) { sp.on = false; return split.layout(); }
      if (!sp.sides.includes(sid)) {  // a chat from the sidebar takes the pane you were in (or the one you picked it for, or an empty one)
        let i = sp.target ?? sp.sides.indexOf(prev);
        if (i < 0) i = sp.sides.findIndex(id => !id || !state.open.has(id));
        sp.sides[Math.max(0, i)] = sid;
      }
      sp.target = null;
      split.layout();
    },
    layout() {
      const main = $("#main"), b = $("#split-btn"), chats = $("#chats");
      if (!main || !chats) return;
      const n = LAYOUTS[sp.layout].n;
      sp.sides = Array.from({ length: n }, (_, i) => { const id = sp.sides[i]; return id && state.open.has(id) && sp.sides.indexOf(id) === i ? id : null; });
      if (sp.on && real().length < 2) sp.on = false;
      main.classList.toggle("split", sp.on);
      for (const S of state.open.values()) if (!S.el.classList.contains("split-leave")) { S.el.classList.remove("split-p", "edge-l", "edge-t"); unbox(S.el); }
      if (b) { b.hidden = !(sp.on || state.open.size > 1) || document.body.classList.contains("mini"); b.innerHTML = sp.on ? IC.one + "<span>One chat</span>" : IC.split + "<span>Split</span>"; b.title = ""; }
      const R = sp.on ? paneRects() : [];
      heads.forEach((h, i) => { h.hidden = !sp.on || !sp.sides[i]; if (!h.hidden) { box(h, R[i]); h.style.bottom = ""; h.classList.toggle("edge-l", R[i][0] > 0); h.classList.toggle("edge-t", R[i][1] > 0); } });
      stubs.forEach((s, i) => { s.hidden = !sp.on || !sp.sides[i] || sp.sides[i] === state.active; if (!s.hidden) { box(s, R[i]); s.style.top = ""; s.style.bottom = `calc(${100 - R[i][3]}% + 12px)`; } });
      empties.forEach((e, i) => { e.hidden = !sp.on || i >= n || !!sp.sides[i]; if (!e.hidden) { box(e, R[i]); e.classList.toggle("edge-l", R[i][0] > 0); e.classList.toggle("edge-t", R[i][1] > 0); } });
      const g = sp.geo[sp.layout];
      grips.x.hidden = !sp.on; grips.x2.hidden = !sp.on || sp.layout !== "3"; grips.y.hidden = grips.c.hidden = !sp.on || g.y == null;
      if (!sp.on) { closePops(); place(); return; }
      grips.x.style.left = `calc(${g.x}% - 4px)`;
      if (g.x2) grips.x2.style.left = `calc(${g.x2}% - 4px)`;
      if (g.y != null) { grips.y.style.top = `calc(${g.y}% - 4px)`; grips.y.style.left = sp.layout === "1+2" ? g.x + "%" : "0"; grips.c.style.left = `calc(${g.x}% - 10px)`; grips.c.style.top = `calc(${g.y}% - 10px)`; }
      sp.sides.forEach((id, i) => {
        const S = id && state.open.get(id);
        if (!S) return;
        box(S.el, R[i]);
        S.el.classList.add("split-p"); S.el.classList.toggle("edge-l", R[i][0] > 0); S.el.classList.toggle("edge-t", R[i][1] > 0);
        S.el.hidden = false;
      });
      sp.mem[sp.layout] = sp.sides.slice();
      place();
      split.paint();
    },
    paint() {  // names, states, quiet boxes and empty panes: redrawn whenever a status changes
      if (!sp.on) return;
      sp.sides.forEach((id, i) => {
        const S = id && state.open.get(id), h = heads[i], t = stubs[i];
        if (!S) return paintEmpty(i);
        const st = liveStatus(S);
        h.classList.toggle("on", id === state.active);
        h.querySelector(".nm").textContent = S.title || "New session";
        h.querySelector(".st").innerHTML = `<span class="wt-dot ${st === "waiting" ? "warn" : st === "running" || st === "starting" ? "run" : st === "done" ? "ok" : st === "exited" ? "bad" : ""}"></span>${esc(STATUS_WORDS[st] || "")}`;
        const draft = (S.draft || "").trim().split("\n")[0];
        t.querySelector(".t").textContent = S.perms.size ? "Needs you" : draft || (going(S) ? "Queue a message" : "Message Claude");
        t.classList.toggle("warn", !!S.perms.size);
        t.classList.toggle("has", !!draft && !S.perms.size);
      });
    },
  };

  // The message box sits under the pane in front. It lives outside the chat area, so its place is worked out in pixels.
  let frame = null, frameWatch = null;
  function place() {
    const main = $("#main"), chats = $("#chats"), i = sp.sides.indexOf(state.active);
    if (!sp.on || i < 0) { ["--cl", "--cr", "--cb"].forEach(k => main.style.removeProperty(k)); return; }
    // where the chat area sits inside the main pane: measured once and kept until either changes size
    if (!frame) {
      const c = chats.getBoundingClientRect(), m = main.getBoundingClientRect();
      frame = { l: c.left - m.left - main.clientLeft, r: m.right - main.clientLeft - c.right, b: m.bottom - main.clientTop - c.bottom, w: c.width, h: c.height };
      if (!frameWatch && window.ResizeObserver) { frameWatch = new ResizeObserver(() => { frame = null; if (sp.on) place(); }); frameWatch.observe(chats); frameWatch.observe(main); addEventListener("resize", () => { frame = null; }); }
    }
    const [l, , r, b] = paneRects()[i], f = frame;
    main.style.setProperty("--cl", f.l + f.w * l / 100 + "px");
    main.style.setProperty("--cr", f.r + f.w * (100 - r) / 100 + "px");
    main.style.setProperty("--cb", f.b + f.h * (100 - b) / 100 + "px");
  }

  // Put a chat in a pane. One that's already in another pane swaps places with what was here.
  async function assign(i, sid) {
    const s = info(sid);
    if (!state.open.has(sid)) { if (!s) return; await openSession(sid, s.cwd, s.title, true); }
    if (!sp.on || !state.open.has(sid) || i >= LAYOUTS[sp.layout].n) return;
    morph(() => {
      const j = sp.sides.indexOf(sid);
      if (j >= 0 && j !== i) sp.sides[j] = sp.sides[i];
      sp.sides[i] = sid;
      for (const S of state.open.values()) if (!sp.sides.includes(S.sid)) S.el.hidden = true;
      activate(sid);
    });
  }
  function closePane(i) {
    const id = sp.sides[i], rest = sp.sides.filter((x, j) => j !== i && x && state.open.has(x));
    morph(() => {
      if (sp.layout === "2" || rest.length < 2) {
        split.off();
        const to = id === state.active ? rest[0] : state.active;
        if (to && state.open.has(to)) activate(to);
        return;
      }
      sp.sides[i] = null;
      const S = state.open.get(id);
      if (S) S.el.hidden = true;
      if (id === state.active) activate(rest[0], true); else split.layout();
    });
  }

  // chats to offer for a pane: the open ones first, then recent ones from the sidebar's list
  function chatChoices(q) {
    q = (q || "").trim().toLowerCase();
    const hit = t => !q || (t || "").toLowerCase().includes(q);
    const open = byRecent().filter(S => hit(S.title)).map(S => ({ id: S.sid, title: S.title || "New session", open: true, at: sp.sides.indexOf(S.sid) }));
    const recent = (state.sessions || []).filter(s => !state.open.has(s.id) && !s.archived && hit(s.title))
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, q ? 8 : 6).map(s => ({ id: s.id, title: s.title || "New session", open: false, at: -1 }));
    return { open, recent };
  }
  function paintEmpty(i) {
    const e = empties[i];
    if (!e || e.hidden) return;
    const { open, recent } = chatChoices(""), list = [...open.filter(c => c.at < 0), ...recent].slice(0, 6);
    const key = JSON.stringify(list.map(c => [c.id, c.title]));
    if (e.dataset.k === key) return;
    e.dataset.k = key; e.innerHTML = `<div class="t">Pick a chat for this pane</div>`;
    for (const c of list) { const r = el("button", "pk"); r.textContent = c.title; r.onclick = () => assign(i, c.id); e.appendChild(r); }
    const nw = el("button", "pk new"); nw.textContent = "New chat";
    nw.onclick = () => { const S = state.open.get(state.active); if (S) { sp.target = i; newSession(S.cwd); } };
    e.appendChild(nw);
  }

  // two small menus: the layouts (hover the Split button) and the chats for one pane (click its name)
  let pops = [];
  function closePops() {
    for (const p of pops) {
      if (still()) { p.remove(); continue; }
      p.style.pointerEvents = "none";
      p.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px) scale(.98)" }], { duration: 110, easing: "ease-in", fill: "forwards" }).onfinish = () => p.remove();
    }
    pops = [];
  }
  function popAt(node, anchor, alignRight) {
    document.body.appendChild(node); pops.push(node);
    const r = anchor.getBoundingClientRect(), w = node.offsetWidth, h = node.offsetHeight;
    node.style.left = Math.max(8, Math.min(innerWidth - w - 8, alignRight ? r.right - w : r.left)) + "px";
    node.style.setProperty("--ox", alignRight ? "100%" : "0%"); node.style.setProperty("--oy", "0%");
    node.style.top = Math.max(8, Math.min(innerHeight - h - 8, r.bottom + 6)) + "px";
    return node;
  }
  function layoutMenu() {
    closePops();
    const m = el("div", "popup menu split-menu");
    const row = (k, name, pic, cur, why) => {
      const r = el("div", "it" + (cur ? " cur" : "") + (why ? " off" : ""), `${PIC(pic)}<span class="a"></span>${why ? `<span class="b">${esc(why)}</span>` : ""}`);
      r.querySelector(".a").textContent = name;
      r.onclick = e => { e.stopPropagation(); if (why) return; closePops(); split.set(k); };
      m.appendChild(r);
    };
    row("1", "One chat", "", !sp.on, "");
    for (const k of ["2", "3", "1+2", "4"]) row(k, LAYOUTS[k].name, LAYOUTS[k].pic, sp.on && sp.layout === k, layoutBlock(k));
    return popAt(m, $("#split-btn"), true);
  }
  function chatMenu(i, anchor) {
    closePops();
    const m = el("div", "popup menu split-pick", `<input class="find" placeholder="Find a chat" spellcheck="false"><div class="list"></div>`);
    const list = m.querySelector(".list"), find = m.querySelector(".find");
    const draw = () => {
      const { open, recent } = chatChoices(find.value);
      list.innerHTML = "";
      const sec = (label, items) => {
        if (!items.length) return;
        list.appendChild(el("div", "hd", label));
        for (const c of items) {
          const here = c.at === i, r = el("div", "it" + (here ? " cur" : "") + (c.at >= 0 && !here ? " in" : ""), `<span class="a"></span>${c.at >= 0 && !here ? `<span class="b">swaps places</span>` : ""}`);
          r.querySelector(".a").textContent = c.title;
          r.onclick = e => { e.stopPropagation(); closePops(); if (!here) assign(i, c.id); };
          list.appendChild(r);
        }
      };
      sec("Open", open); sec("Recent", recent);
      if (!open.length && !recent.length) list.appendChild(el("div", "hd", "No chat by that name"));
    };
    find.oninput = draw;
    find.onkeydown = e => { e.stopPropagation(); if (e.key === "Escape") closePops(); if (e.key === "Enter") list.querySelector(".it:not(.cur)")?.click(); };
    draw();
    popAt(m, anchor, false);
    setTimeout(() => find.focus(), 30);
  }

  let heads = [], stubs = [], empties = [], grips = {};
  function wireSplit() {
    const chats = $("#chats"), main = $("#main");
    for (let i = 0; i < 4; i++) {
      const h = el("div", "split-head", `<button class="nmb" title="Change the chat in this pane"><span class="nm"></span><svg viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3"/></svg></button><span class="st"></span><span class="spacer"></span><button class="icb" title="Take this chat out of the split">${IC.no}</button>`);
      h.hidden = true;
      h.onclick = e => {
        const id = sp.sides[i];
        if (e.target.closest(".icb")) return closePane(i);
        if (e.target.closest(".nmb")) { e.stopPropagation(); return chatMenu(i, h.querySelector(".nmb")); }
        if (id && id !== state.active) activate(id, true);
      };
      chats.appendChild(h); heads.push(h);
      const s = el("button", "split-stub", `<span class="t"></span>`); s.hidden = true;
      s.onclick = () => { const id = sp.sides[i]; if (id) activate(id); };
      chats.appendChild(s); stubs.push(s);
      const e = el("div", "split-empty"); e.hidden = true;
      chats.appendChild(e); empties.push(e);
    }
    const grip = (key, horiz) => {
      const g = el("div", "split-grip" + (horiz ? " h" : "")); g.hidden = true; g.title = "Drag to resize";
      g.onmousedown = e => {
        e.preventDefault();
        const r = chats.getBoundingClientRect();
        const move = ev => {
          const G = sp.geo[sp.layout], p = horiz ? ((ev.clientY - r.top) / r.height) * 100 : ((ev.clientX - r.left) / r.width) * 100;
          const lo = key === "x2" ? G.x + 18 : sp.layout === "3" ? 18 : 25, hi = key === "x" && G.x2 ? G.x2 - 18 : sp.layout === "3" ? 82 : 75;
          G[key] = Math.max(lo, Math.min(hi, p));
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; split.layout(); tm.frame(); });
        };
        let raf = 0;
        const tm = timer.stream(`drag a pane line, split ${sp.layout}`);
        const up = () => { tm.end(); if (raf) { cancelAnimationFrame(raf); raf = 0; split.layout(); } document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); document.body.classList.remove("split-drag", "split-drag-h"); };
        document.body.classList.add(horiz ? "split-drag-h" : "split-drag");
        document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
      };
      g.ondblclick = () => morph(() => { sp.geo[sp.layout][key] = GEO[sp.layout][key]; split.layout(); });
      chats.appendChild(g); grips[key] = g;
    };
    grip("x"); grip("x2"); grip("y", true);
    {  // timing only: the window changing size (dragging its edge, or the mini window switch)
      let rz = null, quiet = 0;
      addEventListener("resize", () => {
        if (!rz) rz = timer.stream(document.body.classList.contains("mini-go") ? "mini window switch" : sp.on ? `window resize, split ${sp.layout}` : "window resize, one chat");
        const cur = rz;
        requestAnimationFrame(() => cur.frame());
        clearTimeout(quiet);
        quiet = setTimeout(() => { cur.end(); rz = null; }, 400);
      });
    }
    {  // where an up-down line meets a left-right one: drag it any way to move both at once
      const g = el("div", "split-grip c"); g.hidden = true; g.title = "Drag to resize both ways";
      g.onmousedown = e => {
        e.preventDefault(); e.stopPropagation();
        const r = chats.getBoundingClientRect(), lim = v => Math.max(25, Math.min(75, v));
        let raf = 0;
        const move = ev => {
          const G = sp.geo[sp.layout];
          G.x = lim(((ev.clientX - r.left) / r.width) * 100); G.y = lim(((ev.clientY - r.top) / r.height) * 100);
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; split.layout(); tm.frame(); });
        };
        const tm = timer.stream(`drag where the lines meet, split ${sp.layout}`);
        const up = () => { tm.end(); if (raf) { cancelAnimationFrame(raf); raf = 0; split.layout(); } document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); document.body.classList.remove("split-drag-c"); };
        document.body.classList.add("split-drag-c");
        document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
      };
      g.ondblclick = () => morph(() => { Object.assign(sp.geo[sp.layout], { x: GEO[sp.layout].x, y: GEO[sp.layout].y }); split.layout(); });
      chats.appendChild(g); grips.c = g;
    }
    const dropMark = el("div", "split-drop"); dropMark.hidden = true; chats.appendChild(dropMark);
    chats.addEventListener("mousedown", e => {  // a click anywhere in another pane brings that chat in front
      if (!sp.on) return;
      const c = e.target.closest(".chat"), S = c && [...state.open.values()].find(x => x.el === c);
      if (S && S.sid !== state.active) activate(S.sid, true);
    }, true);
    new ResizeObserver(() => { if (sp.on) place(); }).observe(chats);
    new ResizeObserver(() => { if (sp.on) place(); }).observe(main);

    // the Split button: a click is two side by side (or back to one chat); resting on it lists the layouts
    const btn = $("#split-btn");
    let showT = 0, hideT = 0;
    const menuUp = () => pops.some(p => p.classList.contains("split-menu"));
    const later = () => { clearTimeout(hideT); hideT = setTimeout(() => { if (menuUp() && !btn.matches(":hover") && !pops.some(p => p.matches(":hover"))) closePops(); }, 260); };
    let clicked = 0;
    const arm = () => {
      clearTimeout(hideT);
      if (showT || menuUp() || Date.now() - clicked < 500) return;
      showT = setTimeout(() => { showT = 0; if (btn.matches(":hover") && !menuUp()) { const m = layoutMenu(); m.onmouseleave = later; m.onmouseenter = () => clearTimeout(hideT); } }, 180);
    };
    btn.onclick = () => { clearTimeout(showT); showT = 0; clicked = Date.now(); closePops(); split.toggle(); };
    btn.onmouseenter = arm;
    btn.onmousemove = arm;  // also after a click, once the mouse moves on the button again
    btn.onmouseleave = () => { clearTimeout(showT); showT = 0; later(); };
    document.addEventListener("mousedown", e => { if (pops.length && !e.target.closest(".split-menu, .split-pick, #split-btn, .split-head .nmb")) closePops(); }, true);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && pops.length) closePops(); });

    // drag a chat from the sidebar onto a pane
    $("#side").addEventListener("pointerdown", e => {
      const row = e.target.closest(".sess[data-sid]");
      if (!sp.on || !row || e.button !== 0 || e.target.closest("button, input, textarea, [contenteditable]")) return;
      const sid = row.dataset.sid, x0 = e.clientX, y0 = e.clientY, pid = e.pointerId, edge = $("#side").getBoundingClientRect().right;
      let ghost = null, at = -1;
      const paneAt = ev => {
        const c = chats.getBoundingClientRect(), px = ((ev.clientX - c.left) / c.width) * 100, py = ((ev.clientY - c.top) / c.height) * 100;
        return paneRects().findIndex(([l, t, r, b]) => px >= l && px < r && py >= t && py < b);
      };
      const move = ev => {
        if (ev.pointerId !== pid) return;
        if (!ghost) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8 || ev.clientX <= edge) return;
          ghost = el("div", "split-ghost", "<span></span>"); ghost.firstChild.textContent = row.querySelector(".t")?.textContent || "Chat";
          document.body.appendChild(ghost); document.body.classList.add("pane-dragging"); window.__paneDrag = true;
        }
        ev.preventDefault();
        ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 10}px)`;
        at = sp.on ? paneAt(ev) : -1;
        dropMark.hidden = at < 0;
        if (at >= 0) box(dropMark, paneRects()[at]);
      };
      const up = ev => {
        if (ev.pointerId !== pid) return;
        removeEventListener("pointermove", move, true); removeEventListener("pointerup", up, true); removeEventListener("pointercancel", up, true);
        if (!ghost) return;
        ghost.remove(); dropMark.hidden = true; document.body.classList.remove("pane-dragging");
        setTimeout(() => { window.__paneDrag = false; }, 0);
        if (at >= 0 && sp.on && ev.type === "pointerup") assign(at, sid);
      };
      addEventListener("pointermove", move, true); addEventListener("pointerup", up, true); addEventListener("pointercancel", up, true);
    });
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
    const chats = [...state.open.values()].filter(S => S.status !== "new").map(window.reopenEntry);
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
  // The sentence for one thing it waits for: [before the name, after it]. No name for "You".
  function restartWhy(c) {
    const w = c.why || "", many = /^([2-9]|\d\d)/.test(w);
    if (!c.sid) return ["a minute after you stop typing", ""];
    if (w === "replying") return ["when ", " finishes replying"];
    if (w === "needs your answer") return ["once you answer ", ""];
    if (/job.* running$/.test(w)) return ["when ", many ? "'s jobs finish" : "'s job finishes"];
    if (/agent.* running$/.test(w)) return ["when ", many ? "'s agents finish" : "'s agent finishes"];
    if (w === "following up on a job") return ["when ", " finishes following up on a job"];
    if (w === "message not sent") return ["once you send or clear your message in ", ""];
    return ["when ", ` is done (${w})`];
  }
  function paintRestartList(line) {
    const box = line.querySelector(".rl-list"), t = line.querySelector(".t"), up = rs.mode === "update";
    const one = rs.chats.length === 1 ? rs.chats[0] : null, list = one ? [] : rs.chats.slice(0, 4);
    const key = JSON.stringify(rs.chats.slice(0, 4)) + rs.chats.length + state.active + rs.mode + [...state.open.values()].map(S => S.title).join("|");
    if (box.dataset.k === key) return;
    box.dataset.k = key; box.innerHTML = ""; t.textContent = "";
    line.querySelector(".rl-cancel span").textContent = up ? "Cancel update" : "Cancel restart";
    const lead = `Tether will ${up ? "update" : "restart"} `;
    if (!rs.chats.length) t.textContent = up ? "Updating Tether…" : "Restarting Tether…";
    else if (one) {
      const [a, z] = restartWhy(one);
      t.append(lead + a);
      if (one.sid) {
        const b = el("b", state.open.has(one.sid) ? "go" : "");
        b.textContent = (state.open.get(one.sid)?.title) || one.title;
        if (state.open.has(one.sid)) { b.title = "Go to this chat"; b.onclick = () => activate(one.sid); }
        t.append(b);
      }
      t.append(z + ".");
    } else {
      const chats = rs.chats.every(c => c.sid), b = el("b");
      b.textContent = chats ? `${rs.chats.length} chats` : `${rs.chats.length} things`;
      t.append(lead + (chats ? "when these " : "after these "), b, chats ? " finish." : " are done.");
    }
    for (const c of list) {
      const b = el(c.sid ? "button" : "div", "rl-row" + (c.sid ? "" : " you"), `<span class="wt-dot ${c.why === "needs your answer" ? "warn" : "run"}"></span><span class="nm"></span><span class="why"></span>`);
      b.querySelector(".nm").textContent = (state.open.get(c.sid)?.title) || c.title;
      b.querySelector(".why").textContent = c.why;
      b.title = c.sid ? `${b.querySelector(".nm").textContent} · ${c.why}. Go to this chat` : `${b.querySelector(".nm").textContent} · ${c.why}`;
      b.onclick = () => { if (state.open.has(c.sid)) activate(c.sid); };
      box.appendChild(b);
    }
    if (!one && rs.chats.length > list.length) box.appendChild(el("div", "rl-more", `and ${rs.chats.length - list.length} more`));
  }
  function restartDialog(changed) {
    const n = busyChats().length;
    if (rs.waiting) {
      // the same plain sentence as the block in the sidebar, from the same list, so it names the chat and why
      const up = rs.mode === "update", verb = up ? "update" : "restart", tail = ", then reopen your chats.";
      const box = openModal(`<h2>${up ? "Update" : "Restart"} is waiting</h2><p class="modal-p"></p><div class="rl-list"></div>
        <div class="modal-acts"><button class="btn ghost" data-k="stop">Cancel ${verb}</button><button class="btn primary" data-close>Keep waiting</button></div>`);
      const t = box.querySelector(".modal-p"), nm = c => (state.open.get(c.sid)?.title) || c.title, bold = x => { const e = el("b"); e.textContent = x; return e; };
      const cs = rs.chats.length ? rs.chats : null;
      if (!cs) t.textContent = `Tether will ${verb} when ${n === 1 ? "1 chat finishes" : n ? `${n} chats finish` : "your chats are idle"}${tail}`;
      else if (cs.length === 1) {
        const [x, z] = restartWhy(cs[0]);
        t.append(`Tether will ${verb} ${x}`);
        if (cs[0].sid) t.append(bold(nm(cs[0])));
        t.append(z + tail);
      } else {
        const chats = cs.every(c => c.sid);
        t.append(`Tether will ${verb} ${chats ? "when these " : "after these "}`, bold(`${cs.length} ${chats ? "chats" : "things"}`), (chats ? " finish" : " are done") + tail);
        for (const c of cs.slice(0, 6)) {
          const r = el("div", "rl-row you", `<span class="wt-dot ${c.why === "needs your answer" ? "warn" : "run"}"></span><span class="nm"></span><span class="why"></span>`);
          r.querySelector(".nm").textContent = nm(c); r.querySelector(".why").textContent = c.why;
          box.querySelector(".rl-list").appendChild(r);
        }
        if (cs.length > 6) box.querySelector(".rl-list").appendChild(el("div", "rl-more", `and ${cs.length - 6} more`));
      }
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
  let changed = null;  // the last answer: {notes, files} a restart would load
  async function checkChanged() {
    const r = await api().code_changed().catch(() => null);
    const b = $("#restart-btn");
    changed = r?.changed ? r : null;
    if (b) b.hidden = !r?.changed;
    if (r?.changed && r.pushed) autoCheck("restart");  // on its own only once the change is on GitHub, not mid-edit
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
    pushPanel();
    split.layout();
    const line = $("#restart-line"), k = rs.chats.length;
    line.hidden = !rs.waiting;
    if (rs.waiting) {
      const up = rs.mode === "update";
      paintRestartList(line);
    }
    $("#restart-btn").classList.toggle("wait", rs.waiting);
  }
  // ---------- the floating panel (panel.py) ----------
  // While Tether is in the Dock or behind another app, the same list floats over the app you're in, with buttons.
  // It includes the chat in front, since you aren't looking at it then. Python shows and hides it.
  const ICON_OPEN = { label: "Open chat", act: "open", primary: true, icon: "open" };
  function panelList() {
    for (const S of state.open.values()) if (!S.jobFailed) delete S.jobAt;
    return waitingItems(true).map(x => {
      const S = x.S, base = { id: x.id, sid: S.sid, title: S.title || "New session", at: x.at || Date.now() };
      if (x.ev) {
        const ev = x.ev;
        if (ev.kind === "question") return { ...base, kind: "Question", cat: "ask", text: (ev.questions || []).map(z => z.question).join(" · "), buttons: [ICON_OPEN] };
        if (ev.kind === "plan") return { ...base, kind: "Plan", cat: "perm", text: "A plan is ready for you to review.", buttons: [ICON_OPEN] };
        const bash = ev.tool === "Bash", first = ((ev.detail || "").split(/\s+/)[0] || "").slice(0, 24), d = ev.detail || "";
        return { ...base, kind: "Permission", cat: "perm", text: bash ? "Run this command?" : `Allow ${ev.label}?`, detail: d.length > 600 ? d.slice(0, 600) + "…" : d,
          buttons: [{ label: bash ? "Run" : "Allow", act: "allow", primary: true, icon: "yes" },
            ...(ev.guarded ? [] : [{ label: bash ? `Always allow “${first}” here` : "Always allow here", act: "always" }]),
            { label: "Deny", act: "deny", ghost: true, icon: "no" }] };
      }
      if (x.handoff) {
        const h = x.handoff;
        return { ...base, kind: `Handoff from ${h.from_title}`, cat: "handoff", text: h.text.replace(/\s+/g, " ").slice(0, 320),
          buttons: [{ label: "Send", act: "send", primary: true, icon: "send" }, { label: "Edit", act: "edit", icon: "pen" }, { label: "Dismiss", act: "dismiss", ghost: true }] };
      }
      if (x.ask) return { ...base, kind: "Question", cat: "ask", text: x.ask.q, reply: true,
        buttons: x.ask.answers.map((a, i) => { const m = /^(\d{1,2}|[A-Z])[.:)]?\s+(.+)$/.exec(a); return { label: m ? m[2] : a, n: m ? m[1] : "", act: "say", text: a, primary: i === 0 }; }) };
      if (x.kind === "Job failed") return { ...base, at: (S.jobAt ||= Date.now()), kind: "Job failed", cat: "job", text: x.text, buttons: [{ label: "Seen", act: "seen" }] };
      return { ...base, kind: "Finished", cat: "done", text: x.text, buttons: [{ label: "Seen", act: "seen" }] };
    });
  }
  let panelSent = "";
  function pushPanel() {
    if (!ready) return;
    const list = panelList(), key = JSON.stringify(list);
    if (key === panelSent) return;
    panelSent = key;
    api().panel_items?.(list)?.catch?.(() => { panelSent = ""; });
  }
  function panelAct(ev) {  // a button in the floating panel (Open chat is done by Python)
    const x = waitingItems(true).find(i => i.id === ev.id);
    if (!x) return;
    const S = x.S;
    if (["allow", "always", "deny"].includes(ev.act) && x.rid) answer(S, x.rid, ev.act);
    else if (ev.act === "say" && ev.text) quickSend(S, ev.text);
    else if (ev.act === "send" && x.handoff) sendHandoff(S, x.handoff);
    else if (ev.act === "dismiss" && x.handoff) doneHandoff(S, x.handoff, "Dismissed");
    else if (ev.act === "edit" && x.handoff) editHandoff(S, x.handoff);
    else if (ev.act === "seen") { if (x.kind === "Job failed") S.jobFailed = false; else S.unseen = false; }
    sync();
  }
  function backInFront() {  // you came back to Tether: what's on screen counts as seen
    for (const sid of sp.on ? sp.sides : [state.active]) {
      const S = state.open.get(sid);
      if (!S) continue;
      S.unseen = false;
      if (S.ask) S.ask.seen = true;
    }
    sync();
  }

  function init() {
    ready = true;
    addEventListener("focus", backInFront);
    setInterval(pushPanel, 2000);  // approvals and job ends don't all pass through sync()
    wireSplit();
    $("#waiting-row").onclick = () => waitOpen ? closeWaiting() : openWaiting();
    $("#restart-line .rl-cancel").onclick = cancelRestart;
    $("#restart-btn").onclick = () => restartDialog(true);
    setTimeout(loadHandoffs, 2500);  // unsent ones from before a restart
    setInterval(loadHandoffs, 30000);
    setTimeout(checkChanged, 20000);
    setInterval(checkChanged, 60000);
    setInterval(() => { if (waitOpen) renderWaiting(); }, 30000);
    sync();
  }

  return { init, sync, autoCheck, loadHandoffs, handoffDialog, turnEnd, userSpoke, fromHistory, carryAsk, quickSend, openWaiting, closeWaiting, split, PICK_JS, onPick, restartDialog, panelAct, changed: () => changed, restartWaiting: () => rs.waiting, timer };
})();
