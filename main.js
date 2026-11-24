/* Hero scene: an ASCII shield deflecting incoming projectiles.
   Pure canvas text on a character grid. No libraries, no network. */
(function () {
  'use strict';

  var panel = document.getElementById('scene');
  if (!panel) return;
  var canvas = panel.querySelector('canvas');
  var ctx = canvas && canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;
  panel.classList.add('js');

  var FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  var BG = '#0B1F3A', LIGHT = '#CFE0FF', EDGE = '#60A5FA', AMBER = '#F59E0B',
      SLATE = '#64748B', WHITE = '#FFFFFF', CYAN = '#67E8F9';
  var PROMPT = '$ aegis --status protected';
  var GLYPHS = ['>', '»', '*', 'x', '#', '0', '1'];
  var FPS = 28, ROWS = 24, SHIELD_H = 11;
  var TRAIL = '·', BLOCK = '█';

  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var reduced = !!(mq && mq.matches);

  // layout state (rebuilt on resize)
  var cols = 0, rows = ROWS, cw = 8, lh = 16, ratio = 2, cssW = 0, cssH = 0, fs = 12;
  var solid, outline, interior, emblemCells, emblemClear, cxU, cyU, stat, sctx;
  // simulation state
  var projs = [], bursts = [], flashes = [], ripple = null;
  var t = 0, last = 0, nextSpawn = 0, nextRipple = 3, target = 4, nextTarget = 4;
  var raf = 0, inView = true, built = false;

  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function setFont(g) {
    g.font = fs + 'px ' + FONT;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
  }

  function cell(g, c, r, ch, color, alpha, clear) {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return;
    if (clear) {
      g.globalAlpha = 1;
      g.fillStyle = BG;
      g.fillRect(c * cw - 0.5, r * lh, cw + 1, lh);
    }
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.fillText(ch, (c + 0.5) * cw, (r + 0.5) * lh + 0.5);
  }

  function shade(g, c, r, color, alpha) {
    var x0 = Math.round(c * cw), x1 = Math.round((c + 1) * cw);
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.fillRect(x0, r * lh, x1 - x0, lh);
  }

  /* ---------- layout ---------- */
  function build() {
    var w = canvas.parentNode.clientWidth;
    if (w < 60) return false;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    fs = clamp(w / (56 * 0.6), 9, 14);
    ctx.font = fs + 'px ' + FONT;
    cw = ctx.measureText('M').width || fs * 0.6;
    lh = Math.round(fs * 1.25);
    ratio = lh / cw;
    cols = Math.floor(w / cw);
    if (cols % 2 === 0) cols -= 1; // odd width so the shield is exactly centred
    rows = ROWS;
    cssW = cols * cw; cssH = rows * lh;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.ceil(cssW * dpr);
    canvas.height = Math.ceil(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    setFont(ctx);

    stat = document.createElement('canvas');
    stat.width = canvas.width; stat.height = canvas.height;
    sctx = stat.getContext('2d');
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    setFont(sctx);

    buildShield();
    drawStatic();
    projs = []; bursts = []; flashes = []; ripple = null;
    built = true;
    return true;
  }

  function buildShield() {
    var H = SHIELD_H;
    var W = Math.round(H * ratio * 0.85);
    if (W % 2 === 0) W += 1;
    var w = (W - 1) / 2, r0 = Math.floor(H / 2);
    var mid = (cols - 1) / 2;
    var top = Math.floor((rows - 1 - H) / 2);
    cxU = mid + 0.5;
    cyU = (top + H / 2) * ratio;

    solid = new Uint8Array(cols * rows);
    outline = []; interior = []; emblemCells = []; emblemClear = [];
    var hw = [], r, x, i;
    for (r = 0; r < H; r++) {
      if (r === 0) hw[r] = w - 1;
      else if (r <= r0) hw[r] = w;
      else hw[r] = Math.round(w * (1 - Math.pow((r - r0) / (H - 1 - r0), 1.5)));
    }
    var isOutline = {};
    function addOutline(xx, rr, ch) {
      outline.push({ c: mid + xx, r: top + rr, ch: ch });
      isOutline[(top + rr) * cols + mid + xx] = 1;
    }
    for (r = 0; r < H; r++) {
      for (x = -hw[r]; x <= hw[r]; x++) solid[(top + r) * cols + mid + x] = 1;
      if (r === 0) { for (x = -hw[0]; x <= hw[0]; x++) addOutline(x, 0, '_'); continue; }
      if (r === H - 1) { addOutline(0, r, 'V'); continue; }
      var next = hw[r + 1], lo = r <= r0 ? hw[r] : Math.min(hw[r], next + 1);
      for (x = lo; x <= hw[r]; x++) {
        var outer = x === hw[r];
        addOutline(x, r, outer ? (r <= r0 ? '|' : '/') : '_');
        addOutline(-x, r, outer ? (r <= r0 ? '|' : '\\') : '_');
      }
    }
    for (r = 0; r < H; r++) {
      for (x = -hw[r]; x <= hw[r]; x++) {
        if (!isOutline[(top + r) * cols + mid + x]) interior.push({ c: mid + x, r: top + r });
      }
    }
    // "A_" emblem
    var A = ['    █    ', '   █ █   ', '  █████  ', ' █     █ ', '█       █'];
    var er = top + 3;
    for (r = 0; r < 5; r++) {
      for (i = 0; i < 9; i++) if (A[r].charAt(i) !== ' ') emblemCells.push({ c: mid - 5 + i, r: er + r, ch: BLOCK });
    }
    emblemCells.push({ c: mid + 5, r: er + 4, ch: '_' });
    var skip = {};
    emblemClear.forEach(function (e) { skip[e.r * cols + e.c] = 1; });
    interior = interior.filter(function (e) { return !skip[e.r * cols + e.c]; });
  }

  function drawStatic() {
    sctx.clearRect(0, 0, cssW, cssH);
    var i;
    for (i = 0; i < interior.length; i++) shade(sctx, interior[i].c, interior[i].r, LIGHT, 0.2);
    for (i = 0; i < outline.length; i++) if (outline[i].ch !== 'V' && outline[i].r !== outline[0].r) shade(sctx, outline[i].c, outline[i].r, LIGHT, 0.2);
    for (i = 0; i < outline.length; i++) cell(sctx, outline[i].c, outline[i].r, outline[i].ch, EDGE, 1, false);
    for (i = 0; i < emblemClear.length; i++) {
      sctx.globalAlpha = 1; sctx.fillStyle = BG;
      sctx.fillRect(emblemClear[i].c * cw - 0.5, emblemClear[i].r * lh, cw + 1, lh);
    }
    for (i = 0; i < emblemCells.length; i++) cell(sctx, emblemCells[i].c, emblemCells[i].r, emblemCells[i].ch, WHITE, 1, false);
    if (cols >= PROMPT.length + 4) {
      cell(sctx, 1, rows - 1, '$', EDGE, 1, false);
      for (i = 1; i < PROMPT.length; i++) {
        var ch = PROMPT.charAt(i);
        if (ch !== ' ') cell(sctx, 1 + i, rows - 1, ch, LIGHT, 1, false);
      }
    }
  }

  /* ---------- geometry ---------- */
  function solidAt(X, Y) {
    var c = Math.floor(X), r = Math.floor(Y / ratio);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
    return solid[r * cols + c] === 1;
  }

  // Surface normal from the local solid mask: average direction away from nearby solid cells.
  function normalAt(X, Y) {
    var c0 = Math.floor(X), r0 = Math.floor(Y / ratio), nx = 0, ny = 0, c, r;
    for (r = r0 - 2; r <= r0 + 2; r++) {
      for (c = c0 - 3; c <= c0 + 3; c++) {
        if (c < 0 || r < 0 || c >= cols || r >= rows || !solid[r * cols + c]) continue;
        var dx = X - (c + 0.5), dy = Y - (r + 0.5) * ratio, d = Math.sqrt(dx * dx + dy * dy) || 1;
        nx += dx / d; ny += dy / d;
      }
    }
    var m = Math.sqrt(nx * nx + ny * ny);
    if (m < 1e-3) { nx = X - cxU; ny = Y - cyU; m = Math.sqrt(nx * nx + ny * ny) || 1; }
    return { x: nx / m, y: ny / m };
  }

  /* ---------- simulation ---------- */
  function spawn() {
    var p = { glyph: GLYPHS[Math.floor(Math.random() * GLYPHS.length)], age: 0, state: 0, since: 0, trail: [], lastTx: 0, lastTy: 0 };
    var sceneH = (rows - 1) * ratio, roll = Math.random();
    if (roll < 0.4) { p.X = -1; p.Y = rand(1, sceneH - 1); }
    else if (roll < 0.8) { p.X = cols + 1; p.Y = rand(1, sceneH - 1); }
    else { p.X = rand(cols * 0.15, cols * 0.85); p.Y = -1; }
    var tx = cxU + rand(-6, 6), ty = cyU + rand(-6, 5);
    var dx = tx - p.X, dy = ty - p.Y, m = Math.sqrt(dx * dx + dy * dy) || 1;
    p.dx = dx / m; p.dy = dy / m;
    p.speed = rand(11, 18);
    p.lastTx = p.X; p.lastTy = p.Y;
    projs.push(p);
  }

  function burst(X, Y) {
    bursts.push({ X: X, Y: Y, t0: t });
    flashes.push({ X: X, Y: Y, t0: t });
  }

  function step(dt) {
    t += dt;
    if (t > nextTarget) { target = 3 + Math.floor(Math.random() * 4); nextTarget = t + 4; }
    if (projs.length < target && t > nextSpawn) { spawn(); nextSpawn = t + rand(0.5, 1.1); }
    if (!ripple && t > nextRipple) ripple = { t0: t };
    if (ripple && t - ripple.t0 > 2.6) { ripple = null; nextRipple = t + rand(4, 7); }

    var sceneBottom = rows * ratio;
    for (var i = projs.length - 1; i >= 0; i--) {
      var p = projs[i];
      p.age += dt;
      var e = Math.min(1, p.age / 0.9), ease = 0.3 + 0.7 * (1 - (1 - e) * (1 - e));
      var dist = p.speed * (p.state ? 1 : ease) * dt, n = Math.max(1, Math.ceil(dist / 0.4)), k;
      for (k = 0; k < n; k++) {
        p.X += p.dx * dist / n; p.Y += p.dy * dist / n;
        if (!p.state && solidAt(p.X, p.Y)) {
          var nm = normalAt(p.X, p.Y), dot = p.dx * nm.x + p.dy * nm.y;
          if (dot < 0) { p.dx -= 2 * dot * nm.x; p.dy -= 2 * dot * nm.y; }
          var guard = 0;
          while (solidAt(p.X, p.Y) && guard++ < 12) { p.X += nm.x * 0.35; p.Y += nm.y * 0.35; }
          p.state = 1; p.since = 0; p.speed *= 0.85;
          burst(p.X, p.Y);
        }
      }
      if (p.state) p.since += dt;
      if (Math.abs(p.X - p.lastTx) + Math.abs(p.Y - p.lastTy) > 1.1) {
        p.trail.unshift({ X: p.lastTx, Y: p.lastTy });
        if (p.trail.length > 4) p.trail.pop();
        p.lastTx = p.X; p.lastTy = p.Y;
      }
      if ((p.state && p.since > 1.5) || p.X < -4 || p.X > cols + 4 || p.Y < -4 || p.Y > sceneBottom + 4) projs.splice(i, 1);
    }
    for (i = bursts.length - 1; i >= 0; i--) if (t - bursts[i].t0 > 0.15) bursts.splice(i, 1);
    for (i = flashes.length - 1; i >= 0; i--) if (t - flashes[i].t0 > 0.45) flashes.splice(i, 1);
  }

  /* ---------- drawing ---------- */
  function putU(g, X, Y, ch, color, alpha) {
    var c = Math.floor(X), r = Math.floor(Y / ratio);
    if (r >= rows - 1 || alpha <= 0.02) return;
    cell(g, c, r, ch, color, alpha, false);
  }

  function drawBurst(g, b, f) {
    var rad = 0.8 + f * 1.8, ch = f < 0.4 ? '*' : f < 0.75 ? '+' : '.', a = 1 - f * 0.6, j;
    putU(g, b.X, b.Y, '*', WHITE, a);
    for (j = 0; j < 8; j++) {
      var ang = j * Math.PI / 4 + 0.4;
      putU(g, b.X + Math.cos(ang) * rad * 1.6, b.Y + Math.sin(ang) * rad * 1.6 * (ratio / 2) , ch, j % 2 ? CYAN : WHITE, a);
    }
  }

  function shieldGlow() {
    var i, a, d;
    if (ripple) {
      var R = (t - ripple.t0) * 6, fade = 1 - (t - ripple.t0) / 2.6;
      var spots = interior.concat(outline);
      for (i = 0; i < spots.length; i++) {
        var s = spots[i], dx = s.c + 0.5 - cxU, dy = (s.r + 0.5) * ratio - cyU;
        d = Math.sqrt(dx * dx + dy * dy) - R;
        a = Math.exp(-(d * d) / 2.6) * 0.65 * fade;
        if (a > 0.06) { if (s.ch) cell(ctx, s.c, s.r, s.ch, WHITE, a, false); else shade(ctx, s.c, s.r, WHITE, a * 0.45); }
      }
    }
    for (var f = 0; f < flashes.length; f++) {
      var fl = flashes[f], life = 1 - (t - fl.t0) / 0.45;
      for (i = 0; i < outline.length; i++) {
        var o = outline[i], ox = o.c + 0.5 - fl.X, oy = (o.r + 0.5) * ratio - fl.Y;
        d = Math.sqrt(ox * ox + oy * oy);
        if (d < 3) cell(ctx, o.c, o.r, o.ch, WHITE, Math.min(1, life * (1 - d / 3.4) * 1.4), false);
      }
    }
  }

  function render() {
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(stat, 0, 0, cssW, cssH);
    if (Math.floor(t / 0.53) % 2 === 0) cell(ctx, 1 + PROMPT.length + 1, rows - 1, BLOCK, LIGHT, 1, false);
    shieldGlow();
    var i, j;
    for (i = 0; i < projs.length; i++) {
      var p = projs[i], color = p.state ? SLATE : AMBER, al = p.state ? Math.max(0, 1 - p.since / 1.5) : 1;
      for (j = 0; j < p.trail.length; j++) putU(ctx, p.trail[j].X, p.trail[j].Y, TRAIL, color, al * (0.7 - j * 0.16));
      var g = p.glyph;
      if (p.dx < 0 && !p.state) g = g === '>' ? '<' : g === '»' ? '«' : g;
      putU(ctx, p.X, p.Y, g, color, al);
    }
    for (i = 0; i < bursts.length; i++) drawBurst(ctx, bursts[i], (t - bursts[i].t0) / 0.15);
  }

  /* One composed still frame: two projectiles caught mid-deflection, with impact marks. */
  function renderStill() {
    t = 0;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(stat, 0, 0, cssW, cssH);
    cell(ctx, 1 + PROMPT.length + 1, rows - 1, BLOCK, LIGHT, 1, false);
    var hits = [{ side: -1, rowOff: 2, vin: [1, 0.35] }, { side: 1, rowOff: 5, vin: [-1, -0.3] }];
    hits.forEach(function (h) {
      var cands = outline.filter(function (o) { return o.ch !== '_' && o.ch !== 'V' && (o.c + 0.5 < cxU) === (h.side < 0); });
      var top = Math.min.apply(null, outline.map(function (o) { return o.r; }));
      var o = cands.filter(function (q) { return q.r === top + h.rowOff; })[0] || cands[0];
      var X = o.c + 0.5 + h.side * 0.6, Y = (o.r + 0.5) * ratio;
      var m = Math.sqrt(h.vin[0] * h.vin[0] + h.vin[1] * h.vin[1]), vx = h.vin[0] / m, vy = h.vin[1] / m;
      var nm = normalAt(X, Y), dot = vx * nm.x + vy * nm.y;
      var ox = vx - 2 * dot * nm.x, oy = vy - 2 * dot * nm.y, k;
      for (k = 1; k <= 4; k++) putU(ctx, X - vx * k * 1.5, Y - vy * k * 1.5, TRAIL, AMBER, 0.75 - k * 0.15);
      for (k = 1; k <= 3; k++) putU(ctx, X + ox * k * 1.5, Y + oy * k * 1.5, TRAIL, SLATE, 0.8 - k * 0.2);
      putU(ctx, X + ox * 5.5, Y + oy * 5.5, '*', SLATE, 0.75);
      flashes.push({ X: X, Y: Y, t0: -0.05 });
      drawBurst(ctx, { X: X, Y: Y }, 0.25);
    });
    t = 0; shieldGlow(); flashes = [];
  }

  /* ---------- loop / lifecycle ---------- */
  function frame(now) {
    raf = 0;
    if (!running()) return;
    raf = requestAnimationFrame(frame);
    if (!last) { last = now; return; }
    if (now - last < 1000 / FPS - 2) return;
    var dt = Math.min((now - last) / 1000, 0.06);
    last = now;
    step(dt);
    render();
  }

  function running() { return built && !reduced && inView && !document.hidden; }

  function sync() {
    if (!built) return;
    if (reduced) { if (raf) { cancelAnimationFrame(raf); raf = 0; } renderStill(); return; }
    if (running()) { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } }
    else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function rebuild() {
    if (!build()) return;
    t = 0; nextSpawn = 0.3; nextRipple = 2.5;
    if (reduced) renderStill(); else render();
    sync();
  }

  var pending = 0;
  function onResize() {
    if (pending) return;
    pending = requestAnimationFrame(function () { pending = 0; rebuild(); });
  }

  if (window.ResizeObserver) new ResizeObserver(onResize).observe(canvas.parentNode);
  else window.addEventListener('resize', onResize);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) { inView = es[es.length - 1].isIntersecting; sync(); }).observe(panel);
  }
  document.addEventListener('visibilitychange', sync);
  if (mq) {
    var onMq = function (e) { reduced = e.matches; if (!reduced) { projs = []; bursts = []; flashes = []; } rebuild(); };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
  }
  rebuild();
})();
