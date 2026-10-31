// SPDX-License-Identifier: Apache-2.0
/**
 * Hive stage canvas: neon ring, orbit text, brain disc, inner comets and the comet streams from every project card into the ring.
 * Ported from the owner-approved artifact (its 2D drawing; timing, colours and sizes are unchanged). The mount owns the loop
 * (requestAnimationFrame, pause when hidden, reduced motion); this module only draws a frame when asked.
 */

const TAU = 6.2832;
const INNER_COL = ['#2fe0a0', '#4d7cff', '#ff4d7e', '#ffb62e', '#a98bff'];
const ORBIT_TEXT = '  ONE LEDGER  ·  MANY WORKERS  ·  NOTHING GUESSED  ·  EVERY MERGE CHECKED  ·';
const MAX_PARTS = 400;
const MAX_INNER = 160;

/** Shared ambient budget: at most 30 fps, a composed static frame after 5s without input.
 * No callbacks are scheduled while idle, hidden, offscreen or under reduced motion.
 * CSS animations freeze at their current phase too, preserving the composed picture.
 */
export function mountAmbientMotion({ element, visibilityElement = element, doc = globalThis.document, win = globalThis,
  raf = win.requestAnimationFrame?.bind(win), caf = win.cancelAnimationFrame?.bind(win),
  media = win.matchMedia?.('(prefers-reduced-motion: reduce)'), draw, frameMs = 1000 / 30,
  paused = () => false, onVisibility = () => {}, freezeCss = true }) {
  let frame = null;
  let timer = null;
  let last = null;
  let activeSince = null;
  let visible = true;
  let idle = false;
  let destroyed = false;
  const frozen = new Set();
  const canRun = () => !destroyed && !doc?.hidden && visible && !media?.matches && !paused() && !idle;
  function syncCss(moving) {
    if (!freezeCss) return;
    if (moving) {
      for (const animation of frozen) animation.play();
      frozen.clear();
    } else {
      for (const animation of element?.getAnimations?.({ subtree: true }) || []) {
        if (animation.playState === 'running') { animation.pause(); frozen.add(animation); }
      }
    }
  }
  function stop() {
    if (frame != null) caf?.(frame);
    if (timer != null) win.clearTimeout?.(timer);
    frame = timer = null;
    last = null;
  }
  function tick(ts) {
    frame = null;
    if (activeSince == null) activeSince = ts;
    if (ts - activeSince >= 5000) idle = true;
    if (!canRun()) { stop(); syncCss(false); return; }
    if (last == null || ts - last >= frameMs) {
      const dt = last == null ? 0 : Math.min(0.1, (ts - last) / 1000);
      last = ts;
      draw(dt, ts);
    }
    frame = raf?.(tick) ?? null;
  }
  function sync() {
    const moving = canRun();
    syncCss(moving);
    if (!moving) { stop(); return; }
    if (frame == null && raf) frame = raf(tick);
    if (timer == null && win.setTimeout) {
      timer = win.setTimeout(() => { timer = null; idle = true; sync(); }, 5000);
      timer?.unref?.();
    }
  }
  function wake() { idle = false; activeSince = null; if (timer != null) win.clearTimeout?.(timer); timer = null; sync(); }
  const visibility = () => { onVisibility(); sync(); };
  const events = [['pointermove', wake], ['pointerdown', wake], ['keydown', wake], ['visibilitychange', visibility]];
  for (const [name, fn] of events) doc?.addEventListener?.(name, fn, { passive: true });
  media?.addEventListener?.('change', sync);
  const observer = win.IntersectionObserver ? new win.IntersectionObserver(entries => {
    visible = entries[entries.length - 1].isIntersecting; sync();
  }) : null;
  if (visibilityElement) observer?.observe(visibilityElement);
  sync();
  return { sync, wake, destroy() {
    destroyed = true; stop(); observer?.disconnect();
    for (const [name, fn] of events) doc?.removeEventListener?.(name, fn);
    media?.removeEventListener?.('change', sync);
    for (const animation of frozen) if (animation.playState === 'paused') animation.play();
    frozen.clear();
  } };
}

