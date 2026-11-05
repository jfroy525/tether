// The working line's little animation: a runner hopping and flipping over code glyphs, or a ninja slicing them.
// Each jump or cut picks a random trick. One canvas per working line; colours follow the theme (read from the
// CSS tokens); it stops itself when removed and pauses while its chat isn't on screen.
(function () {
  const W = 200, H = 54, G = 48, X = 40;           // canvas size, ground line, where the figure runs (CSS px)
  const GRAV = 1100, JUMP = 215, BIG = 240, SPEED = 85;
  const GLYPHS = ["{ }", "</>", "λ", "#", "[ ]", "=>", "$_", "*", "&&", "//"];
  const TAU = Math.PI * 2;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const weighted = list => { let r = Math.random() * list.reduce((n, [, w]) => n + w, 0); for (const [k, w] of list) if ((r -= w) <= 0) return k; return list[0][0]; };
  const ease = p => p < 0 ? 0 : p > 1 ? 1 : p * p * (3 - 2 * p);

  function colours() {
    const cs = getComputedStyle(document.body);
    const v = n => cs.getPropertyValue(n).trim();
    return { fig: v("--text-2") || "#bbb", dim: v("--text-3") || "#777", line: v("--line-2") || "#333", accent: v("--accent") || "#3aa",
             mono: v("--mono") || "ui-monospace, Menlo, monospace" };
  }

  // A stick figure, feet at (x, y). phase drives the stride.
  // pose: run | air | tuck | star | ninja | ninja-air | slash
  function figure(c, x, y, phase, pose, col, t, ninja) {
    const lean = ninja && (pose === "run" || pose === "slash") ? 3.2 : pose === "run" ? 1.4 : 0.6;
    const hip = [x, y - 8.6], sh = [x + lean, y - 15.2], head = [x + lean + 1.2, y - 19.4];
    c.strokeStyle = col.fig; c.fillStyle = col.fig; c.lineWidth = 1.7; c.lineCap = "round"; c.lineJoin = "round";
    const limb = (from, ang, bend, l1, l2) => {
      const k = [from[0] + Math.sin(ang) * l1, from[1] + Math.cos(ang) * l1];
      const f = [k[0] + Math.sin(ang + bend) * l2, k[1] + Math.cos(ang + bend) * l2];
      c.beginPath(); c.moveTo(from[0], from[1]); c.lineTo(k[0], k[1]); c.lineTo(f[0], f[1]); c.stroke();
    };
    // legs
    for (let i = 0; i < 2; i++) {
      const p = phase + i * Math.PI;
      if (pose === "tuck") limb(hip, i ? 1.9 : 1.6, -2.7, 4.6, 4.4);          // knees to the chest
      else if (pose === "star") limb(hip, i ? 0.75 : -0.75, 0, 4.6, 4.6);      // legs spread
      else if (pose === "air" || pose === "ninja-air") limb(hip, i ? 0.9 : -0.35, i ? -1.5 : -0.9, 4.6, 4.6);
      // forward swing (sin rising, cos > 0): knee lifts; back swing: leg straight and planted, pushing off
      else limb(hip, Math.sin(p) * 0.8, -(0.2 + Math.max(0, Math.cos(p)) * 1.25), 4.6, 4.6);
    }
    c.beginPath(); c.moveTo(hip[0], hip[1]); c.lineTo(sh[0], sh[1]); c.stroke();
    // arms
    if (pose === "slash") limb(sh, 1.9, -0.25, 4.2, 4);
    else if (pose === "star") { limb(sh, 2.3, 0.2, 4.2, 3.8); limb(sh, -2.3, -0.2, 4.2, 3.8); }
    else if (pose === "tuck") { limb(sh, 1.2, 1.2, 4, 3.4); limb(sh, 0.9, 1.4, 4, 3.4); }
    else if (ninja) for (let i = 0; i < 2; i++) limb(sh, -2.35 + i * 0.22 + Math.sin(phase * 2) * 0.05, 0.25, 4.2, 3.8);
    else for (let i = 0; i < 2; i++) limb(sh, -Math.sin(phase + i * Math.PI) * 0.85, 1.0, 4, 3.4);
    c.beginPath(); c.arc(head[0], head[1], 3.1, 0, TAU); c.fill();
    if (ninja) {  // headband with two tails streaming back
      c.strokeStyle = col.accent; c.lineWidth = 1.3;
      c.beginPath(); c.moveTo(head[0] - 3, head[1] - 0.6); c.lineTo(head[0] + 3, head[1] - 0.6); c.stroke();
      for (let k = 0; k < 2; k++) {
        c.beginPath(); c.moveTo(head[0] - 3, head[1] - 0.4);
        for (let s = 1; s <= 6; s++) c.lineTo(head[0] - 3 - s * 1.5, head[1] - 0.4 + k * 1.6 + Math.sin(t * 16 + s * 0.9 + k) * (0.35 * s * 0.5));
        c.stroke();
      }
      if (pose !== "slash") {  // sword on the back
        c.strokeStyle = col.dim; c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(sh[0] - 4.5, sh[1] - 3); c.lineTo(sh[0] + 2.5, sh[1] + 4.5); c.stroke();
      }
    }
  }

  function create(kind) {
    const cv = document.createElement("canvas");
    cv.className = "work-anim";
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    const c = cv.getContext("2d");
    const ninja = kind === "ninja";
    let col = colours(), colAt = 0, last = 0, t = 0, dist = 0, raf = 0, stopped = false;
    let y = 0, vy = 0, airT = 0, airDur = 0, trick = "hop";   // jumping
    let floor = 0;                                           // 9 while running along the top of a long word, else 0
    let cut = null;                                          // a ninja strike in progress: {kind, t, dur}
    let things = [], bits = [], dust = [], ghosts = [], nextGap = rnd(40, 90);

    function spawn() {
      const flying = ninja && Math.random() < 0.6;
      c.font = `600 10.5px ${col.mono}`;
      const g = c.canvas.__glyph?.() || pick(GLYPHS), w = c.measureText(g).width;
      things.push({ x: W + 8, g, w, fly: flying, hy: flying ? rnd(14, 19) : 0, bob: rnd(0, 6), hit: false });
      nextGap = rnd(ninja ? 75 : 95, ninja ? 160 : 200);
    }
    const onGround = () => y === floor && vy === 0;
    const LONG = 24;  // words wider than a jump: hop up onto them and run along the top
    function jump(v, kindOf) { vy = v; airT = 0; airDur = 2 * v / GRAV; trick = kindOf; }

    function slice(o) {
      o.hit = true;
      const cy = G - o.hy;
      const pieces = cut && cut.kind === "cross" ? [[0, -1], [0, 1], [1, -1], [1, 1]] : [[0, 0], [1, 0]];
      for (const [half, side] of pieces)
        bits.push({ x: o.x + (side > 0 ? o.w / 2 : 0), y: cy, g: o.g, w: o.w, half, side, vx: -SPEED * 0.3 + (half ? 25 : 8) + side * 18,
          vy: half ? 40 : -120 - Math.random() * 40, r: 0, vr: (half ? 5 : -7) * (side || 1), life: 0.75 });
      for (let k = 0; k < 6; k++) dust.push({ x: o.x + o.w / 2, y: cy, vx: rnd(-50, 80), vy: rnd(-100, 30), life: 0.4, accent: true });
    }

    function step(dt) {
      t += dt; dist += SPEED * dt;
      for (const o of things) o.x -= SPEED * dt * (o.fly ? 1.35 : 1);
      things = things.filter(o => o.x > -30 && !o.hit);
      const was = floor;
      floor = things.some(o => !o.fly && o.w > LONG && o.x - 3 <= X && X <= o.x + o.w + 1) ? 9 : 0;
      if (floor < was && onGround() === false && vy === 0) { trick = "hop"; airT = 0; airDur = 0.25; }  // ran off the end: drop down
      const lastX = things.length ? Math.max(...things.map(o => o.x + o.w)) : -1e9;
      if (W - lastX > nextGap) spawn();
      const dx = cut && cut.kind === "dash" ? Math.sin(Math.PI * Math.min(1, cut.t / cut.dur)) * 26 : 0;
      for (const o of things) {
        const mid = o.x + o.w / 2;
        if (!o.fly && onGround() && !cut) {  // jump it, maybe with a trick
          const tk = weighted(ninja ? [["flip", 45], ["hop", 30], ["back", 25]] : [["hop", 30], ["flip", 22], ["back", 14], ["star", 18], ["spin", 16]]);
          const v = tk === "hop" ? JUMP : BIG;
          const near = o.w > LONG ? o.x + 6 - X : mid - X;  // long word: come down on its front end
          if (near > 0 && near <= SPEED * (v / GRAV)) jump(v, tk);
        }
        if (o.fly && !o.hit && !cut) {  // pick a strike once it's close enough for that strike
          const want = o.want || (o.want = weighted([["slice", 35], ["spin", 25], ["dash", 22], ["cross", 18]]));
          const reach = want === "dash" ? 36 : want === "spin" ? 22 : 12;
          if (o.x - X < reach) {
            cut = { kind: want, t: 0, dur: want === "dash" ? 0.24 : want === "spin" ? 0.42 : 0.2, target: o, done: false };
            if (want === "spin" && onGround()) jump(BIG, "spinslash");
            else if (want !== "dash" && onGround()) jump(120, "hop");
          }
        }
      }
      if (cut) {
        cut.t += dt;
        const p = cut.t / cut.dur, o = cut.target;
        if (cut.kind === "dash") ghosts.push({ dx, y, life: 0.18 });
        if (!cut.done && (p >= (cut.kind === "spin" ? 0.45 : 0.4) || (cut.kind === "dash" && X + dx >= o.x - 2))) { slice(o); cut.done = true; }
        if (p >= 1) { if (!cut.done) slice(o); cut = null; }
      }
      if (y > floor || vy !== 0) {
        y += vy * dt; vy -= GRAV * dt; airT += dt;
        if (y <= floor && vy <= 0) { y = floor; vy = 0; for (let k = 0; k < 3; k++) dust.push({ x: X + rnd(-3, 3), y: G - floor, vx: rnd(-50, -20), vy: rnd(-30, -10), life: 0.3 }); }
      }
      for (const b of bits) { b.x += b.vx * dt; b.y += b.vy * dt; b.vy += 600 * dt; b.r += b.vr * dt; b.life -= dt; }
      bits = bits.filter(b => b.life > 0);
      for (const d of dust) { d.x += d.vx * dt; d.y += d.vy * dt; d.vy += 300 * dt; d.life -= dt; }
      dust = dust.filter(d => d.life > 0);
      for (const g of ghosts) g.life -= dt;
      ghosts = ghosts.filter(g => g.life > 0);
      return dx;
    }

    // body rotation / squash for the trick in progress
    function trickPose() {
      const air = y > floor + 0.5, p = airDur ? airT / airDur : 0;
      if (!air) return { rot: 0, sx: 1, pose: ninja ? (cut && cut.kind !== "spin" ? "slash" : "run") : "run" };
      switch (trick) {
        case "flip": return { rot: TAU * ease(p), sx: 1, pose: p > 0.15 && p < 0.85 ? "tuck" : "air" };
        case "back": return { rot: -TAU * ease(p), sx: 1, pose: p > 0.15 && p < 0.85 ? "tuck" : "air" };
        case "star": return { rot: 0, sx: 1, pose: p > 0.2 && p < 0.8 ? "star" : "air" };
        case "spin": return { rot: 0, sx: Math.cos(TAU * ease(p)), pose: "star" };          // a pirouette in the air
        case "spinslash": return { rot: TAU * ease(Math.min(1, cut ? cut.t / cut.dur : p)), sx: 1, pose: "slash" };
        default: return { rot: 0, sx: 1, pose: ninja ? (cut ? "slash" : "ninja-air") : "air" };
      }
    }

    function draw(dx) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      c.strokeStyle = col.line; c.lineWidth = 1;
      const off = dist % 9;
      c.beginPath();
      for (let x = -off; x < W; x += 9) { c.moveTo(x, G + 0.5); c.lineTo(x + 5, G + 0.5); }
      c.stroke();
      c.font = `600 10.5px ${col.mono}`; c.textBaseline = "alphabetic";
      for (const o of things) {
        c.fillStyle = o.fly ? col.fig : col.dim;
        c.fillText(o.g, o.x, o.fly ? G - o.hy + 4 + Math.sin(t * 5 + o.bob) * 1.2 : G - 1.5);
      }
      for (const b of bits) {  // pieces of a sliced glyph
        c.save(); c.globalAlpha = Math.max(0, b.life / 0.75);
        c.translate(b.x + b.w / 2, b.y); c.rotate(b.r);
        c.beginPath();
        if (b.side) c.rect(b.side < 0 ? -b.w : 0, b.half ? 0 : -10, b.w, 10); else c.rect(-b.w, b.half ? 0 : -10, b.w * 2, 10);
        c.clip(); c.fillStyle = col.fig; c.fillText(b.g, -b.w / 2, 4); c.restore();
      }
      for (const d of dust) { c.globalAlpha = Math.max(0, d.life / 0.4); c.fillStyle = d.accent ? col.accent : col.dim; c.fillRect(d.x, d.y, 1.6, 1.6); }
      c.globalAlpha = 1;
      const tp = trickPose(), phase = dist / 6.5;
      for (const g of ghosts) {  // dash afterimages
        c.globalAlpha = g.life / 0.18 * 0.35;
        figure(c, X + g.dx, G - g.y, phase, "slash", col, t, true);
      }
      c.globalAlpha = 1;
      const fx = X + dx, fy = G - y, cx = fx + 1, cy = fy - 11;
      c.save();
      c.translate(cx, cy); c.rotate(tp.rot); c.scale(Math.abs(tp.sx) < 0.08 ? 0.08 * Math.sign(tp.sx || 1) : tp.sx, 1); c.translate(-cx, -cy);
      figure(c, fx, fy, phase, tp.pose, col, t, ninja);
      c.restore();
      if (cut) {  // the blade: an arc, a full circle for the spin, a streak for the dash, an X for the cross
        const p = Math.min(1, cut.t / cut.dur);
        c.strokeStyle = col.accent; c.lineWidth = 2; c.lineCap = "round"; c.globalAlpha = 1 - p * 0.8;
        c.beginPath();
        if (cut.kind === "spin") c.arc(cx, cy, 15, -Math.PI / 2, -Math.PI / 2 + TAU * ease(p));
        else if (cut.kind === "dash") { c.moveTo(X - 6, cy + 2); c.lineTo(fx + 12, cy + 2); }
        else if (cut.kind === "cross") {
          const tx = cut.target.x + cut.target.w / 2, ty = G - cut.target.hy;
          const a = Math.min(1, p * 2), b = Math.max(0, p * 2 - 1);
          c.moveTo(tx - 7, ty - 7); c.lineTo(tx - 7 + 14 * a, ty - 7 + 14 * a);
          if (b) { c.moveTo(tx + 7, ty - 7); c.lineTo(tx + 7 - 14 * b, ty - 7 + 14 * b); }
        } else c.arc(fx + 6, cy - 3, 11, -1.4, -1.4 + p * 2.6);
        c.stroke(); c.globalAlpha = 1;
      }
      c.globalCompositeOperation = "destination-out";  // soft fade at both ends
      const fade = (x0, x1) => { const g = c.createLinearGradient(x0, 0, x1, 0); g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)"); c.fillStyle = g; c.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), H); };
      fade(0, 14); fade(W, W - 24);
      c.globalCompositeOperation = "source-over";
    }

    function frame(now) {
      if (stopped) return;
      if (!cv.isConnected) { stopped = true; return; }
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
      last = now;
      if (cv.offsetParent === null) return;  // that chat isn't on screen
      if (now - colAt > 1000) { col = colours(); colAt = now; }
      draw(step(dt));
    }
    raf = requestAnimationFrame(frame);
    return { el: cv, stop() { stopped = true; cancelAnimationFrame(raf); } };
  }

  const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const more = {};  // dragon, soccer, wizard from critters.js
  window.WorkAnim = {
    kinds: ["runner", "ninja"],
    register(name, make) { more[name] = make; if (!this.kinds.includes(name)) this.kinds.push(name); },
    // kind: one of kinds | "mix" (a different one each turn) | "dot" (none)
    create(kind) {
      if (kind === "dot" || still()) return null;
      const k = kind === "mix" || !kind || !(more[kind] || kind === "runner" || kind === "ninja") ? pick(this.kinds) : kind;
      return more[k] ? more[k]() : create(k);
    },
  };
})();
