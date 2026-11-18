// Instructions for one chat: the message box button opens a card that grows out of the box's top edge (the side
// question's shape, on the left). What you save applies to this chat only, from your next message, and carries over
// fresh starts word for word (set_instructions in workbench.py). Each chat keeps its own card and unsaved text.
window.Instruct = (() => {
  const IC = {
    doc: `<svg viewBox="0 0 24 24"><path d="M7 3.5h7.5L18 7v13.5H7z"/><path d="M10 11h5M10 14.5h5M10 18h2.5"/></svg>`,
    x: `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  };
  const $ = id => document.getElementById(id);
  const st = S => (S.ins ||= { text: "", draft: null, open: false });
  const cur = () => state.open.get(state.active);
  let watching = false;

  function build() {
    $("ins-wrap").innerHTML = `<div class="sq-w ins-w gone" id="ins-w" hidden><span class="sq-fil l"></span><span class="sq-fil r"></span>
      <div class="sq-pop" id="ins-pop"><div class="sq-pc" id="ins-pc">
        <div class="sq-h"><span class="sq-tag">${IC.doc}Instructions for this chat</span>
          <button class="sq-ib" data-a="close" title="Close (Esc)">${IC.x}</button></div>
        <div class="sq-field ins-field"><textarea id="ins-in" rows="3" placeholder="How Claude should work in this chat" spellcheck="true"></textarea></div>
        <div class="ins-ft"><button class="btn small primary" data-a="save" title="Save (⌘Return)">Save</button><button class="btn small ghost" data-a="close">Cancel</button>
          <span class="spacer"></span><button class="btn small ghost" data-a="clear" id="ins-clear">Clear</button></div>
      </div></div></div>`;
    $("ins-pc").addEventListener("click", e => {
      const b = e.target.closest("[data-a]"), S = cur(); if (!b || !S) return;
      ({ save: () => save(S, $("ins-in").value), close: () => close(S), clear: () => save(S, "") })[b.dataset.a]?.();
    });
    const i = $("ins-in");
    i.addEventListener("input", () => { const S = cur(); if (S) st(S).draft = i.value; grow(); fit(); });
    i.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.metaKey) { e.preventDefault(); const S = cur(); if (S) save(S, i.value); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); const S = cur(); if (S) close(S, true); }
    });
  }
  const grow = () => { const i = $("ins-in"); i.style.height = "auto"; i.style.height = Math.max(66, Math.min(i.scrollHeight, 220)) + "px"; };
  // clear of the box's rounded corners, like the side question (.ins-w sits 36px from the left)
  const popW = () => { const b = document.querySelector("#composer .composer-box"); return Math.max(200, Math.min(420, (b?.clientWidth || 600) - 72)); };
  function fit(instant) {
    const S = cur(), w = $("ins-w"); if (!w) return;
    const on = !!S && st(S).open, pop = $("ins-pop"), pc = $("ins-pc"), W = popW();
    pc.style.width = W + "px";
    if (instant) pop.classList.add("sq-still");
    pop.style.width = (on ? W : Math.min(W, 150)) + "px"; pop.style.height = (on ? pc.offsetHeight : 0) + "px";
    pop.classList.toggle("is-open", on);
    w.classList.toggle("gone", !on);
    $("composer").classList.toggle("ins-on", on);
    if (instant) { pop.offsetWidth; pop.classList.remove("sq-still"); }
  }
  function mark(S) {  // the dot on the button: this chat has instructions
    const b = $("ins-btn"); if (!b) return;
    const has = !!S && !!st(S).text;
    b.classList.toggle("has", has); b.classList.toggle("on", !!S && st(S).open);
    b.title = has ? "This chat's instructions" : "Instructions for this chat";
  }
  function draw(S, instant) {
    const q = st(S), w = $("ins-w");
    if (q.open) {
      w.hidden = false;
      $("ins-in").value = q.draft ?? q.text;
      $("ins-clear").hidden = !q.text;
      grow();
    }
    fit(instant);
    mark(S);
  }

  function open(S) {
    if (!S) return;
    if (!$("ins-w")) build();
    if (state.active !== S.sid) activate(S.sid, true);
    const q = st(S);
    if (S.sq?.mode === "open") SideQ.minimize(S);  // one card at a time on the box
    if (!watching && $("sq-pop")) {  // and the other way round: a side question opening puts this one away, text kept
      watching = true;
      new MutationObserver(() => { const A = cur(); if (A && st(A).open && $("sq-pop").classList.contains("is-open")) close(A, true); })
        .observe($("sq-pop"), { attributes: true, attributeFilter: ["class"] });
    }
    q.open = true;
    draw(S);
    setTimeout(() => { const i = $("ins-in"); i.focus({ preventScroll: true }); i.setSelectionRange(i.value.length, i.value.length); }, 60);
  }
  function close(S, keep) {  // keep: the unsaved text stays for when the card opens again
    const q = st(S);
    if (!q.open) return;
    q.open = false; if (!keep) q.draft = null;
    draw(S);
    setTimeout(() => { const A = cur(); if ((!A || !st(A).open) && $("ins-w")) $("ins-w").hidden = true; }, 450);
    $("input")?.focus({ preventScroll: true });
  }
  const toggle = S => { if (S) st(S).open ? close(S, true) : open(S); };
  async function save(S, text) {
    const q = st(S), was = q.text;
    text = (text || "").trim();
    q.draft = null;
    if (text === was) return close(S);
    const line = !text ? "Instructions cleared" : was ? "Instructions changed" : "Instructions set";
    const last = S.inner.lastElementChild?.classList.contains("ins-line") ? S.inner.lastElementChild : null;
    q.text = text;
    close(S);
    last?.remove();  // several saves in a row: one line, updated
    add(S, switchLine(line));
    const r = await api().set_instructions(S.sid, text, line, !!last);
    if (!r || r.error) { q.text = was; mark(S); toast(r?.error || "Couldn't save the instructions.", "error"); }
  }
  // another chat came to the front: its own card as it was, without motion
  function show(S) {
    if (!$("ins-w")) build();
    if (!S) { $("ins-w").hidden = true; $("composer").classList.remove("ins-on"); mark(null); return; }
    const q = st(S);
    if (!q.open) { $("ins-w").hidden = true; $("ins-pop").classList.remove("is-open"); $("ins-w").classList.add("gone"); $("composer").classList.remove("ins-on"); mark(S); return; }
    draw(S, true);
  }
  window.addEventListener("resize", () => { const S = cur(); if (S && st(S).open) fit(true); });
  return { show, open, close, toggle, text: S => st(S).text };
})();