/** Reconcile detached render output. Existing elements, focus and event handlers survive polls. */
export function reconcileDom(target, next) {
  const attrs = node => node.attributes?.[Symbol.iterator]
    ? [...node.attributes].map(a => [a.name, a.value]) : Object.entries(node.attributes || {});
  function patch(current, wanted) {
    if (current.nodeType === 3) {
      if (current.textContent !== wanted.textContent) current.textContent = wanted.textContent;
      return;
    }
    for (const [name, value] of attrs(wanted)) if (current.getAttribute(name) !== value) current.setAttribute(name, value);
    for (const [name] of attrs(current)) if (wanted.getAttribute(name) == null) current.removeAttribute?.(name);
    if (wanted.getAttribute?.('data-cc-visual') != null) return;
    // Small DOM test doubles expose style and className separately from attributes.
    if (!current.nodeType) {
      if (current.className !== wanted.className) current.className = wanted.className;
      Object.assign(current.style || {}, wanted.style);
      if (current.textContent !== wanted.textContent) current.textContent = wanted.textContent;
    }
    reconcileDom(current, wanted);
  }
  const children = node => Array.from(node.nodeType ? node.childNodes : node.children || []);
  const wanted = children(next);
  const old = children(target);
  const key = node => node?.getAttribute?.('data-ticket-id') || node?.getAttribute?.('data-project-id');
  for (let i = 0; i < wanted.length; i++) {
    const item = wanted[i];
    let current = children(target)[i];
    const id = key(item);
    if (id && key(current) !== id) {
      const match = old.find(n => key(n) === id && children(target).includes(n));
      if (match && target.insertBefore) { target.insertBefore(match, current || null); current = match; }
      else if (!match && current && target.insertBefore) { target.insertBefore(item, current); continue; }
    }
    if (current && current.nodeType === item.nodeType && current.tagName === item.tagName && (!id || key(current) === id)) patch(current, item);
    else if (current && target.replaceChild) target.replaceChild(item, current);
    else { if (current) target.removeChild(current); target.appendChild(item); }
  }
  for (const extra of children(target).slice(wanted.length)) target.removeChild(extra);
}

/** Card centres on an ellipse around the ring, first card at the top, clockwise. */
export function cardPositions(w, h, n) {
  const rx = Math.min(w * 0.38, 500);
  const ry = h * 0.405;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    out.push({ x: w / 2 + Math.cos(a) * rx, y: h / 2 + Math.sin(a) * ry, a });
  }
  return out;
}

/**
 * @param {{ canvas: HTMLCanvasElement, createCanvas: () => HTMLCanvasElement }} deps
 */
