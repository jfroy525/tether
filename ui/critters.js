// More working-line animations, drawn like runner.js on one small canvas each: a dragon that breathes fire at code
// glyphs, a soccer player who dribbles past them and scores, and a wizard who casts spells. Each picks a random move
// when a glyph comes near. They register with WorkAnim (runner.js), so Settings and the mix pick them up.
(function () {
  const W = 200, H = 54, G = 48, TAU = Math.PI * 2;
  const GLYPHS = ["{ }", "</>", "λ", "#", "[ ]", "=>", "$_", "*", "&&", "//"];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const weighted = (list, only) => { if (only && list.some(([k]) => k === only)) return only; let r = Math.random() * list.reduce((n, [, w]) => n + w, 0); for (const [k, w] of list) if ((r -= w) <= 0) return k; return list[0][0]; };
  const ease = p => p < 0 ? 0 : p > 1 ? 1 : p * p * (3 - 2 * p);
  const lerp = (a, b, p) => a + (b - a) * p;
  const clamp = p => p < 0 ? 0 : p > 1 ? 1 : p;
  // a critically damped spring, solved exactly so it stays steady at any frame rate (stepping it frame by frame
  // overshoots and thrashes when it's stiff or a frame runs long). w: how fast it settles. Returns [x, v].
  function spring(x, v, target, w, dt) {
    const d = x - target, e = Math.exp(-w * dt), k = (v + w * d) * dt;
    return [target + (d + k) * e, (v - w * k) * e];
  }

  function colours() {
    const cs = getComputedStyle(document.body);
    const v = n => cs.getPropertyValue(n).trim();
    return { fig: v("--text-2") || "#bbb", dim: v("--text-3") || "#777", line: v("--line-2") || "#333", accent: v("--accent") || "#3aa",
             mono: v("--mono") || "ui-monospace, Menlo, monospace" };
  }

  // The canvas and frame loop every animation shares: pauses while its chat isn't on screen, follows the theme,
  // stops itself when removed. make(c, col) returns {step(dt), draw(col)}.
  function stage(make) {
    const cv = document.createElement("canvas");
    cv.className = "work-anim";
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    const c = cv.getContext("2d");
    let col = colours(), colAt = 0, last = 0, raf = 0, stopped = false;
    const sim = make(c, () => col);
    function frame(now) {
      if (stopped) return;
      if (!cv.isConnected) { stopped = true; return; }
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
      last = now;
      if (cv.offsetParent === null) return;
      if (now - colAt > 1000) { col = colours(); colAt = now; }
      sim.step(dt);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      sim.draw(col);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "destination-out";  // soft fade at both ends, like the runner
      const fade = (x0, x1) => { const g = c.createLinearGradient(x0, 0, x1, 0); g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)"); c.fillStyle = g; c.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), H); };
      fade(0, 14); fade(W, W - 24);
      c.globalCompositeOperation = "source-over";
    }
    raf = requestAnimationFrame(frame);
    return { el: cv, stop() { stopped = true; cancelAnimationFrame(raf); } };
  }
  function ground(c, col, dist) {
    c.strokeStyle = col.line; c.lineWidth = 1;
    const off = dist % 9;
    c.beginPath();
    for (let x = -off; x < W; x += 9) { c.moveTo(x, G + 0.5); c.lineTo(x + 5, G + 0.5); }
    c.stroke();
  }
  function glyph(c, col) {
    c.font = `600 10.5px ${col.mono}`;
    const g = c.canvas.__glyph?.() || pick(GLYPHS);
    return { g, w: c.measureText(g).width };
  }
  function particles(list, dt, grav) {
    for (const p of list) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (grav ?? 300) * dt; p.life -= dt; }
    return list.filter(p => p.life > 0);
  }
  function dots(c, col, list) {
    for (const d of list) { c.globalAlpha = Math.max(0, d.life / d.max); c.fillStyle = d.accent ? col.accent : col.dim; c.fillRect(d.x, d.y, d.s || 1.6, d.s || 1.6); }
    c.globalAlpha = 1;
  }
  const burst = (list, x, y, n, accent, spread = 1) => { for (let k = 0; k < n; k++) list.push({ x, y, vx: rnd(-60, 70) * spread, vy: rnd(-110, 10) * spread, life: 0.45, max: 0.45, accent }); };

  // ---------- dragon: flies a wavy line, breathes fire at glyphs, loops, rolls and snaps them up ----------
  function dragon(c, colf, opts = {}) {
    const SPEED = 70, BX = 100, N = 13, LAG = 0.042, BODY = 82;
    let t = 0, dist = 0, hist = [], things = [], fire = [], embers = [], nextGap = 40, act = null;
    let head = { x: BX, y: 22 }, roll = 1, jaw = 0, sy = 22, svy = 0;  // sy/svy: the head's height on a spring
    function headAt(tt) {
      for (let i = hist.length - 1; i > 0; i--) {
        if (hist[i - 1].t <= tt) { const a = hist[i - 1], b = hist[i], p = clamp((tt - a.t) / ((b.t - a.t) || 1)); return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) }; }
      }
      return hist[0] || head;
    }
    const body = () => Array.from({ length: N + 1 }, (_, i) => { const p = headAt(t - i * LAG); return { x: p.x - BODY * i * LAG, y: p.y }; });
    function step(dt) {
      t += dt; dist += SPEED * dt;
      for (const o of things) { o.x -= SPEED * dt; if (o.burn) o.burn += dt; }
      things = things.filter(o => o.x > -30 && !o.gone && !(o.burn > 0.5));
      const lastX = things.length ? Math.max(...things.map(o => o.x + o.w)) : -1e9;
      if (W - lastX > nextGap) { things.push({ ...glyph(c, colf()), x: W + 8, y: rnd(12, 36), bob: rnd(0, 6), burn: 0 }); nextGap = rnd(80, 150); }
      if (!act) {
        const o = things.find(o => !o.claimed && o.x - head.x > 8 && o.x - head.x < 64);
        if (o) {
          const kind = weighted([["fire", 48], ["loop", 22], ["roll", 14], ["chomp", 16]], opts.only);
          act = { kind, t: 0, dur: { fire: 0.8, loop: 1.15, roll: 0.8, chomp: 0.55 }[kind], o };
          o.claimed = true;
        }
      }
      // where the head wants to be; a critically damped spring then glides it there, so it never snaps up or down
      let hx = BX, hy = 24 + Math.sin(t * 2.3) * 5 + Math.sin(t * 0.9) * 3, loopUp = 0;
      jaw = 0; roll = 1;
      if (act) {
        act.t += dt;
        const p = clamp(act.t / act.dur), o = act.o;
        if (act.kind === "fire") {  // turn toward the glyph and breathe
          hy = o.y;
          jaw = p > 0.25 && p < 0.9 ? 1 : 0;
        } else if (act.kind === "loop") {  // a loop-the-loop; the body follows through it
          const a = TAU * ease(p), R = 11;
          hx = BX + Math.sin(a) * R * 1.2; loopUp = (1 - Math.cos(a)) * R;
        } else if (act.kind === "roll") {
          roll = Math.cos(TAU * ease(p));
        } else {  // chomp: lunge at it
          const k = Math.sin(Math.PI * p);
          hx = lerp(BX, Math.max(BX, o.x + o.w / 2 - 4), k); hy = o.y; jaw = p < 0.48 ? 1 : 0;
          if (p >= 0.48 && !o.gone) { o.gone = true; burst(embers, o.x + o.w / 2, o.y, 7, true); }
        }
        if (act.t >= act.dur) act = null;
      }
      [sy, svy] = spring(sy, svy, hy, act?.kind === "chomp" ? 16 : 11, dt);
      head = { x: hx, y: sy - loopUp };
      hist.push({ t, x: head.x, y: head.y });
      while (hist.length > 2 && hist[1].t < t - N * LAG - 0.1) hist.shift();
      if (jaw && act?.kind === "fire") {
        const s = body(), ang = Math.atan2(s[0].y - s[1].y, s[0].x - s[1].x);
        for (let k = 0; k < 2; k++)
          fire.push({ x: head.x + Math.cos(ang) * 6, y: head.y + Math.sin(ang) * 6, vx: Math.cos(ang) * rnd(140, 190), vy: Math.sin(ang) * 140 + rnd(-18, 18), life: 0.34, max: 0.34, r: rnd(0.9, 1.6), hot: Math.random() < 0.5 });
      }
      for (const f of fire) {
        f.x += f.vx * dt; f.y += f.vy * dt; f.vy -= 40 * dt; f.life -= dt;
        for (const o of things) if (!o.burn && Math.abs(f.x - (o.x + o.w / 2)) < o.w / 2 + 2 && Math.abs(f.y - o.y) < 6) o.burn = 0.001;
      }
      fire = fire.filter(f => f.life > 0);
      for (const o of things) if (o.burn && Math.random() < 0.6) embers.push({ x: o.x + rnd(0, o.w), y: o.y + rnd(-4, 3), vx: rnd(-40, -10), vy: rnd(-60, -25), life: 0.6, max: 0.6, accent: true });
      embers = particles(embers, dt, -20);
    }
    function wing(s, col, far) {
      const f = (0.25 + 0.75 * Math.sin(t * 9 + (far ? 0.6 : 0))) * roll;
      c.beginPath();  // a bat wing: arm to the tip, then scalloped back to the body
      c.moveTo(s.x, s.y);
      c.lineTo(s.x - 2, s.y - 17 * f);
      c.quadraticCurveTo(s.x - 6, s.y - 9 * f, s.x - 9, s.y - 11 * f);
      c.quadraticCurveTo(s.x - 11, s.y - 4 * f, s.x - 16, s.y - 6 * f);
      c.quadraticCurveTo(s.x - 13, s.y - 1, s.x - 10, s.y);
      c.closePath();
      c.globalAlpha = far ? 0.3 : 0.55; c.fillStyle = col.dim; c.fill();
      c.globalAlpha = far ? 0.55 : 1; c.strokeStyle = col.fig; c.lineWidth = 1.2; c.stroke();
      c.globalAlpha = 1;
    }
    function draw(col) {
      ground(c, col, dist);
      const s = body();
      c.globalAlpha = 0.22; c.fillStyle = col.dim;  // shadow on the ground
      c.beginPath(); c.ellipse(head.x - 22, G - 0.5, 16 * (1 - (G - head.y) / 70), 1.4, 0, 0, TAU); c.fill(); c.globalAlpha = 1;
      wing({ x: s[2].x + 1, y: s[2].y - 1 }, col, true);
      c.lineCap = "round"; c.strokeStyle = col.fig;
      for (let i = N - 1; i >= 0; i--) {
        c.lineWidth = i < 3 ? 3 + i * 0.7 : 0.9 + 4.2 * (1 - (i - 3) / (N - 3));
        c.beginPath(); c.moveTo(s[i + 1].x, s[i + 1].y); c.lineTo(s[i].x, s[i].y); c.stroke();
      }
      c.strokeStyle = col.dim; c.lineWidth = 1;  // spines along the back
      for (let i = 2; i < N - 1; i += 2) {
        const dx = s[i - 1].x - s[i + 1].x, dy = s[i - 1].y - s[i + 1].y, l = Math.hypot(dx, dy) || 1, nx = dy / l * roll, ny = -dx / l * roll;
        const w = 0.9 + 4.2 * (1 - Math.max(0, i - 3) / (N - 3));
        c.beginPath(); c.moveTo(s[i].x + nx * w / 2, s[i].y + ny * w / 2); c.lineTo(s[i].x + nx * (w / 2 + 2.2) - dx / l * 1.2, s[i].y + ny * (w / 2 + 2.2) - dy / l * 1.2); c.stroke();
      }
      const tl = s[N], tp = s[N - 1], ta = Math.atan2(tl.y - tp.y, tl.x - tp.x);  // tail tip
      c.fillStyle = col.fig;
      c.beginPath(); c.moveTo(tl.x + Math.cos(ta) * 3.5, tl.y + Math.sin(ta) * 3.5); c.lineTo(tl.x + Math.cos(ta + 2.2) * 2.4, tl.y + Math.sin(ta + 2.2) * 2.4); c.lineTo(tl.x + Math.cos(ta - 2.2) * 2.4, tl.y + Math.sin(ta - 2.2) * 2.4); c.fill();
      wing({ x: s[2].x, y: s[2].y }, col, false);
      const ang = Math.atan2(s[0].y - s[1].y, s[0].x - s[1].x);
      c.save(); c.translate(head.x, head.y); c.rotate(ang); c.scale(1.3, 1.3 * (roll < 0 ? Math.min(-0.35, roll) : Math.max(0.35, roll)));
      c.fillStyle = col.fig;
      c.beginPath(); c.moveTo(-2, -2.6); c.lineTo(5.5, -1.3); c.lineTo(6.6, 0); c.lineTo(5.5, jaw ? 3.4 : 1.1); c.lineTo(-2, 2.4); c.closePath(); c.fill();
      c.strokeStyle = col.fig; c.lineWidth = 1.1;
      c.beginPath(); c.moveTo(-1.4, -2.2); c.lineTo(-4.6, -5.4); c.moveTo(0.4, -2.3); c.lineTo(-2.2, -5.8); c.stroke();
      c.fillStyle = col.accent; c.beginPath(); c.arc(1.7, -0.7, 0.9, 0, TAU); c.fill();
      c.restore();
      c.font = `600 10.5px ${col.mono}`; c.textBaseline = "alphabetic";
      for (const o of things) {
        if (o.burn) { c.globalAlpha = Math.max(0, 1 - o.burn / 0.5); c.fillStyle = col.accent; c.fillText(o.g, o.x + rnd(-0.6, 0.6), o.y + 4 - o.burn * 6); c.globalAlpha = 1; }
        else { c.fillStyle = col.fig; c.fillText(o.g, o.x, o.y + 4 + Math.sin(t * 5 + o.bob) * 1.2); }
      }
      for (const f of fire) {
        const a = f.life / f.max;
        c.globalAlpha = a; c.fillStyle = f.hot ? col.accent : col.fig;
        c.beginPath(); c.arc(f.x, f.y, f.r * (1 + (1 - a) * 1.6), 0, TAU); c.fill();
      }
      c.globalAlpha = 1;
      dots(c, col, embers);
    }
    return { step, draw, probe: () => ({ headY: head.y, act: act?.kind }) };
  }

  // ---------- soccer player: dribbles, beats each glyph with a trick, and scores when a goal comes by ----------
  function soccer(c, colf, opts = {}) {
    const SPEED = 80, X = 44, GRAV = 1100, JUMP = 230, R = 2.7, STRIDE = 6.5, BLEND = 0.18;
    let t = 0, dist = 0, y = 0, vy = 0, things = [], goal = null, dust = [], confetti = [], act = null, nextGap = 60, sinceGoal = 0, idle = 0;
    const ball = { x: X + 8.6, h: 0, spin: 0, mode: "feet", nx: 0, vh: 0, fx: 0, fh: 0, bt: 1 };
    const onGround = () => y === 0 && vy === 0;
    // the juggle's touches: where the ball meets the body (x from the player, height) and how high it pops after
    const JUGGLE = [{ x: 8.6, h: 0, up: 10 }, { x: 5, h: 8.5, up: 7 }, { x: 6.5, h: 2, up: 9 }, { x: 4, h: 20, up: 4 }, { x: 6.5, h: 2, up: 2 }, { x: 8.6, h: 0 }];
    const reball = () => { ball.fx = ball.x; ball.fh = ball.h; ball.bt = 0; };  // glide from here to wherever the ball goes next
    // dribbling: the right foot pushes the ball ahead at the end of each stride; it rolls out, slows, and the player
    // catches up to it for the next touch (a parabola in the player's frame)
    const touch = () => { const f = (((dist / STRIDE - Math.PI / 2) / TAU) % 1 + 1) % 1; return X + 8.6 + 36 * f * (1 - f); };
    function limb(from, ang, bend, l1, l2) {
      const k = [from[0] + Math.sin(ang) * l1, from[1] + Math.cos(ang) * l1];
      const f = [k[0] + Math.sin(ang + bend) * l2, k[1] + Math.cos(ang + bend) * l2];
      c.beginPath(); c.moveTo(from[0], from[1]); c.lineTo(k[0], k[1]); c.lineTo(f[0], f[1]); c.stroke();
      return f;
    }
    function spawn() {
      if ((sinceGoal >= 3 || opts.only === "shoot") && !goal && (Math.random() < 0.5 || opts.only === "shoot")) { goal = { x: W + 10, bulge: 0, scored: false, fade: 0 }; sinceGoal = 0; nextGap = 170; return; }
      things.push({ ...glyph(c, colf()), x: W + 8, hop: 0, fall: 0 });
      sinceGoal++;
      nextGap = rnd(100, 170);
    }
    // the goal fades out after a score (and, just in case, before it could ever reach the player)
    const goalAlpha = () => goal ? Math.min(1 - clamp((goal.fade - 0.35) / 0.45), clamp((goal.x - X - 18) / 20)) : 0;
    function step(dt) {
      t += dt; dist += SPEED * dt;
      const px = ball.x;
      for (const o of things) { o.x -= SPEED * dt * (o.fall ? 1.6 : 1); if (o.hop) o.hop = Math.max(0, o.hop - dt); if (o.fall) o.fall += dt; }
      things = things.filter(o => o.x > -30 && !(o.fall > 0.6));
      if (goal) {
        goal.x -= SPEED * dt; goal.bulge = Math.max(0, goal.bulge - dt * 2.5);
        if (goal.scored) goal.fade += dt;
        if (goalAlpha() <= 0 && (goal.scored || goal.x < X + 18)) goal = null;
      }
      const lastX = Math.max(things.length ? Math.max(...things.map(o => o.x + o.w)) : -1e9, goal ? goal.x + 20 : -1e9);
      if (W - lastX > nextGap) spawn();
      // a shot when the goal is in range; a trick for each glyph coming at us; juggling when the way is clear
      if (!act && ball.mode === "feet" && onGround()) {
        const gd = goal && !goal.scored ? goal.x - X : 1e9;
        const o = gd > 230 && things.find(o => !o.beat && o.x - X > 30 && o.x - X < 52);
        if (gd <= 130 && gd > 70) act = { kind: "shoot", t: 0, dur: 0.55 };
        else if (o) { o.beat = true; act = { kind: o.w > 24 ? "stepover" : weighted([["flick", 34], ["nutmeg", 33], ["stepover", 33]], opts.only), t: 0, o }; act.dur = { flick: 0.8, nutmeg: 0.9, stepover: 0.6 }[act.kind]; }
        else if ((idle += dt) > 1.2 && !things.some(o => o.x - X < 110 && o.x > X) && !goal && Math.random() < dt * (opts.only === "juggle" ? 9 : 0.8)) { act = { kind: "juggle", t: 0, dur: 1.6 }; idle = 0; }
        if (act) reball();
      }
      for (const o of things) {  // hop over whatever reaches us standing
        const mid = o.x + o.w / 2;
        if (o.w > 24) { if (!o.fall && o.x - X < 14) o.fall = 0.001; continue; }  // too long to hop: it tips over
        if (!o.fall && !o.jumped && onGround() && mid - X > 0 && mid - X <= SPEED * (JUMP / GRAV)) { o.jumped = true; vy = JUMP; }
      }
      if (y > 0 || vy !== 0) {
        y += vy * dt; vy -= GRAV * dt;
        if (y <= 0) { y = 0; vy = 0; for (let k = 0; k < 3; k++) dust.push({ x: X + rnd(-3, 3), y: G, vx: rnd(-50, -20), vy: rnd(-30, -10), life: 0.3, max: 0.3 }); }
      }
      let tx = touch(), th = 0;
      if (act) {
        act.t += dt;
        const p = clamp(act.t / act.dur);
        if (act.kind === "flick") {  // sole drags it back, the heel flicks it over both heads, it lands in stride
          if (p < 0.22) tx = lerp(X + 8.6, X - 2, ease(p / 0.22));
          else { const q = (p - 0.22) / 0.78; tx = lerp(X - 2, X + 10, q); th = Math.sin(Math.PI * q) * 30; }
        } else if (act.kind === "nutmeg") {  // pushed through the glyph's legs, run round and collect it
          tx = X + 8.6 + 34 * Math.sin(Math.PI * p);
          const o = act.o; if (!o.hop && !o.nut && Math.abs(tx - (o.x + o.w / 2)) < 4) { o.hop = 0.3; o.nut = true; }
        } else if (act.kind === "stepover") { tx = X + 9; if (p > 0.65 && !act.o.fall) act.o.fall = 0.001; }
        else if (act.kind === "juggle") {  // foot, knee, foot, head, foot: an arc from each touch to the next
          const k = p * 5, n = Math.min(4, Math.floor(k)), f = k - n, a = JUGGLE[n], b = JUGGLE[n + 1];
          tx = X + lerp(a.x, b.x, f); th = lerp(a.h, b.h, f) + 4 * a.up * f * (1 - f);
        } else if (act.kind === "shoot") {
          if (p >= 0.4 && goal) { const q = clamp((p - 0.4) / 0.6); tx = lerp(X + 9, goal.x + 9, q); th = Math.sin(Math.PI * q * 0.8) * 9 + q * 3; ball.bt = 1; }
        } else if (act.kind === "celebrate") { tx = ball.x; th = ball.h; }
        if (act.t >= act.dur) {
          const was = act.kind; act = null;
          if (was === "shoot" && goal) {
            goal.scored = true; goal.bulge = 1; ball.mode = "net"; ball.nx = 9;
            for (let k = 0; k < 16; k++) confetti.push({ x: goal.x + 10, y: G - 12, vx: rnd(-70, 60), vy: rnd(-150, -50), life: 0.9, max: 0.9, accent: k % 2 === 0, s: 1.8 });
            act = { kind: "celebrate", t: 0, dur: 0.75 }; vy = 150;  // a little jump, arms up
          } else if (ball.mode === "feet") reball();
        }
      }
      if (ball.mode === "net") {
        if (goal) { tx = goal.x + ball.nx + goal.bulge * 2; th = 0; ball.bt = 1; }
        else { ball.mode = "drop"; ball.x = X + 8.6; ball.h = 46; ball.vh = 0; }  // the goal's gone: a new ball drops in
      }
      if (ball.mode === "drop") {
        ball.vh -= 700 * dt; ball.h += ball.vh * dt;
        tx = X + 8.6; th = ball.h; ball.bt = 1;
        if (ball.h <= 0) { ball.h = th = 0; if (ball.vh < -110) ball.vh = -ball.vh * 0.45; else { ball.mode = "feet"; reball(); } }
      }
      if (ball.bt < BLEND) { ball.bt += dt; const q = ease(ball.bt / BLEND); ball.x = lerp(ball.fx, tx, q); ball.h = lerp(ball.fh, th, q); }
      else { ball.x = tx; ball.h = th; }
      // it turns as fast as it really rolls over the ground; in the air it keeps its spin
      const roll = SPEED + (ball.x - px) / (dt || 0.016);
      if (ball.mode !== "net") ball.spin += (ball.h > 0.5 ? (act?.kind === "flick" ? -14 : 8) * dt : roll * dt / R);
      dust = particles(dust, dt);
      confetti = particles(confetti, dt, 260);
    }
    function draw(col) {
      ground(c, col, dist);
      const ga = goalAlpha();
      if (goal && ga > 0) {  // side view: front post, crossbar, net down to the back
        const gx = goal.x, b = goal.bulge * 3;
        c.globalAlpha = ga; c.strokeStyle = col.dim; c.lineWidth = 0.7;
        c.beginPath();
        for (let k = 1; k <= 4; k++) { c.moveTo(gx + k * 4, G - 21 + k * 0.6); c.quadraticCurveTo(gx + k * 4 + b * (k / 4), G - 10, gx + k * 4 + b * 0.5, G); }
        for (let k = 1; k <= 3; k++) { const yy = G - 21 + k * 5.2; c.moveTo(gx, yy); c.lineTo(gx + 16 + b, yy + 1); }
        c.stroke();
        c.strokeStyle = col.fig; c.lineWidth = 1.6;
        c.beginPath(); c.moveTo(gx, G); c.lineTo(gx, G - 21); c.lineTo(gx + 16, G - 18.5); c.lineTo(gx + 17 + b, G); c.stroke();
        c.globalAlpha = 1;
      }
      c.font = `600 10.5px ${col.mono}`; c.textBaseline = "alphabetic";
      for (const o of things) {
        c.save(); c.fillStyle = col.dim;
        const hop = o.hop ? Math.sin(Math.PI * (1 - o.hop / 0.3)) * 7 : 0;
        if (o.fall) { c.globalAlpha = Math.max(0, 1 - o.fall / 0.6); c.translate(o.x + o.w, G - 1.5); c.rotate(-Math.min(1, o.fall / 0.3) * Math.PI / 2); c.fillText(o.g, -o.w, 0); }
        else c.fillText(o.g, o.x, G - 1.5 - hop);
        c.restore();
      }
      // the player
      const air = y > 0.5, phase = dist / STRIDE, k = act?.kind, p = act ? clamp(act.t / act.dur) : 0;
      const bob = air ? 0 : Math.abs(Math.cos(phase)) * 0.7, fx = X, fy = G - y - bob;
      const nod = k === "juggle" ? Math.max(0, 1 - Math.abs(p * 5 - 3) / 0.35) : 0;
      const hip = [fx, fy - 8.6], sh = [fx + 2, fy - 15.2], head = [fx + 3 + nod * 0.8, fy - 19.3 - nod * 1.2];
      c.strokeStyle = col.fig; c.fillStyle = col.fig; c.lineWidth = 1.7; c.lineCap = "round"; c.lineJoin = "round";
      const run = ph => limb(hip, Math.sin(ph) * 0.8, -(0.2 + Math.max(0, Math.cos(ph)) * 1.25), 4.6, 4.6);
      for (let i = 0; i < 2; i++) {
        const ph = phase + i * Math.PI;
        if (k === "celebrate" || (air && k !== "flick")) { if (air) limb(hip, i ? 0.9 : -0.35, i ? -1.5 : -0.9, 4.6, 4.6); else run(ph); }
        else if (k === "shoot" && i === 0) limb(hip, p < 0.4 ? lerp(Math.sin(ph) * 0.8, -1.0, ease(p / 0.4)) : lerp(-1.0, 1.4, ease(clamp((p - 0.4) / 0.14))), p < 0.4 ? lerp(-0.3, -1.5, ease(p / 0.4)) : -0.15, 4.6, 4.6);
        else if (k === "shoot") limb(hip, 0.15, -0.2, 4.6, 4.6);
        else if (k === "stepover" && i === 0) limb(hip, 0.55 + Math.sin(p * TAU) * 0.55, -0.5 - Math.max(0, Math.sin(p * TAU)) * 0.9, 4.6, 4.6);  // circling over the ball
        else if (k === "flick" && i === 0 && p < 0.22) limb(hip, lerp(0.85, 0.25, ease(p / 0.22)), -0.6, 4.6, 4.6);  // sole on the ball, rolling it back
        else if (k === "flick" && i === 0 && p < 0.42) limb(hip, -0.45, -lerp(0.4, 2.1, ease((p - 0.22) / 0.2)), 4.6, 4.6);  // heel kicks up behind
        else if (k === "juggle" && i === 0) {  // each kick peaks at its touch
          const near = m => Math.max(0, 1 - Math.abs(p * 5 - m) / 0.45), foot = Math.max(near(0), near(2), near(4)), knee = near(1);
          limb(hip, 0.9 * ease(foot) + 1.5 * ease(knee), -0.3 - 0.3 * ease(foot) - 1.7 * ease(knee), 4.6, 4.6);
        } else if (k === "juggle") limb(hip, -0.1, -0.15, 4.6, 4.6);
        else run(ph);
      }
      c.beginPath(); c.moveTo(hip[0], hip[1]); c.lineTo(sh[0], sh[1]); c.stroke();
      if (k === "celebrate") { limb(sh, Math.PI - 0.55, 0.15, 4.2, 3.6); limb(sh, Math.PI + 0.55, -0.15, 4.2, 3.6); }  // arms up
      else if (k === "shoot" || k === "stepover" || k === "juggle" || air) { limb(sh, 2.0, 0.3, 4.2, 3.6); limb(sh, -2.0, -0.3, 4.2, 3.6); }  // arms out for balance
      else for (let i = 0; i < 2; i++) limb(sh, -Math.sin(phase + i * Math.PI) * 0.85, 1.0, 4, 3.4);
      c.beginPath(); c.arc(head[0], head[1], 3.1, 0, TAU); c.fill();
      // the ball: a little shadow on the ground, and a dot pattern turning as it rolls
      const bx = ball.x, by = G - R - ball.h, ba = ball.mode === "net" ? ga : 1;
      if (ball.h > 1) { c.globalAlpha = 0.25 * ba * Math.max(0, 1 - ball.h / 40); c.fillStyle = col.dim; c.beginPath(); c.ellipse(bx, G - 0.3, R, 0.8, 0, 0, TAU); c.fill(); }
      c.globalAlpha = ba;
      c.lineWidth = 1.1; c.strokeStyle = col.fig;
      c.beginPath(); c.arc(bx, by, R, 0, TAU); c.stroke();
      c.fillStyle = col.accent;
      for (let j = 0; j < 2; j++) { const a = ball.spin + j * Math.PI; c.beginPath(); c.arc(bx + Math.cos(a) * 1.2, by + Math.sin(a) * 1.2, 0.85, 0, TAU); c.fill(); }
      c.globalAlpha = 1;
      dots(c, col, dust);
      dots(c, col, confetti);
    }
    return { step, draw, probe: () => ({ ballX: ball.x, ballH: ball.h, goalX: goal ? goal.x : null, goalA: goalAlpha(), act: act?.kind, mode: ball.mode }) };
  }

  // ---------- wizard: a grey wizard with a staff; glyphs shall not pass, or get zapped, levitated or set off as fireworks ----------
  function wizard(c, colf, opts = {}) {
    const SPEED = 58, X = 46, STRIDE = 30, STAFF = 25;
    let t = 0, dist = 0, ws = 1, things = [], sparks = [], stars = [], rings = [], cracks = [], act = null, nextGap = 70, idle = 0;
    let glow = 0.3, barrier = 0, tip = 0, tipV = 0, bolt = null;
    const REACH = { pass: 54, bolt: 62, levitate: 42, fireworks: 32 };
    const DUR = { pass: 1.35, bolt: 0.7, levitate: 1.3, fireworks: 1.4, smoke: 2.4 };
    function spawn() { things.push({ ...glyph(c, colf()), x: W + 8, y: 0, rot: 0 }); nextGap = rnd(95, 165); }
    // the staff while walking: planted and left behind as he walks past it, then swung forward to the next spot
    function walkStaff() {
      const f = (dist / STRIDE) % 1;
      if (f < 0.36) return { b: { x: X + 16 - STRIDE * f, y: G }, h: { x: X + 7, y: G - 13 } };  // stays in front of him
      const q = (f - 0.36) / 0.64;
      return { b: { x: lerp(X + 16 - STRIDE * 0.36, X + 16, ease(q)), y: G - Math.sin(Math.PI * q) * 3.5 }, h: { x: X + 7.5, y: G - 13.8 } };
    }
    const toward = (h, x, y, len) => { const dx = x - h.x, dy = y - h.y, l = Math.hypot(dx, dy) || 1; return { x: h.x - dx / l * len, y: h.y - dy / l * len }; };
    function actStaff(p) {  // where the staff foot (b) and hand (h) go during each spell
      const o = act.o;
      if (act.kind === "pass") {
        if (p < 0.3) { const q = ease(p / 0.3); return { b: { x: X + 10, y: lerp(G - 4, G - 12, q) }, h: { x: X + 7, y: lerp(G - 17, G - 27, q) } }; }
        const q = ease((p - 0.3) / 0.06); return { b: { x: lerp(X + 10, X + 13, q), y: lerp(G - 12, G, q) }, h: { x: lerp(X + 7, X + 10, q), y: lerp(G - 27, G - 15, q) } };
      }
      if (act.kind === "bolt") { const h = { x: X + 8, y: G - 16 }; return { b: toward(h, o.x + o.w / 2, G - 5, 7), h }; }
      if (act.kind === "levitate") { const h = { x: X + 7 + Math.sin(p * TAU * 2) * 1.2, y: G - 23 }; return { b: { x: X + 8 - Math.sin(p * TAU * 2) * 1.5, y: G - 11 }, h }; }
      if (act.kind === "fireworks") {
        const h = { x: X + 8, y: G - 14 };
        if (p < 0.3) return { b: toward(h, o.x + o.w / 2, G - 2, 7), h };
        return { b: { x: X + 9, y: G - 9 }, h: { x: X + 8, y: G - 22 } };
      }
      return walkStaff();
    }
    function step(dt) {
      t += dt;
      ws += ((act?.kind === "pass" && act.t / act.dur > 0.33 && act.t / act.dur < 0.85 ? 0 : 1) - ws) * Math.min(1, dt * 9);  // he stands firm
      dist += SPEED * ws * dt;
      for (const o of things) {
        if (o.charge && !o.stuck) o.x -= SPEED * dt;  // it charges at him
        else if (!o.held && !o.stuck) o.x -= SPEED * ws * dt;
        if (o.brk) o.brk += dt;
      }
      things = things.filter(o => o.x > -30 && !o.gone && !(o.brk > 0.6));
      for (const k of cracks) { k.x -= SPEED * ws * dt; k.life -= dt; }
      cracks = cracks.filter(k => k.life > 0);
      const lastX = things.length ? Math.max(...things.map(o => o.x + o.w)) : -1e9;
      if (W - lastX > nextGap) spawn();
      if (!act) {
        for (const o of things) if (!o.claimed && !o.want) o.want = weighted([["pass", 28], ["bolt", 26], ["levitate", 22], ["fireworks", 24]], opts.only);
        const o = things.find(o => !o.claimed && o.x - X > 8 && o.x - X < REACH[o.want]);
        if (o) { o.claimed = true; act = { kind: o.want, t: 0, dur: DUR[o.want], o }; if (o.want === "pass") o.charge = true; }
        else if ((idle += dt) > 1.5 && !things.some(o => o.x - X < 150 && o.x > X) && Math.random() < dt * (opts.only === "smoke" ? 9 : 0.6)) { act = { kind: "smoke", t: 0, dur: DUR.smoke }; idle = 0; }
      }
      bolt = null;
      let want = 0.3;
      if (act) {
        act.t += dt;
        const p = clamp(act.t / act.dur), o = act.o;
        if (act.kind === "pass") {
          want = p > 0.2 ? 1 : 0.5;
          if (p >= 0.36 && !act.slam) {  // the staff comes down: barrier up, ground cracks
            act.slam = true; barrier = 1; tipV -= 60;
            for (let k = 0; k < 3; k++) { const pts = [[0, 0]]; let x = 0, y = 0; for (let j = 0; j < 4; j++) { x += rnd(2, 4) * (k === 1 ? 1 : k ? 1.2 : -1); y += rnd(-0.3, 1.2); pts.push([x, y]); } cracks.push({ x: X + 13, pts, life: 1.4 }); }
            for (let k = 0; k < 6; k++) sparks.push({ x: X + 13, y: G, vx: rnd(-50, 50), vy: rnd(-70, -20), life: 0.35, max: 0.35 });
          }
          if (barrier && !o.stuck && o.x <= X + 18) { o.stuck = true; o.x = X + 21; burst(sparks, X + 17, G - 6, 6, true); }  // bounces off
          if (o.stuck && p >= 0.66 && !o.brk) o.brk = 0.001;
        } else if (act.kind === "bolt") {
          want = 1;
          if (p > 0.25 && p < 0.55 && !o.gone) bolt = { tx: o.x + o.w / 2, ty: G - 5 };
          if (p >= 0.42 && !o.gone) { o.gone = true; burst(sparks, o.x + o.w / 2, G - 5, 12, true, 1.3); burst(sparks, o.x + o.w / 2, G - 5, 5, false); }
        } else if (act.kind === "levitate") {
          want = 0.8;
          if (p > 0.12) o.held = true;
          o.y = 24 * ease((p - 0.12) / 0.6); o.rot = Math.sin(t * 5) * 0.35 * clamp((p - 0.12) * 4);
          if (p > 0.15 && Math.random() < 0.5) stars.push({ x: o.x + rnd(-2, o.w + 2), y: G - 4 - o.y + rnd(-5, 5), vx: rnd(-8, 8), vy: rnd(-20, -5), life: 0.5, max: 0.5, s: rnd(1.2, 2) });
          if (p >= 0.78 && !o.gone) { o.gone = true; for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; stars.push({ x: o.x + o.w / 2, y: G - 4 - o.y, vx: Math.cos(a) * 45, vy: Math.sin(a) * 45 - 10, life: 0.7, max: 0.7, s: 2.2 }); } }
        } else if (act.kind === "fireworks") {
          want = p < 0.3 ? 0.7 : 1;
          if (p >= 0.24 && !o.lit) { o.lit = true; o.held = true; }
          if (o.lit && !o.gone) {
            const q = clamp((p - 0.24) / 0.34); o.y = 34 * (1 - (1 - q) * (1 - q)); o.rot = Math.sin(t * 30) * 0.08;
            sparks.push({ x: o.x + o.w / 2 + rnd(-1, 1), y: G - 2 - o.y, vx: rnd(-10, 10), vy: rnd(20, 40), life: 0.3, max: 0.3, accent: Math.random() < 0.5 });
            if (q >= 1) {  // bang
              o.gone = true;
              for (let k = 0; k < 18; k++) { const a = k / 18 * TAU, v = rnd(50, 70); sparks.push({ x: o.x + o.w / 2, y: G - 2 - o.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.8, max: 0.8, accent: k % 2 === 0, s: 1.8 }); }
            }
          }
        } else if (act.kind === "smoke" && [0.15, 0.4, 0.65].some(m => p >= m && !act[m])) {
          const m = [0.15, 0.4, 0.65].find(m => p >= m && !act[m]); act[m] = true;
          rings.push({ x: X + 9.5, y: G - 19.5, life: 1.6 });
        }
        if (act.t >= act.dur) act = null;
      }
      glow += (want - glow) * Math.min(1, dt * 8);
      if (barrier) barrier = Math.max(0, barrier - dt * 1.1);
      tipV += (-90 * tip - 7 * tipV) * dt; tip += tipV * dt;  // the hat's tip flops on a spring
      for (const r of rings) { r.x -= (12 + SPEED * ws * 0.3) * dt; r.y -= 9 * dt; r.life -= dt; }
      rings = rings.filter(r => r.life > 0);
      sparks = particles(sparks, dt, 160);
      stars = particles(stars, dt, 30);
    }
    function draw(col) {
      ground(c, col, dist);
      c.strokeStyle = col.fig; c.lineWidth = 0.8;  // cracks in the ground
      for (const k of cracks) { c.globalAlpha = Math.min(1, k.life / 0.5); c.beginPath(); k.pts.forEach(([x, y], i) => i ? c.lineTo(k.x + x, G + 0.5 + y) : c.moveTo(k.x + x, G + 0.5 + y)); c.stroke(); }
      c.globalAlpha = 1;
      c.font = `600 10.5px ${col.mono}`; c.textBaseline = "alphabetic";
      for (const o of things) {
        c.save(); c.fillStyle = o.held || o.stuck ? col.fig : col.dim;
        if (o.brk) {  // cracked in two, falling into the ground
          const q = o.brk / 0.6; c.globalAlpha = 1 - q;
          for (const side of [-1, 1]) {
            c.save(); c.beginPath(); c.rect(side < 0 ? o.x - 4 : o.x + o.w / 2, G - 14, o.w / 2 + 4, 14); c.clip();
            c.translate(o.x + o.w / 2 + side * q * 4, G - 1.5 + q * q * 8); c.rotate(side * q * 0.5); c.fillText(o.g, -o.w / 2, 0); c.restore();
          }
        } else {
          const wob = o.stuck ? Math.sin(t * 50) * Math.max(0, 0.9 - (act?.t || 0)) : 0;
          c.translate(o.x + o.w / 2 + wob, G - 1.5 - (o.y || 0) - 3); c.rotate(o.rot || 0); c.fillText(o.g, -o.w / 2, 3);
        }
        c.restore();
      }
      if (barrier) {  // the barrier of light
        c.strokeStyle = col.accent; c.lineCap = "round";
        for (let k = 0; k < 3; k++) { c.globalAlpha = barrier * (0.9 - k * 0.25); c.lineWidth = 1.6 - k * 0.4; c.beginPath(); c.ellipse(X + 17 + k * 1.6, G - 12, 2.5 + k * 1.4, 13 - k, 0, -Math.PI / 2, Math.PI / 2); c.stroke(); }
        c.globalAlpha = 1;
      }
      // the wizard
      const p = act ? clamp(act.t / act.dur) : 0, phase = dist / STRIDE * TAU, still = ws < 0.5;
      const bob = Math.abs(Math.sin(phase)) * 0.7 * ws, sway = Math.sin(phase) * 0.9 * ws;
      const blend = act && act.kind !== "smoke" ? ease(p / 0.12) * (1 - ease((p - 0.88) / 0.12)) : 0;
      const w = walkStaff(), a = act ? actStaff(p) : w;
      const sb = { x: lerp(w.b.x, a.b.x, blend), y: lerp(w.b.y, a.b.y, blend) }, hd = { x: lerp(w.h.x, a.h.x, blend), y: lerp(w.h.y, a.h.y, blend) - bob };
      const dx = hd.x - sb.x, dy = hd.y - sb.y, dl = Math.hypot(dx, dy) || 1, top = { x: sb.x + dx / dl * STAFF, y: sb.y + dy / dl * STAFF };
      c.lineCap = "round"; c.lineJoin = "round";
      c.fillStyle = col.fig;  // feet peeking out under the robe
      for (let i = 0; i < 2; i++) { const s = Math.sin(phase + i * Math.PI) * ws; c.beginPath(); c.ellipse(X + 1 + s * 3, G - 0.9 - Math.max(0, Math.cos(phase + i * Math.PI)) * 1.2 * ws, 1.9, 1, 0, 0, TAU); c.fill(); }
      const y0 = G - bob;
      c.beginPath(); c.moveTo(X - 1.5, y0 - 16.5); c.lineTo(X + 3.5, y0 - 16.5); c.lineTo(X + 6 + sway, y0 - 1.6); c.quadraticCurveTo(X + 0.5 + sway, y0 - 0.4, X - 5.5 + sway * 1.3, y0 - 1.6); c.closePath();
      c.fillStyle = col.dim; c.fill(); c.strokeStyle = col.fig; c.lineWidth = 1.1; c.stroke();  // robe
      c.strokeStyle = col.fig; c.lineWidth = 0.9; c.beginPath(); c.moveTo(X - 2.6, y0 - 10); c.lineTo(X + 4.6, y0 - 10); c.stroke();  // rope belt
      c.fillStyle = col.fig; c.beginPath(); c.arc(X + 1.5, y0 - 19.6, 2.6, 0, TAU); c.fill();  // face
      c.beginPath(); c.moveTo(X - 0.6, y0 - 19); c.lineTo(X + 4.3, y0 - 19); c.quadraticCurveTo(X + 3.8, y0 - 14, X + 2.2 + sway * 0.5, y0 - 10.5); c.quadraticCurveTo(X + 0.6, y0 - 14, X - 0.6, y0 - 19); c.fill();  // beard
      c.strokeStyle = col.fig; c.lineWidth = 1.4; c.beginPath(); c.moveTo(X + 2.5, y0 - 15.5); c.lineTo(hd.x, hd.y); c.stroke();  // arm
      if (act?.kind === "smoke") {  // pipe
        c.lineWidth = 1; c.beginPath(); c.moveTo(X + 3.8, y0 - 18.4); c.lineTo(X + 7.8, y0 - 17.8); c.lineTo(X + 8.6, y0 - 19.6); c.stroke();
      }
      const tx = X - 4.5 - tip * 0.4 - ws * 0.6, ty = y0 - 33 + Math.abs(tip) * 0.15;  // hat: brim and a floppy cone
      c.beginPath(); c.moveTo(X - 2.4, y0 - 21.6); c.quadraticCurveTo(X - 0.5, y0 - 27, tx, ty); c.quadraticCurveTo(X + 2.6, y0 - 27, X + 4.4, y0 - 21.6); c.closePath();
      c.fillStyle = col.dim; c.fill(); c.strokeStyle = col.fig; c.lineWidth = 1.1; c.stroke();
      c.lineWidth = 1.5; c.beginPath(); c.moveTo(X - 5, y0 - 21.5); c.lineTo(X + 7.5, y0 - 21.1); c.stroke();
      c.strokeStyle = col.fig; c.lineWidth = 1.5; c.beginPath(); c.moveTo(sb.x, sb.y); c.lineTo(top.x, top.y); c.stroke();  // staff, with a crystal on top
      const gr = c.createRadialGradient(top.x, top.y, 0, top.x, top.y, 3 + glow * 5);
      gr.addColorStop(0, col.accent); gr.addColorStop(1, /^#[0-9a-f]{6}$/i.test(col.accent) ? col.accent + "00" : "rgba(0,0,0,0)");  // fade in the accent, not through grey
      c.globalAlpha = 0.25 + glow * 0.5; c.fillStyle = gr; c.beginPath(); c.arc(top.x, top.y, 3 + glow * 5, 0, TAU); c.fill();
      c.globalAlpha = 1; c.fillStyle = col.accent; c.beginPath(); c.arc(top.x, top.y, 1.5, 0, TAU); c.fill();
      if (bolt) {  // lightning, redrawn jagged every frame
        c.strokeStyle = col.accent; c.lineWidth = 1.3;
        for (let pass = 0; pass < 2; pass++) {
          c.globalAlpha = pass ? 0.4 : 1;
          c.beginPath(); c.moveTo(top.x, top.y);
          for (let k = 1; k < 6; k++) { const q = k / 6; c.lineTo(lerp(top.x, bolt.tx, q) + rnd(-1.5, 1.5), lerp(top.y, bolt.ty, q) + rnd(-3, 3)); }
          c.lineTo(bolt.tx, bolt.ty); c.stroke();
        }
        c.globalAlpha = 1;
      }
      c.strokeStyle = col.dim; c.lineWidth = 1;  // smoke rings
      for (const r of rings) { const q = 1 - r.life / 1.6; c.globalAlpha = (1 - q) * 0.9; c.beginPath(); c.ellipse(r.x, r.y, 1.5 + q * 4, (1.5 + q * 4) * 0.55, -0.2, 0, TAU); c.stroke(); }
      c.globalAlpha = 1;
      for (const s of stars) {  // little four-point stars
        c.globalAlpha = Math.max(0, s.life / s.max); c.fillStyle = col.accent;
        const r = s.s; c.beginPath(); c.moveTo(s.x, s.y - r); c.lineTo(s.x + r * 0.3, s.y - r * 0.3); c.lineTo(s.x + r, s.y); c.lineTo(s.x + r * 0.3, s.y + r * 0.3); c.lineTo(s.x, s.y + r); c.lineTo(s.x - r * 0.3, s.y + r * 0.3); c.lineTo(s.x - r, s.y); c.lineTo(s.x - r * 0.3, s.y - r * 0.3); c.closePath(); c.fill();
      }
      c.globalAlpha = 1;
      dots(c, col, sparks);
    }
    return { step, draw, probe: () => ({ act: act?.kind, ws }) };
  }

  const KINDS = { dragon, soccer, wizard };
  window.CritterMakers = KINDS;  // for the preview page and tests
  for (const [name, make] of Object.entries(KINDS)) window.WorkAnim?.register(name, () => stage(make));
})();