export function createHiveStage(deps) {
  const { canvas, createCanvas } = deps;
  const cx = canvas.getContext('2d');
  let W = 0;
  let H = 0;
  let phone = false;
  let RING_R = 230;
  let tt = 0;
  let ringL = null;
  let ringKey = '';
  let txtL = null;
  let cards = [];
  const fx = { pulse: 0, flick: 0 };
  const parts = [];
  const sparks = [];
  const inn = [];
  const activity = { agents: 0, done24: 0 };

  const RK = () => RING_R / 246;
  const bld = () => Math.min(activity.agents, 3);
  const act = () => (activity.agents >= 3 ? 1 : activity.agents > 0 ? 0.7 : 0.25);

  function resize(width, height, isPhone) {
    phone = Boolean(isPhone);
    ringKey = '';
    txtL = null;
    W = canvas.width = Math.floor(width);
    H = canvas.height = Math.floor(height);
    RING_R = phone ? Math.floor(Math.min(W, H) * 0.36) : 230;
  }

  /** cards: [{ x, y, a, col, cat }] in stage pixels; cat 'off' draws a dotted tether only. */
  function setCards(list) { cards = list.slice(); }
  function setActivity(next) { activity.agents = next.agents || 0; activity.done24 = next.done24 || 0; }
  function pulse() { fx.pulse = 1; }
  function flick() { fx.flick = 0.35; }

  function spawn(k, n) {
    for (let i = 0; i < n && parts.length < MAX_PARTS; i += 1) {
      parts.push({ k, p: Math.random() * 0.12, sp: 0.005 + Math.random() * 0.006 * (1 + bld()), off: (Math.random() + Math.random() - 1) * 30, c: k.col, len: 10 + Math.random() * 10 });
    }
  }

  /** Burst of sparks at the ring point of one card (a failed run), amber like the artifact. */
  function sparkAt(k, color) {
    const ax = W / 2 + Math.cos(k.a) * RING_R;
    const ay = H / 2 + Math.sin(k.a) * RING_R;
    for (let i = 0; i < 40; i += 1) sparks.push({ x: ax, y: ay, vx: (Math.random() - 0.5) * 7, vy: (Math.random() - 0.5) * 7, l: 1.2, c: color });
  }

  function curve(k, e) {
    const x0 = k.x, y0 = k.y;
    const x1 = W / 2 + Math.cos(k.a) * RING_R, y1 = H / 2 + Math.sin(k.a) * RING_R;
    const mx = (x0 + x1) / 2 + (y1 - y0) * 0.12, my = (y0 + y1) / 2 - (x1 - x0) * 0.12;
    const u = 1 - e;
    return [u * u * x0 + 2 * u * e * mx + e * e * x1, u * u * y0 + 2 * u * e * my + e * e * y1];
  }

  /* static layers are drawn once (ring glow, ticks, inner disc, orbit text) and only redrawn when the size or the failure flicker changes */
  function buildRing(hot) {
    const c = createCanvas();
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const x = W / 2, y = H / 2, R = RING_R;
    g.globalCompositeOperation = 'lighter';
    const cg = g.createConicGradient ? g.createConicGradient(-Math.PI / 2, x, y) : null;
    const stops = hot ? [[0, '255,182,46'], [0.5, '255,120,60'], [1, '255,182,46']] : [[0, '255,46,136'], [0.35, '255,95,168'], [0.65, '176,107,255'], [1, '255,46,136']];
    for (const [lw, al] of [[120, 0.06], [76, 0.10], [46, 0.18], [26, 0.34], [15, 0.62], [9, 0.95]]) {
      let st;
      if (cg) {
        st = g.createConicGradient(-Math.PI / 2, x, y);
        for (const [o, col] of stops) st.addColorStop(o, `rgba(${col},${al})`);
      } else {
        st = g.createLinearGradient(x - R, y - R, x + R, y + R);
        st.addColorStop(0, `rgba(${stops[0][1]},${al})`);
        st.addColorStop(1, `rgba(176,107,255,${al})`);
      }
      g.strokeStyle = st; g.lineWidth = lw; g.beginPath(); g.arc(x, y, R, 0, TAU); g.stroke();
    }
    g.strokeStyle = 'rgba(255,170,215,.9)'; g.lineWidth = 1.4; g.beginPath(); g.arc(x, y, R, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(255,77,126,.34)'; g.lineWidth = 1; g.setLineDash([3, 6]); g.beginPath(); g.arc(x, y, R - 18, 0, TAU); g.stroke(); g.setLineDash([]);
    g.strokeStyle = 'rgba(169,139,255,.30)'; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, R - 36, 0, TAU); g.stroke();
    g.beginPath(); g.arc(x, y, R + 40, 0, TAU); g.setLineDash([2, 9]); g.stroke(); g.setLineDash([]);
    g.strokeStyle = 'rgba(169,139,255,.07)';
    for (let i = 0; i < 24; i += 1) { const an = i / 24 * TAU; g.beginPath(); g.moveTo(x + Math.cos(an) * 142 * RK(), y + Math.sin(an) * 142 * RK()); g.lineTo(x + Math.cos(an) * (R - 36), y + Math.sin(an) * (R - 36)); g.stroke(); }
    for (let i = 0; i < 900; i += 1) { const an = Math.random() * TAU, rr = R + (Math.random() - 0.5) * 34; g.fillStyle = Math.random() < 0.5 ? 'rgba(255,150,190,.8)' : 'rgba(190,160,255,.8)'; g.fillRect(x + Math.cos(an) * rr, y + Math.sin(an) * rr, 1.4, 1.4); }
    g.strokeStyle = 'rgba(169,139,255,.14)';
    for (let i = 0; i < 72; i += 1) { const an = i / 72 * TAU, l = i % 6 ? 10 : 15; g.beginPath(); g.moveTo(x + Math.cos(an) * (R + 6), y + Math.sin(an) * (R + 6)); g.lineTo(x + Math.cos(an) * (R + l), y + Math.sin(an) * (R + l)); g.stroke(); }
    g.globalCompositeOperation = 'source-over'; g.fillStyle = '#05060b'; g.beginPath(); g.arc(x, y, 118 * RK(), 0, TAU); g.fill();
    g.strokeStyle = 'rgba(138,107,255,.9)'; g.lineWidth = 2.4; g.beginPath(); g.arc(x, y, 120 * RK(), 0, TAU); g.stroke();
    g.globalCompositeOperation = 'lighter'; g.strokeStyle = 'rgba(138,107,255,.25)'; g.lineWidth = 16 * RK(); g.beginPath(); g.arc(x, y, 150 * RK(), 0, TAU); g.stroke();
    return c;
  }

  function buildText() {
    const S = (RING_R + 60) * 2;
    const c = createCanvas();
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(232,228,255,.98)';
    g.font = '600 12px "Geist Mono", monospace';
    const rt = RING_R + 19, step = TAU / ORBIT_TEXT.length;
    for (let i = 0; i < ORBIT_TEXT.length; i += 1) {
      const an = i * step - Math.PI / 2;
      g.save(); g.translate(S / 2 + Math.cos(an) * rt, S / 2 + Math.sin(an) * rt); g.rotate(an + Math.PI / 2); g.fillText(ORBIT_TEXT[i], 0, 0); g.restore();
    }
    return c;
  }

  /* comet streaks inside the ring: a few white heads with tinted tails sliding from the ring toward the core disc; more of them when agents are live */
  function comets(x, y, a, hot) {
    const n = a >= 1 ? 4 : a > 0.5 ? 3 : 2, R = RING_R, d0 = 120 * RK();
    cx.save(); cx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i += 1) {
      const ph = (tt * (0.09 + 0.03 * i) + i * 0.37) % 1, a0 = i * 2.4 + 0.6 + tt * 0.04, an = a0 - ph * 0.5, rr = R * 0.9 - ph * (R * 0.9 - d0 - 8);
      const hx = x + Math.cos(an) * rr, hy = y + Math.sin(an) * rr;
      const tl = 34 + 22 * a, tx = Math.cos(an + 0.55), ty = Math.sin(an + 0.55);
      const ex = hx + tx * tl, ey = hy + ty * tl, al = Math.sin(ph * Math.PI);
      const gr = cx.createLinearGradient(hx, hy, ex, ey);
      gr.addColorStop(0, `rgba(255,255,255,${0.95 * al})`);
      gr.addColorStop(0.25, hot ? `rgba(255,182,46,${0.5 * al})` : `rgba(190,170,255,${0.5 * al})`);
      gr.addColorStop(1, 'rgba(120,90,255,0)');
      cx.strokeStyle = gr; cx.lineCap = 'round'; cx.lineWidth = 3.4; cx.beginPath(); cx.moveTo(hx, hy); cx.lineTo(ex, ey); cx.stroke();
      const hg = cx.createRadialGradient(hx, hy, 0, hx, hy, 9);
      hg.addColorStop(0, `rgba(255,255,255,${al})`); hg.addColorStop(0.35, `rgba(220,210,255,${0.5 * al})`); hg.addColorStop(1, 'rgba(160,120,255,0)');
      cx.fillStyle = hg; cx.beginPath(); cx.arc(hx, hy, 9, 0, TAU); cx.fill();
    }
    cx.restore();
  }

  /** Streams from each card: a feathered bundle of faint curves, plus (animated only) dust at the ring end. */
  function drawStreams(x, y, still) {
    for (const k of cards) {
      const ax0 = x + Math.cos(k.a) * RING_R, ay0 = y + Math.sin(k.a) * RING_R;
      if (k.cat === 'off') {
        cx.strokeStyle = 'rgba(150,160,180,.32)'; cx.setLineDash([2, 6]); cx.lineWidth = 1; cx.beginPath(); cx.moveTo(k.x, k.y); cx.lineTo(ax0, ay0); cx.stroke(); cx.setLineDash([]);
        continue;
      }
      const busyK = k.cat === 'need' || k.cat === 'building';
      cx.strokeStyle = k.col; cx.lineWidth = 1;
      for (let j = -5; j <= 5; j += 1) {
        cx.globalAlpha = (busyK ? 0.38 : 0.26) * (1 - Math.abs(j) / 6.5);
        const spread = j * (bld() ? 17 : 12);
        const nx = Math.cos(k.a + Math.PI / 2), ny = Math.sin(k.a + Math.PI / 2);
        cx.beginPath(); cx.moveTo(k.x + nx * j * 3, k.y + ny * j * 3);
        cx.quadraticCurveTo((k.x + ax0) / 2 + nx * spread * 0.6, (k.y + ay0) / 2 + ny * spread * 0.6, ax0 + nx * spread * 0.55, ay0 + ny * spread * 0.55);
        cx.stroke();
      }
      cx.globalAlpha = 1;
      if (still) continue;
      const n = busyK ? 26 : 14;
      cx.fillStyle = k.col;
      for (let i = 0; i < n; i += 1) {
        const d = Math.random() * 46, sp = (Math.random() - 0.5) * 0.9;
        cx.globalAlpha = (1 - d / 46) * (0.4 + Math.random() * 0.6);
        cx.fillRect(ax0 - Math.cos(k.a + sp) * d, ay0 - Math.sin(k.a + sp) * d, 1.6, 1.6);
      }
      cx.globalAlpha = 1;
    }
  }

  /** One frame. still = true draws the settled picture only (reduced motion, hidden tab, paused). */
  function draw(dt, still) {
    cx.globalCompositeOperation = 'source-over';
    cx.clearRect(0, 0, W, H);
    if (!W || !H) return;
    try {
      if (!still) tt += dt;
      const a = act(), x = W / 2, y = H / 2, hot = fx.flick > 0;
      const key = W + 'x' + H + (hot ? 'h' : '');
      if (key !== ringKey) { ringL = buildRing(hot); ringKey = key; if (!txtL) txtL = buildText(); }
      cx.globalAlpha = still ? 0.95 : 0.9 + 0.1 * Math.sin(tt * 2.1);
      cx.drawImage(ringL, 0, 0);
      cx.globalAlpha = 1;
      cx.save(); cx.translate(x, y); cx.rotate(tt * 0.05); cx.drawImage(txtL, -txtL.width / 2, -txtL.height / 2); cx.restore();
      cx.globalCompositeOperation = 'lighter';
      if (!still && fx.pulse > 0) { cx.strokeStyle = `rgba(255,77,126,${fx.pulse * 0.6})`; cx.lineWidth = 3; cx.beginPath(); cx.arc(x, y, RING_R + (1 - fx.pulse) * 40, 0, TAU); cx.stroke(); }
      if (!still) comets(x, y, a, hot);
      if (!phone) drawStreams(x, y, still);
      if (still) { cx.globalCompositeOperation = 'source-over'; return; }
      /* inner comets: one per ten completions in the last 24 h per second (real count), plus four per live agent; they spiral from the ring into the core */
      { const rate = (activity.done24 / 10 + activity.agents * 4 + 3) * dt; let n = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0); while (n-- > 0 && inn.length < MAX_INNER) inn.push({ a: Math.random() * TAU, p: 0, sp: 0.5 + Math.random() * 0.6, c: INNER_COL[Math.floor(Math.random() * 5)], tw: (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 0.8) }); }
      cx.globalCompositeOperation = 'lighter';
      for (const q of inn) {
        q.p += q.sp * dt * 0.9;
        const rr = RING_R * (0.96 - 0.62 * q.p * q.p), an = q.a + q.tw * q.p * 2.2;
        const px = x + Math.cos(an) * rr, py = y + Math.sin(an) * rr;
        const rr2 = RING_R * (0.96 - 0.62 * Math.max(0, q.p - 0.06) ** 2), an2 = q.a + q.tw * Math.max(0, q.p - 0.06) * 2.2;
        cx.strokeStyle = q.c; cx.globalAlpha = (1 - q.p) * 0.8; cx.lineWidth = 2; cx.beginPath(); cx.moveTo(x + Math.cos(an2) * rr2, y + Math.sin(an2) * rr2); cx.lineTo(px, py); cx.stroke();
      }
      cx.globalAlpha = 1;
      for (let i = inn.length - 1; i >= 0; i -= 1) if (inn[i].p >= 1) inn.splice(i, 1);
      cx.globalCompositeOperation = 'source-over';
      for (const q of parts) {
        q.p += q.sp * dt * 60;
        const e = q.p * q.p * (3 - 2 * q.p);
        const [px, py] = curve(q.k, e);
        const o = q.off * (1 - e);
        cx.strokeStyle = q.c;
        for (let t2 = 0; t2 < 6; t2 += 1) {
          const e0 = Math.max(0, e - (t2 + 1) * 0.022), e1 = Math.max(0, e - t2 * 0.022);
          const [ax, ay] = curve(q.k, e0), [bx, by2] = curve(q.k, e1);
          cx.globalAlpha = Math.min(1, q.p * 3) * (1 - t2 / 6) * 0.85; cx.lineWidth = 3.4 - t2 * 0.45;
          cx.beginPath(); cx.moveTo(ax + o, ay); cx.lineTo(bx + o, by2); cx.stroke();
        }
        cx.globalAlpha = 0.9; cx.fillStyle = q.c; cx.fillRect(px + o - 2, py - 2, 4, 4);
        cx.fillStyle = '#fff'; cx.fillRect(px + o - 0.8, py - 0.8, 1.6, 1.6); cx.globalAlpha = 1;
        if (q.p >= 1) for (let s = 0; s < 12; s += 1) sparks.push({ x: px, y: py, vx: (Math.random() - 0.5) * 4.5, vy: (Math.random() - 0.5) * 4.5, l: 1, c: q.c });
      }
      for (let i = parts.length - 1; i >= 0; i -= 1) if (parts[i].p >= 1) parts.splice(i, 1);
      for (const s of sparks) { s.x += s.vx; s.y += s.vy; s.l -= dt * 2.2; cx.fillStyle = s.c; cx.globalAlpha = Math.max(0, s.l); cx.fillRect(s.x, s.y, 2, 2); }
      cx.globalAlpha = 1;
      for (let i = sparks.length - 1; i >= 0; i -= 1) if (sparks[i].l <= 0) sparks.splice(i, 1);
      if (fx.pulse > 0) fx.pulse -= dt * 1.2;
      if (fx.flick > 0) fx.flick -= dt;
    } catch {
      // A canvas without the full 2D API (tests, very old browsers) draws nothing more.
    }
  }

  /** Per-frame work of the animated loop: seed comet particles on the live cards, then draw. */
  function frame(dt) {
    if (!phone) {
      for (const k of cards) {
        if (k.cat === 'off') continue;
        const rate = k.cat === 'need' || k.cat === 'building' ? 1.6 : k.cat === 'idle' ? 0.9 : 0.6;
        if (Math.random() < rate * (act() + 0.5) + 0.2) spawn(k, bld() ? 5 : 2);
      }
    }
    draw(dt, false);
  }

  return {
    resize, setCards, setActivity, pulse, flick, spawn, sparkAt, frame,
    drawStill() { draw(0, true); },
    /** Frame interval in ms: slower while nothing is running (artifact: 50 ms calm, 33 ms live). */
    frameMs() { return activity.agents > 0 ? 33 : 50; },
    get size() { return { w: W, h: H, ringR: RING_R }; },
  };
}

// Navigation shared by boot and the legacy router, without importing legacy visual dependencies.
/**
 * Navigation state:
 * - `{ view: 'hive' }` — project ring overview
 * - `{ view: 'cockpit', projectId: string }` — single-project cockpit for that id
 *
 * Actions:
 * - `{ type: 'select-project', projectId: string }` — from hive, open cockpit for projectId
 * - `{ type: 'back' }` — from cockpit, return to hive in one transition
 *
 * @typedef {{ view: 'hive' }} CcHiveState
 * @typedef {{ view: 'cockpit', projectId: string }} CcCockpitState
 * @typedef {CcHiveState | CcCockpitState} CcNavState
 * @typedef {{ type: 'select-project', projectId: string } | { type: 'back' }} CcNavAction
 */

export const CC_INITIAL_STATE = Object.freeze({ view: 'hive' });

const CC_BASE_PATH = '/command-center';

/**
 * Map a URL pathname to command-center navigation state (deep-link entry).
 * @param {string} pathname
 * @returns {CcNavState}
 */
export function ccStateFromPath(pathname) {
  if (typeof pathname !== 'string') return { view: 'hive' };
  const raw = pathname.trim();
  if (!raw.startsWith(CC_BASE_PATH)) return { view: 'hive' };

  const suffix = raw.slice(CC_BASE_PATH.length);
  if (suffix === '' || suffix === '/') return { view: 'hive' };

  const projectMatch = /^\/project\/([^/]+)\/?$/.exec(suffix);
  if (projectMatch) {
    const projectId = projectMatch[1];
    if (typeof projectId === 'string' && projectId.length > 0) {
      return { view: 'cockpit', projectId };
    }
  }

  return { view: 'hive' };
}

/**
 * Pathname for a navigation state (inverse of {@link ccStateFromPath} for valid states).
 * @param {CcNavState | null | undefined} state
 * @returns {string}
 */
export function ccPathFromState(state) {
  const current = state && typeof state === 'object' ? state : CC_INITIAL_STATE;
  if (
    current.view === 'cockpit'
    && typeof current.projectId === 'string'
    && current.projectId.length > 0
  ) {
    return `${CC_BASE_PATH}/project/${current.projectId}`;
  }
  return CC_BASE_PATH;
}

/**
 * Pure reducer for command-center view transitions.
 * @param {CcNavState | null | undefined} state
 * @param {CcNavAction} action
 * @returns {CcNavState}
 */
export function ccNavigate(state, action) {
  const current = state && typeof state === 'object' ? state : CC_INITIAL_STATE;
  if (!action || typeof action !== 'object') return current;

  if (action.type === 'select-project') {
    const projectId = action.projectId;
    if (typeof projectId !== 'string' || projectId.length === 0) return current;
    return { view: 'cockpit', projectId };
  }

  if (action.type === 'back') {
    if (current.view === 'cockpit') return { view: 'hive' };
    return current;
  }

  return current;
}
