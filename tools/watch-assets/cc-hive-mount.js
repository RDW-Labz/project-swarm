// SPDX-License-Identifier: Apache-2.0
/**
 * Command Center Hive: header counters, project cards on an ellipse around the neon ring, three panels under it.
 * Markup and motion follow the owner-approved artifact (docs/design/reference/command-center-artifact); every number
 * comes from the live snapshot (/api/command-center) and nothing is simulated.
 */

import { glitch, glitchFailure } from './cc-glitch.js';
import { mountAmbientMotion, reconcileDom } from './cc-hive-stage.js';

const TAU = Math.PI * 2;
const SVG_NS = 'http://www.w3.org/2000/svg';
const ARC_TEXT = 'EVERY MERGE CHECKED · ONE LEDGER · MANY WORKERS · NOTHING GUESSED ·';
// Particles per stream by colour category: busier projects spray denser streams.
const STREAM_DENSITY = { building: 120, need: 104, blocked: 84, done: 72, idle: 64, off: 24 };
// Bloomed 3-4 px sparks riding each stream.
const SPARKS_PER_STREAM = 4;
const RING_COLORS = ['#ff4d8d', '#c86bff', '#ffd6ec', '#ff3d8b'];

function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0xa98bff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Where everything sits. Desktop: cards on an ellipse that fills the stage, the ring as large as the cards allow.
 * Narrow screens: the canvas is a square above the cards, and each stream starts at the canvas edge.
 */
export function hiveGeometry(cw, ch, n, phone, cardW, cardH) {
  const w = Math.max(40, cw);
  const h = Math.max(40, ch);
  const cx = w / 2;
  const cy = h / 2;
  const nodes = [];
  let R;
  if (phone) {
    const edge = Math.min(w, h) / 2;
    R = Math.max(24, edge * 0.62);
    for (let i = 0; i < n; i += 1) {
      const a = -Math.PI / 2 + (i * TAU) / Math.max(1, n);
      nodes.push({ x: cx + Math.cos(a) * edge, y: cy + Math.sin(a) * edge, sx: cx + Math.cos(a) * edge * 0.98, sy: cy + Math.sin(a) * edge * 0.98, a, fan: 20 });
    }
  } else {
    const hw = cardW / 2;
    const hh = cardH / 2;
    const ry = Math.max(30, cy - hh - 4);
    const rx = Math.max(40, cx - hw - 6);
    // As large as the cards allow (about 30% of a 1440 px screen), leaving room for the arc label.
    let lim = ry * 0.7;
    for (let i = 0; i < n; i += 1) {
      const a = -Math.PI / 2 + (i * TAU) / Math.max(1, n);
      const x = cx + Math.cos(a) * rx;
      const y = cy + Math.sin(a) * ry;
      const dx = Math.max(0, Math.abs(x - cx) - hw);
      const dy = Math.max(0, Math.abs(y - cy) - hh);
      lim = Math.min(lim, Math.hypot(dx, dy) - 30);
      // Stream source: where the line from the card centre to the ring centre leaves the card.
      const len = Math.hypot(cx - x, cy - y) || 1;
      const ux = (cx - x) / len;
      const uy = (cy - y) / len;
      const t = Math.min(ux ? hw / Math.abs(ux) : Infinity, uy ? hh / Math.abs(uy) : Infinity);
      nodes.push({ x, y, sx: x + ux * t, sy: y + uy * t, a, fan: Math.min(58, hw * 0.4) });
    }
    R = Math.max(24, lim);
  }
  for (const k of nodes) {
    const b = Math.atan2(k.sy - cy, k.sx - cx);
    k.tx = cx + Math.cos(b) * R;
    k.ty = cy + Math.sin(b) * R;
    const len = Math.hypot(k.tx - k.sx, k.ty - k.sy) || 1;
    k.nx = -(k.ty - k.sy) / len;
    k.ny = (k.tx - k.sx) / len;
    // A slight swirl: every stream bends the same way round the ring.
    k.qx = (k.sx + k.tx) / 2 + k.nx * len * 0.16;
    k.qy = (k.sy + k.ty) / 2 + k.ny * len * 0.16;
  }
  return { w, h, cx, cy, R, coreR: R * 0.46, nodes };
}

/** Canvas layer of the Hive: dust, lane-coloured particle sprays into the ring, ring sparkles, comets and the core. */
function createHiveRenderer(canvas, makeCanvas) {
  const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  let geom = hiveGeometry(800, 600, 0, false, 270, 132);
  let streams = [];
  let streamSig = '';
  let seedKey = '';
  let sparkles = [];
  let dust = [];
  let comets = [];
  let time = 0;
  let speed = 1;
  let flash = 0;
  let flick = 0;
  let dpr = 1;
  let grads = null;
  const sprites = new Map();
  const sparkSprites = new Map();

  // Preserve the original circle + 9px shadow, rasterized once per particle size/colour.
  function sparkSprite(col, radius) {
    const key = `${col}|${radius}|${dpr}`;
    if (sparkSprites.has(key)) return sparkSprites.get(key);
    const c = makeCanvas();
    const pad = Math.ceil(radius * 3 + 24);
    c.width = c.height = pad * 2 * dpr;
    const context = c.getContext('2d');
    if (!context) return null;
    context.setTransform?.(dpr, 0, 0, dpr, 0, 0);
    context.globalCompositeOperation = 'lighter';
    context.fillStyle = context.shadowColor = col;
    context.shadowBlur = 9;
    context.beginPath(); context.arc(pad, pad, radius, 0, TAU); context.fill();
    const halo = sprite('#ffffff');
    const size = radius * 1.4;
    if (halo) { context.globalAlpha = 0.9; context.drawImage(halo, pad - size * 2, pad - size * 2, size * 4, size * 4); }
    const out = { canvas: c, pad };
    if (sparkSprites.size >= 128) sparkSprites.delete(sparkSprites.keys().next().value);
    sparkSprites.set(key, out);
    return out;
  }

  function sprite(col) {
    if (sprites.has(col)) return sprites.get(col);
    let out = null;
    try {
      const c = makeCanvas();
      c.width = 32;
      c.height = 32;
      const x = c.getContext('2d');
      const g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.14, rgba(col, 1));
      g.addColorStop(0.34, rgba(col, 0.5));
      g.addColorStop(0.62, rgba(col, 0.14));
      g.addColorStop(1, rgba(col, 0));
      x.fillStyle = g;
      x.fillRect(0, 0, 32, 32);
      out = c;
    } catch {
      out = null;
    }
    sprites.set(col, out);
    return out;
  }

  function glow(col, x, y, size, alpha) {
    if (alpha <= 0.01) return;
    ctx.globalAlpha = Math.min(1, alpha);
    const s = sprite(col);
    if (s && typeof ctx.drawImage === 'function') {
      ctx.drawImage(s, x - size * 2, y - size * 2, size * 4, size * 4);
    } else {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, TAU);
      ctx.fill();
    }
  }

  function seedStatic() {
    const area = geom.w * geom.h;
    dust = [];
    for (let i = 0, n = Math.min(160, Math.round(area / 7000)); i < n; i += 1) {
      dust.push({ x: Math.random() * geom.w, y: Math.random() * geom.h, a: 0.12 + Math.random() * 0.35, f: 0.4 + Math.random() * 1.6, p: Math.random() * TAU });
    }
    sparkles = [];
    for (let i = 0, n = Math.round(Math.max(60, geom.R * 0.9)); i < n; i += 1) {
      sparkles.push({ a: Math.random() * TAU, w: (0.05 + Math.random() * 0.3) * (Math.random() < 0.5 ? -1 : 1), dr: (Math.random() + Math.random() - 1) * 7, tw: 1 + Math.random() * 4, s: 0.8 + Math.random() * 1.8, col: RING_COLORS[i % RING_COLORS.length] });
    }
    comets = [];
    for (let i = 0; i < 3; i += 1) comets.push({ p: Math.random() * 1.6 - 0.6, v: 0.55 + Math.random() * 0.4, a: Math.random() * TAU });
  }

  function newParticle(p, fresh) {
    p.t = fresh ? Math.random() : -Math.random() * 0.25;
    p.v = (p.big ? 0.42 : 0.32) + Math.random() * 0.5;
    p.s0 = Math.random() * 2 - 1;
    p.ph = Math.random() * TAU;
    p.k = 3 + Math.random() * 5;
    p.size = p.big ? 3 + Math.random() : 1 + Math.random() * 1.5;
    p.hot = !p.big && Math.random() < 0.14;
    return p;
  }

  function setNodes(g, list) {
    geom = g;
    const sig = list.map((k) => `${k.col}|${k.cat}`).join(',');
    if (sig !== streamSig) {
      streamSig = sig;
      streams = list.map((k) => {
        const n = STREAM_DENSITY[k.cat] || 30;
        const parts = [];
        for (let i = 0; i < n; i += 1) parts.push(newParticle({ big: i < SPARKS_PER_STREAM }, true));
        return { col: k.col, cat: k.cat, parts, boost: 0, spark: 0 };
      });
    }
    try {
      grads = {
        haze: ctx.createRadialGradient(g.cx, g.cy, g.coreR, g.cx, g.cy, g.R * 1.05),
        core: ctx.createRadialGradient(g.cx, g.cy - g.coreR * 0.3, 0, g.cx, g.cy, g.coreR),
      };
      grads.haze.addColorStop(0, 'rgba(120,50,190,0.16)');
      grads.haze.addColorStop(0.7, 'rgba(160,40,140,0.10)');
      grads.haze.addColorStop(1, 'rgba(255,61,139,0)');
      grads.core.addColorStop(0, '#191127');
      grads.core.addColorStop(1, '#07060d');
    } catch {
      grads = null;
    }
    // Re-seed dust and sparkles only when the size changes, so a poll never makes them jump.
    const key = `${Math.round(g.w)}|${Math.round(g.h)}|${Math.round(g.R)}`;
    if (key !== seedKey) {
      seedKey = key;
      seedStatic();
    }
  }

  function streamPos(k, p, at) {
    const t = Math.max(0, Math.min(1, at === undefined ? p.t : at));
    const u = 1 - t;
    const bx = u * u * k.sx + 2 * u * t * k.qx + t * t * k.tx;
    const by = u * u * k.sy + 2 * u * t * k.qy + t * t * k.ty;
    const off = p.s0 * k.fan * Math.pow(u, 1.4) + Math.sin(p.ph + t * p.k + time * 1.7) * 12 * (1 - t * 0.7);
    return [bx + k.nx * off, by + k.ny * off];
  }

  function update(dt) {
    time += dt;
    flash = Math.max(0, flash - dt * 0.8);
    flick = Math.max(0, flick - dt * 1.6);
    for (const s of streams) {
      s.boost = Math.max(0, s.boost - dt * 0.6);
      s.spark = Math.max(0, s.spark - dt * 0.9);
      const f = speed * (1 + s.boost * 1.8) * (s.cat === 'off' ? 0.4 : 1);
      for (const p of s.parts) {
        p.t += p.v * f * dt;
        if (p.t > 1) newParticle(p, false);
      }
    }
    for (const sp of sparkles) sp.a += sp.w * dt;
    for (const c of comets) {
      c.p += c.v * dt;
      if (c.p > 1.15) {
        c.p = -Math.random() * 1.2;
        c.a = Math.random() * TAU;
      }
    }
  }

  function draw() {
    if (!ctx) return;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, geom.w, geom.h);
    try {
      paint();
    } catch {
      // A canvas without a full 2D API (tests, very old browsers) keeps the CSS ring and the cards.
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function paint() {
    const g = geom;
    const { cx, cy, R, coreR } = g;
    ctx.globalCompositeOperation = 'source-over';
    // dust
    ctx.fillStyle = '#ffffff';
    for (const d of dust) {
      ctx.globalAlpha = d.a * (0.55 + 0.45 * Math.sin(time * d.f + d.p));
      ctx.fillRect(d.x, d.y, 1.2, 1.2);
    }
    // violet haze between core and ring
    if (grads) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = grads.haze;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.05, 0, TAU);
      ctx.fill();
    }
    // radial spokes (~15%) and a dotted tick ring inside the band, turning slowly
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(210,150,255,1)';
    ctx.globalAlpha = 0.15;
    ctx.beginPath();
    const rot = time * 0.03;
    for (let i = 0; i < 48; i += 1) {
      const a = rot + (i * TAU) / 48;
      ctx.moveTo(cx + Math.cos(a) * coreR * 1.08, cy + Math.sin(a) * coreR * 1.08);
      ctx.lineTo(cx + Math.cos(a) * R * 0.8, cy + Math.sin(a) * R * 0.8);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.34;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([1.5, 5]);
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.74, 0, TAU);
    ctx.stroke();
    // dashed orbit outside the arc label, turning the other way
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = 'rgba(255,77,141,1)';
    ctx.setLineDash?.([10, 9]);
    ctx.beginPath();
    ctx.arc(cx, cy, R + 34, rot * -2, rot * -2 + TAU);
    ctx.stroke();
    ctx.setLineDash?.([]);

    ctx.globalCompositeOperation = 'lighter';
    // streams: glowing filaments, comet trails, bloomed heads, a few big sparks, then a bloom where each meets the ring
    streams.forEach((s, i) => {
      const k = g.nodes[i];
      if (!k) return;
      ctx.strokeStyle = s.col;
      ctx.lineWidth = 0.7;
      for (let j = 0; j < 9; j += 1) {
        const f = -1 + j * 0.25;
        const wob = Math.sin(time * 0.9 + j + i) * 6;
        ctx.globalAlpha = 0.16 + s.boost * 0.15;
        ctx.beginPath();
        ctx.moveTo(k.sx + k.nx * f * k.fan, k.sy + k.ny * f * k.fan);
        ctx.quadraticCurveTo(k.qx + k.nx * (f * k.fan * 0.55 + wob), k.qy + k.ny * (f * k.fan * 0.55 + wob), k.tx, k.ty);
        ctx.stroke();
      }
      const alive = [];
      for (const p of s.parts) {
        if (p.t <= 0) continue;
        const fade = Math.min(1, p.t * 5) * (p.t > 0.86 ? (1 - p.t) / 0.14 : 1);
        alive.push([p, streamPos(k, p), fade]);
      }
      // tapering trail: a long faint tail and a short bright neck, each batched into one path
      ctx.lineCap = 'round';
      for (const [from, to, w, a] of [[0.1, 0.035, 1, 0.22], [0.035, 0, 1.8, 0.55]]) {
        ctx.globalAlpha = a + s.boost * 0.1;
        ctx.lineWidth = w;
        ctx.beginPath();
        for (const [p] of alive) {
          if (p.t < from) continue;
          const [x0, y0] = streamPos(k, p, p.t - from);
          const [x1, y1] = streamPos(k, p, p.t - to);
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        }
        ctx.stroke();
      }
      // bloomed comet heads in the lane colour (sprite halo about 8 px)
      for (const [p, [x, y], fade] of alive) {
        if (p.big) continue;
        glow(p.hot ? '#ffffff' : s.col, x, y, p.size * 0.6 + 2.6, fade * (0.95 + s.boost * 0.3));
      }
      // white-hot cores, one fill
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      for (const [p, [x, y], fade] of alive) {
        if (p.big) continue;
        const r = p.size * 0.45 * fade;
        if (r < 0.2) continue;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
      }
      ctx.fill();
      // sparks: 3-4 px with a real shadow bloom (only a handful per stream, so the blur stays cheap)
      ctx.fillStyle = s.col;
      for (const [p, [x, y], fade] of alive) {
        if (!p.big) continue;
        ctx.globalAlpha = fade;
        const dot = sparkSprite(s.col, p.size * 0.5);
        if (dot) ctx.drawImage(dot.canvas, x - dot.pad, y - dot.pad, dot.pad * 2, dot.pad * 2);
      }
      const pulse = 0.6 + 0.18 * Math.sin(time * 2.2 + i) + s.spark * 0.6;
      glow(s.col, k.tx, k.ty, 16, pulse);
      if (s.spark > 0) glow('#ffb62e', k.sx, k.sy, 14, s.spark);
    });

    // the ring: hot line, a sweeping highlight, sparkles riding the band
    const hot = flick > 0 && Math.sin(time * 60) > 0 ? '#ff5a5a' : '#ffd6ec';
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = hot;
    ctx.lineWidth = 2.2 + flash * 3;
    ctx.shadowColor = '#ff3d8b';
    ctx.shadowBlur = 16 + flash * 20;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.stroke();
    const sweep = time * 0.7;
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(cx, cy, R, sweep, sweep + 0.5);
    ctx.stroke();
    ctx.shadowBlur = 0;
    for (const sp of sparkles) {
      const r = R + sp.dr;
      glow(sp.col, cx + Math.cos(sp.a) * r, cy + Math.sin(sp.a) * r, sp.s, 0.25 + 0.6 * Math.abs(Math.sin(time * sp.tw + sp.a * 3)));
    }
    // comets falling from the ring towards the core
    for (const c of comets) {
      if (c.p <= 0 || c.p >= 1) continue;
      const r = R * 0.94 - c.p * (R * 0.94 - coreR * 1.08);
      const x = cx + Math.cos(c.a) * r;
      const y = cy + Math.sin(c.a) * r;
      const tail = 30 * (1 - c.p * 0.4);
      const ex = x + Math.cos(c.a) * tail;
      const ey = y + Math.sin(c.a) * tail;
      const lg = ctx.createLinearGradient(x, y, ex, ey);
      lg.addColorStop(0, 'rgba(255,255,255,0.95)');
      lg.addColorStop(1, 'rgba(255,120,200,0)');
      ctx.globalAlpha = Math.sin(c.p * Math.PI);
      ctx.strokeStyle = lg;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      glow('#ffffff', x, y, 2.4, Math.sin(c.p * Math.PI));
    }

    // core disc with its violet rim
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = grads ? grads.core : '#0b0814';
    ctx.strokeStyle = '#a98bff';
    ctx.lineWidth = 1.6;
    ctx.shadowColor = '#8b5cf6';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  return {
    get geom() { return geom; },
    resize(w, h, ratio) {
      dpr = Math.max(1, Math.min(2, ratio || 1));
      const bw = Math.round(Math.max(1, w) * dpr);
      const bh = Math.round(Math.max(1, h) * dpr);
      // Setting the backing size clears the canvas, so only do it when it really changed.
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
    },
    setNodes,
    setActivity({ agents }) { speed = 1 + Math.min(20, Math.max(0, agents || 0)) * 0.025; },
    frameMs: () => 1000 / 30,
    frame(dt) { update(dt); draw(); },
    drawStill() { draw(); },
    spawn(i) { if (streams[i]) streams[i].boost = 1.5; },
    sparkAt(i) { if (streams[i]) streams[i].spark = 1; },
    pulse() { flash = 1; },
    flick() { flick = 1; },
  };
}

let hivePanelsApi = null;

function resolveHivePanels() {
  if (hivePanelsApi) return hivePanelsApi;
  const globalApi = globalThis.HivePanels;
  if (globalApi && typeof globalApi.renderHiveDashboard === 'function') {
    hivePanelsApi = globalApi;
    return hivePanelsApi;
  }
  throw new Error('HivePanels is not available; load hive-panels.js before cc-hive-mount.js');
}

const ICON_BASE = '/assets/vendor/fluent-emoji/';
const TOAST_ICON = { volt: 'high_voltage_56.webp', done: 'party_popper_56.webp', think: 'thinking_face_56.webp' };
const PHONE_MAX = 900;
const RAW_URL = '/api/command-center';

function h(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function padPct(pct) {
  return pct >= 100 ? '1.00' : `.${String(Math.round(pct)).padStart(2, '0')}`;
}

function formatGenerated(at) {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function readWatchToken(win) {
  try {
    const params = new URLSearchParams(win.location?.search || '');
    const q = params.get('t');
    if (q) return q;
  } catch {
    // fall through to storage
  }
  try {
    return win.localStorage?.getItem('swarm-watch-token') || '';
  } catch {
    return '';
  }
}

/**
 * The shared parser keeps only a few card fields. Until it passes the rest through, the Hive reads the full
 * /api/command-center body itself and merges it under the parsed snapshot (parsed fields win).
 */
function mergeSnapshot(parsed, raw) {
  if (!raw || typeof raw !== 'object') return parsed;
  const rawById = new Map();
  for (const p of Array.isArray(raw.projects) ? raw.projects : []) {
    if (p && typeof p.id === 'string') rawById.set(p.id, p);
  }
  return {
    ...parsed,
    hive: parsed.hive || raw.hive,
    projects: (parsed.projects || []).map((p) => ({ ...(rawById.get(p.id) || {}), ...p })),
  };
}

/**
 * @param {HTMLElement} host
 * @param {object} snapshot Command Center snapshot (parseCommandCenterSnapshot shape, plus hive extras when present)
 * @param {{
 *   document: Document,
 *   now: () => number,
 *   requestAnimationFrame: (cb: (t: number) => void) => number,
 *   cancelAnimationFrame: (id: number) => void,
 *   matchMedia: (query: string) => { matches: boolean, addEventListener?: Function, removeEventListener?: Function },
 *   onOpenProject: (projectId: string) => void,
 * }} deps
 */
export function renderHive(host, snapshot, deps) {
  const doc = deps.document;
  const win = doc.defaultView || globalThis;
  const panels = resolveHivePanels();

  while (host.firstChild) host.removeChild(host.firstChild);

  const listeners = [];
  const timers = [];
  let userPaused = false;
  let destroyed = false;
  let suspended = false;
  let parsedRef = snapshot;
  let rawRef = deps.rawSnapshot || null;
  let hasSuppliedRaw = deps.rawSnapshot != null;
  let rawBusy = false;
  let view = null;
  let prevView = null;
  let cardSig = '';
  let panelSig = '';
  let cardEls = [];
  let panelHeads = [];
  let cardCleanups = [];
  let counterEls = null;
  let stageGeom = [];
  let robotApi = null;
  let robotPromise = null;
  let motion = null;

  function loadRobots() {
    if (!robotPromise) {
      robotPromise = new Promise(resolve => {
        const load = () => resolve(destroyed ? null : (deps.loadRobot || (() => import('./robot-head.js')))());
        // The Hive shell, cards and data paint before the optional 3D renderer is requested.
        if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(load);
        else later(load, 0);
      }).then(api => {
        robotApi = api;
        if (!destroyed) api?.setAnimationPaused(userPaused || reduced() || hidden());
        return api;
      });
    }
    return robotPromise;
  }

  const reducedMq = deps.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => Boolean(reducedMq && reducedMq.matches);
  const hidden = () => Boolean(doc.hidden);
  const isPhone = () => (win.innerWidth ?? 1200) <= PHONE_MAX;
  const shouldAnimate = () => !(reduced() || hidden() || userPaused || suspended);

  function addListener(target, type, handler, options) {
    const activeHandler = (...args) => { if (!suspended) handler(...args); };
    target.addEventListener(type, activeHandler, options);
    listeners.push({ target, type, handler: activeHandler, options });
  }

  function later(fn, ms) {
    if (typeof win.setTimeout !== 'function') return;
    const id = win.setTimeout(() => { if (!destroyed) fn(); }, ms);
    timers.push(id);
  }

  // The app's one glitch effect is the brand wordmark; live changes elsewhere get a soft glow pulse instead.
  function burst(hard) {
    if (reduced() || userPaused || hidden()) return;
    if (hard) glitchFailure(logo);
    else glitch(logo);
  }

  function bump(el) {
    if (!el || !el.classList) return;
    el.classList.remove('is-bump');
    void el.offsetWidth;
    el.classList.add('is-bump');
    later(() => el.classList.remove('is-bump'), 1000);
  }

  function svgNode(tag) {
    return typeof doc.createElementNS === 'function' ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
  }

  /* ---- robot heads (real heads in a browser, a monogram where there is no animation loop, e.g. tests) ---- */
  function mountHead(hostEl, o) {
    if (hostEl._ccHead) { hostEl._ccHead.setState?.(o.state); return hostEl._ccHead; }
    if (typeof win.requestAnimationFrame === 'function') {
      let handle = null;
      let removed = false;
      let observer = null;
      const mount = () => void loadRobots().then(api => {
        if (!api || removed || destroyed) return;
        while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
        handle = api.mountRobotHead(hostEl, {
          state: o.state,
          size: o.size || 28,
          color: o.color,
          screenColor: o.state === 'error' ? '#ffc4c4' : '#e8f2ff',
          id: o.id,
          label: o.label,
        });
      }).catch(() => {
        if (removed || destroyed) return;
        while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
        monogram();
      });
      // Lane heads are optional and below the fold. Only request their graph when one is visible.
      if (typeof win.IntersectionObserver === 'function') {
        observer = new win.IntersectionObserver(entries => {
          if (!doc.hidden && entries.some(entry => entry.isIntersecting)) { observer.disconnect(); mount(); }
        });
        observer.observe(hostEl);
      } else mount();
      hostEl._ccHead = {
        setState(state) { o = { ...o, state }; handle?.setState?.(state); },
        destroy() { removed = true; observer?.disconnect(); handle?.destroy(); },
      };
      return hostEl._ccHead;
    }
    function monogram() {
      const mono = h(doc, 'span', 'hive-bot hive-bot--mono', String(o.label || '·').charAt(0).toUpperCase());
      mono.setAttribute('aria-hidden', 'true');
      hostEl.appendChild(mono);
    }
    monogram();
    hostEl._ccHead = { destroy() {} };
    return hostEl._ccHead;
  }

  function destroyHeads(list) {
    while (list.length) {
      const handle = list.pop();
      try {
        if (handle && typeof handle.destroy === 'function') handle.destroy();
      } catch {
        // a head that is already gone needs no cleanup
      }
    }
  }

  /* ---- static shell ---- */
  const shell = h(doc, 'div', 'hive-shell');
  shell.id = 'hive-shell';

  const top = h(doc, 'header', 'hive-top');
  const logo = h(doc, 'span', 'hive-logo hive-brand', 'SWARM WATCH');
  logo.setAttribute('aria-label', 'Swarm Watch Command Center');
  top.appendChild(logo);
  const tag = h(doc, 'span', 'hive-tag');
  tag.appendChild(doc.createTextNode('command center · one ledger, many workers'));
  tag.appendChild(h(doc, 'br'));
  tag.appendChild(doc.createTextNode('every number read from ledgers and run folders'));
  top.appendChild(tag);
  const cnt = h(doc, 'div', 'hive-cnt');
  cnt.setAttribute('role', 'group');
  cnt.setAttribute('aria-label', 'Hive summary');
  top.appendChild(cnt);
  // End of the single header line: LIVE (with its notification slot), a small tour link and the "···" views menu.
  const end = h(doc, 'div', 'hive-end');
  const live = h(doc, 'span', 'hive-live');
  live.appendChild(h(doc, 'i'));
  live.appendChild(doc.createTextNode('LIVE'));
  end.appendChild(live);
  // Notifications slide in under LIVE inside the header, never against the rule or over the stage.
  const toast = h(doc, 'span', 'hive-toast');
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  const toastText = h(doc, 'span');
  toast.appendChild(toastText);
  end.appendChild(toast);
  const tourBtn = h(doc, 'button', 'hive-link cc-tour-help', 'Tour');
  tourBtn.type = 'button';
  tourBtn.setAttribute('aria-label', 'Command Center tour');
  end.appendChild(tourBtn);
  const menu = h(doc, 'details', 'hive-menu');
  const menuBtn = h(doc, 'summary', 'hive-menu-btn', '···');
  menuBtn.setAttribute('aria-label', 'Views and search');
  menuBtn.setAttribute('title', 'Views and search');
  menu.appendChild(menuBtn);
  const nav = h(doc, 'nav', 'hive-nav');
  nav.setAttribute('aria-label', 'Command Center views');
  menu.appendChild(nav);
  end.appendChild(menu);
  const tabs = nav;
  const tabHive = h(doc, 'a', 'hive-tab', 'Command Center');
  tabHive.setAttribute('aria-current', 'page');
  tabHive.href = '/command-center';
  tabs.appendChild(tabHive);
  const tabCockpit = h(doc, 'a', 'hive-tab', 'Cockpit');
  tabCockpit.setAttribute('data-tour', 'cockpit');
  tabs.appendChild(tabCockpit);
  const tabClassic = h(doc, 'a', 'hive-tab', 'Classic');
  tabClassic.href = `/classic${win.location?.search || ''}`;
  tabs.appendChild(tabClassic);
  const searchBtn = h(doc, 'button', 'hive-tabbtn');
  searchBtn.type = 'button';
  searchBtn.appendChild(doc.createTextNode('Search'));
  searchBtn.appendChild(h(doc, 'span', 'hive-mono hive-hint', 'Ctrl K'));
  tabs.appendChild(searchBtn);
  top.appendChild(end);

  const stage = h(doc, 'section', 'hive-stage');
  stage.id = 'hive-stage';
  stage.setAttribute('data-tour', 'hive');
  stage.setAttribute('aria-label', 'Hive diagram');
  const ringfx = h(doc, 'div', 'hive-ringfx');
  ringfx.setAttribute('aria-hidden', 'true');
  // i: the thick glowing band (its ::before/::after on the wrapper are the two inner rings); b: dotted outer ring.
  ringfx.appendChild(h(doc, 'i'));
  ringfx.appendChild(h(doc, 'b'));
  const canvas = h(doc, 'canvas');
  canvas.id = 'hive-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  stage.appendChild(canvas);
  stage.appendChild(ringfx);
  // Arc label: an SVG textPath on a circle just outside the ring, turning slowly (CSS, paused with motion).
  const arc = svgNode('svg');
  arc.setAttribute('class', 'hive-arc');
  arc.setAttribute('aria-hidden', 'true');
  const arcDefs = svgNode('defs');
  const arcPath = svgNode('path');
  arcPath.setAttribute('id', 'hive-arc-path');
  arcDefs.appendChild(arcPath);
  arc.appendChild(arcDefs);
  const arcText = svgNode('text');
  const arcTp = svgNode('textPath');
  arcTp.setAttribute('href', '#hive-arc-path');
  arcTp.textContent = ARC_TEXT;
  arcText.appendChild(arcTp);
  arc.appendChild(arcText);
  stage.appendChild(arc);
  const core = h(doc, 'div', 'hive-core');
  core.appendChild(h(doc, 'div', 'a', 'THE SWARM'));
  core.appendChild(h(doc, 'div', 'n', 'Swarm'));
  const coreState = h(doc, 'div', 's', 'waiting');
  core.appendChild(coreState);
  const coreExtra = h(doc, 'div', 'x');
  core.appendChild(coreExtra);
  stage.appendChild(core);

  const legend = h(doc, 'div', 'hive-legend');
  legend.setAttribute('aria-label', 'Project colours');
  legend.setAttribute('data-tour', 'legend');
  for (const [label, cssVar] of [['building', '--green'], ['blocked', '--amber'], ['needs you', '--red'], ['done', '--blue'], ['idle', '--violet']]) {
    const item = h(doc, 'span');
    item.style.color = `var(${cssVar})`;
    const dot = h(doc, 'i');
    dot.style.background = `var(${cssVar})`;
    item.appendChild(dot);
    item.appendChild(doc.createTextNode(label));
    legend.appendChild(item);
  }
  const tl = h(doc, 'span', 'tl');
  tl.appendChild(h(doc, 'u', null, 'the ledger counts.'));
  tl.appendChild(doc.createTextNode(' '));
  tl.appendChild(h(doc, 'b', null, 'the swarm builds.'));
  tl.appendChild(doc.createTextNode(' '));
  tl.appendChild(h(doc, 'u', null, 'you decide.'));
  legend.appendChild(tl);

  const panelsRoot = h(doc, 'div', 'hive-panels');

  const foot = h(doc, 'div', 'hive-foot');
  const footData = h(doc, 'span');
  const footGen = h(doc, 'span');
  footData.appendChild(doc.createTextNode('data: live ledgers and run folders from the board, read at '));
  footData.appendChild(footGen);
  foot.appendChild(footData);
  const pauseBtn = h(doc, 'button', 'hive-footbtn');
  pauseBtn.id = 'pause-motion';
  pauseBtn.type = 'button';
  pauseBtn.setAttribute('aria-pressed', 'false');
  foot.appendChild(pauseBtn);
  const sources = h(doc, 'details');
  sources.appendChild(h(doc, 'summary', null, 'sources'));
  sources.appendChild(h(doc, 'p', null, 'Read from the board payload behind /api/command-center: each project’s ledger counts, the run folders and the agents the board reports as running. A number the board does not report is left out and the panel says so. Each stream into the ring is one project in its colour; busier projects spray denser streams. The only glitch is the wordmark: under 400 ms, off with reduced motion.'));
  foot.appendChild(sources);

  shell.appendChild(top);
  shell.appendChild(stage);
  shell.appendChild(legend);
  shell.appendChild(panelsRoot);
  shell.appendChild(foot);
  host.appendChild(shell);

  const stageApi = createHiveRenderer(canvas, () => doc.createElement('canvas'));

  /* ---- toast (real events only: more agents, a finished ticket, something new for you) ---- */
  function showToast(message, icon, tone) {
    toastText.textContent = message;
    toast.classList.toggle('is-bad', tone === 'bad');
    const old = toast.querySelector ? toast.querySelector('img') : null;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (icon && TOAST_ICON[icon]) {
      const img = h(doc, 'img');
      img.alt = '';
      img.src = ICON_BASE + TOAST_ICON[icon];
      if (typeof toast.insertBefore === 'function' && toast.firstChild) toast.insertBefore(img, toast.firstChild);
      else toast.appendChild(img);
    }
    toast.classList.remove('is-on');
    // Restart the CSS animation (a reflow between remove and add).
    void toast.offsetWidth;
    toast.classList.add('is-on');
    later(() => toast.classList.remove('is-on'), 3200);
  }

  /* ---- header counters ---- */
  function buildCounters() {
    const defs = [
      ['projects', 'Registered top-level projects on this board.', 'stats.projectsTotal'],
      ['agents', 'Workers running right now, from the run folders.', 'stats.agentsLive'],
      ['done 24h', 'Tickets the ledger marks done in the last 24 hours (some are bulk marks of work merged earlier).', 'hive.doneLast24h'],
      ['need you', 'Open items waiting for you on the board.', 'stats.needsYouCount'],
    ];
    const els = {};
    for (const [label, tip, source] of defs) {
      const cell = h(doc, 'div');
      cell.appendChild(h(doc, 'div', 'l', label));
      const v = h(doc, 'div', 'v has-tip');
      v.setAttribute('tabindex', '0');
      v.setAttribute('data-k', label);
      v.setAttribute('data-tip', tip);
      v.setAttribute('data-source', source);
      cell.appendChild(v);
      cnt.appendChild(cell);
      els[label] = v;
    }
    return els;
  }
  counterEls = buildCounters();

  function paintCounters(v) {
    const next = {
      projects: [String(v.projectsTotal), ''],
      agents: [String(v.agents), v.agents > 0 ? 'var(--green)' : ''],
      'done 24h': [v.doneLast24h === null ? '—' : String(v.doneLast24h), 'var(--blue)'],
      'need you': [String(v.needs), 'var(--red)'],
    };
    for (const k of Object.keys(next)) {
      const el = counterEls[k];
      const changed = el.textContent !== '' && el.textContent !== next[k][0];
      if (el.textContent !== next[k][0]) el.textContent = next[k][0];
      if (el.style.color !== next[k][1]) el.style.color = next[k][1];
      if (changed) bump(el);
    }
  }

  function paintCore(v) {
    const state = v.agents > 0 ? 'building' : 'waiting';
    if (coreState.textContent !== state) coreState.textContent = state;
    const parts = [`${plural(v.agents, 'agent', 'agents')} live`];
    if (v.doneLast24h !== null) parts.push(`${v.doneLast24h} done in 24 h`);
    const text = parts.join(' · ');
    if (coreExtra.textContent !== text) coreExtra.textContent = text;
  }

  function paintFoot(v) {
    const text = formatGenerated(v.at);
    if (footGen.textContent !== text) footGen.textContent = text;
  }

  function setPauseUi() {
    const motionOff = userPaused || reduced() || hidden();
    if (doc.body?.classList) doc.body.classList.toggle('motion-off', motionOff);
    try {
      robotApi?.setAnimationPaused(motionOff);
    } catch {
      // heads are optional
    }
    pauseBtn.setAttribute('aria-pressed', String(userPaused));
    pauseBtn.textContent = userPaused ? 'resume motion · p' : 'pause motion · p';
  }

  /* ---- project cards ---- */
  function openProject(projectId) {
    if (typeof deps.onOpenProject === 'function') deps.onOpenProject(projectId);
  }

  function clearCards() {
    while (cardCleanups.length) cardCleanups.pop()();
    for (const el of cardEls) if (el.parentNode) el.parentNode.removeChild(el);
    cardEls = [];
  }

  function failsOf(p) {
    return Number(p.raw && p.raw.fails && p.raw.fails.value) || 0;
  }

  function buildCard(p, index) {
    const card = h(doc, 'div', 'hive-card hive-node');
    card.style.setProperty('--c', p.color);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${p.name}`);
    card.setAttribute('data-project-id', p.id);
    card.setAttribute('data-status', p.cat);
    card.setAttribute('data-attn', p.cat === 'need' ? '1' : '0');
    if (card.dataset) card.dataset.projectId = p.id;

    // Header: index + name, and the colour category as a small tag on the right.
    const hd = h(doc, 'div', 'hive-card-hd');
    const name = h(doc, 'span', 'name');
    name.appendChild(h(doc, 'span', 'k', String(index + 1).padStart(2, '0')));
    name.appendChild(doc.createTextNode(p.name));
    name.setAttribute('title', p.name);
    hd.appendChild(name);
    hd.appendChild(h(doc, 'span', 't', p.tag));
    card.appendChild(hd);

    const bd = h(doc, 'div', 'hive-card-bd');
    const c = p.counts;
    const pills = h(doc, 'span', 'pills');
    if (p.needs > 0) pills.appendChild(h(doc, 'b', 'hive-pill hive-pill--need', `${p.needs} need you`));
    if (p.agents > 0) pills.appendChild(h(doc, 'b', 'hive-pill hive-pill--live', `${p.agents} live`));
    if (c) {
      const rows = [
        ['tickets', c.total],
        ['done', `${c.done} of ${p.counted}`],
        p.pct === 100 ? ['cancelled', c.cancelled] : ['blocked', c.blocked],
        ['in review', c.review],
      ];
      rows.forEach(([label, value], i) => {
        const row = h(doc, 'div', 'r');
        row.appendChild(h(doc, 'span', null, label));
        row.appendChild(h(doc, 'span', 'val', String(value)));
        if (i === 0 && pills.firstChild) row.appendChild(pills);
        bd.appendChild(row);
      });
    } else {
      bd.appendChild(h(doc, 'p', 'hive-muted', 'no ledger numbers yet'));
      if (pills.firstChild) {
        const row = h(doc, 'div', 'r');
        row.appendChild(pills);
        bd.appendChild(row);
      }
    }
    if (p.pct !== null) {
      // p(done) / bar / value, like the target's p(label) rows; the percent stays readable for screen readers.
      const pb = h(doc, 'div', 'pb');
      pb.appendChild(h(doc, 'b', null, 'p(done)'));
      const track = h(doc, 'i');
      const fill = h(doc, 'u');
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, p.pct / 100))})`;
      track.appendChild(fill);
      pb.appendChild(track);
      const em = h(doc, 'em', 'has-tip', padPct(p.pct));
      em.setAttribute('tabindex', '0');
      em.setAttribute('data-tip', `${p.pct}% done: done divided by tickets that still count (cancelled left out).`);
      pb.appendChild(em);
      pb.appendChild(h(doc, 'span', 'hive-sr', `${p.pct}% done`));
      bd.appendChild(pb);
    }
    card.appendChild(bd);

    const open = () => openProject(p.id);
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        open();
      }
    };
    card.addEventListener('click', open);
    const preload = () => deps.preloadCockpit?.(p.id);
    card.addEventListener('pointerenter', preload, { passive: true });
    card.addEventListener('focus', preload);
    card.addEventListener('keydown', onKey);
    card._ccCleanup = () => {
      card.removeEventListener('click', open);
      card.removeEventListener('keydown', onKey);
      card.removeEventListener('pointerenter', preload);
      card.removeEventListener('focus', preload);
    };
    cardCleanups.push(card._ccCleanup);
    return card;
  }

  function paintCards(v) {
    const sig = JSON.stringify(v.projects.map((p) => [p.id, p.name, p.cat, p.counts, p.pct, p.needs, p.agents, p.raw && p.raw.fails && p.raw.fails.value]));
    const first = v.projects[0];
    const href = first ? `/command-center/project/${encodeURIComponent(first.id)}` : '#';
    if (tabCockpit.getAttribute?.('href') !== href) tabCockpit.href = href;
    if (sig === cardSig) return false;
    cardSig = sig;
    const staging = h(doc, 'div');
    v.projects.forEach((p, i) => {
      const card = buildCard(p, i);
      staging.appendChild(card);
    });
    // Reconcile through a small adapter: cards share the stage with the canvas and ring layers.
    const oldCards = cardEls;
    const adapter = {
      get children() { return cardEls; },
      appendChild(card) { stage.appendChild(card); cardEls.push(card); },
      removeChild(card) { stage.removeChild(card); cardEls = cardEls.filter(el => el !== card); },
      ...(stage.insertBefore ? { insertBefore(card, before) {
        stage.insertBefore(card, before); cardEls = cardEls.filter(el => el !== card);
        cardEls.splice(before ? cardEls.indexOf(before) : cardEls.length, 0, card);
      } } : {}),
    };
    reconcileDom(adapter, staging);
    cardEls = Array.from(adapter.children);
    // Reused cards retain their original handlers; discard handlers created for detached render output.
    for (const card of [...oldCards, ...Array.from(staging.children)]) if (!cardEls.includes(card)) card._ccCleanup?.();
    cardCleanups = cardEls.map(card => card._ccCleanup);
    return true;
  }

  /* ---- layout and canvas ---- */
  function place(el, x, y, size) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (size != null) {
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
    }
  }

  function layout() {
    const phone = isPhone();
    const cr = canvas.getBoundingClientRect?.() || { width: 800, height: 600, left: 0, top: 0 };
    const sr = stage.getBoundingClientRect?.() || cr;
    const cw = cr.width || 800;
    const ch = cr.height || 600;
    // Cards shrink a little on mid-width screens so the ellipse still has room.
    const scale = phone ? 1 : Math.max(0.72, Math.min(1, (cw - 40) / 1280));
    stage.style.setProperty('--hs', String(scale));
    const first = cardEls[0];
    const cardW = ((first && first.offsetWidth) || 270) * scale;
    const cardH = ((first && first.offsetHeight) || 132) * scale;
    const g = hiveGeometry(cw, ch, cardEls.length, phone, cardW, cardH);
    stageApi.resize(g.w, g.h, win.devicePixelRatio || 1);
    stageGeom = [];
    cardEls.forEach((el, i) => {
      const p = view.projects[i];
      const k = g.nodes[i];
      if (!phone) place(el, k.x, k.y);
      stageGeom.push({ col: p.color, cat: p.cat });
    });
    stageApi.setNodes(g, stageGeom);
    stageApi.setActivity({ agents: view.agents });

    // Ring band, arc label and core text follow the canvas geometry (stage coordinates).
    const ox = (cr.left || 0) - (sr.left || 0) + g.cx;
    const oy = (cr.top || 0) - (sr.top || 0) + g.cy;
    place(ringfx, ox, oy, Math.round(g.R * 2 + 10));
    const arcR = g.R + 18;
    const box = Math.round((arcR + 24) * 2);
    place(arc, ox, oy, box);
    arc.setAttribute('viewBox', `0 0 ${box} ${box}`);
    const m = box / 2;
    arcPath.setAttribute('d', `M ${m - arcR},${m} a ${arcR},${arcR} 0 1,1 ${arcR * 2},0 a ${arcR},${arcR} 0 1,1 ${-arcR * 2},0`);
    place(core, ox, oy);
    core.style.setProperty('--cr', String(Math.round(g.coreR)));
  }

  function drawStillFrame() {
    stageApi.drawStill();
  }

  function restart() {
    motion?.sync();
  }

  /* ---- paint from a snapshot ---- */
  function currentSnapshot() {
    return mergeSnapshot(parsedRef, rawRef);
  }

  function failTotal(v) {
    return v.projects.reduce((a, p) => a + failsOf(p), 0);
  }

  function reactToChange(prev, next) {
    if (!prev) return;
    if (next.agents > prev.agents) {
      stageGeom.forEach((k, i) => { if (k.cat !== 'off') stageApi.spawn(i); });
      stageApi.pulse();
      showToast(`${plural(next.agents - prev.agents, 'agent', 'agents')} started`, 'volt');
    }
    if (next.doneLast24h !== null && prev.doneLast24h !== null && next.doneLast24h > prev.doneLast24h) {
      stageApi.pulse();
      showToast(next.doneLast24h - prev.doneLast24h === 1 ? 'A ticket finished' : `${next.doneLast24h - prev.doneLast24h} tickets finished`, 'done');
    }
    if (next.needs > prev.needs) {
      showToast('New item needs you', 'think');
    }
    const prevFails = new Map(prev.projects.map((p) => [p.id, failsOf(p)]));
    if (failTotal(next) > failTotal(prev)) {
      stageApi.flick();
      next.projects.forEach((p, i) => { if (failsOf(p) > (prevFails.get(p.id) || 0)) stageApi.sparkAt(i); });
      burst(true);
      showToast('A run failed', 'think', 'bad');
    }
  }

  function paint() {
    const next = panels.deriveHiveView(currentSnapshot());
    prevView = view;
    view = next;
    paintCounters(view);
    paintCore(view);
    paintFoot(view);
    const rebuilt = paintCards(view);
    const minute = Math.floor(deps.now() / 60000);
    const psig = JSON.stringify([view.projects.map((p) => [p.id, p.counts, p.pct]), view.events, view.throughput, view.lanes, view.prs, view.totals, view.needs, view.spend, view.doneLast24h, view.machines, view.projectsTotal, minute]);
    if (psig !== panelSig) {
      panelSig = psig;
      const out = panels.renderHiveDashboard(panelsRoot, view, {
        nowMs: deps.now(),
        mountHead,
        reconcile: reconcileDom,
      });
      const nextHeads = out.heads || [];
      destroyHeads(panelHeads.filter(head => !nextHeads.includes(head)));
      panelHeads = nextHeads;
    }
    if (rebuilt || !stageGeom.length) { layout(); if (motion) drawStillFrame(); }
    stageApi.setActivity({ agents: view.agents });
    if (rebuilt) setPauseUi();
    reactToChange(prevView, view);
  }

  /* ---- full-body fetch while the shared parser drops card fields ---- */
  function loadRaw() {
    if (hasSuppliedRaw || hidden() || typeof win.fetch !== 'function' || rawBusy || parsedRef.hive) return;
    rawBusy = true;
    win.fetch(RAW_URL, { method: 'GET', cache: 'no-cache', headers: { 'x-watch-token': readWatchToken(win) } })
      .then((res) => (res && res.ok ? res.json() : null))
      .then((body) => {
        rawBusy = false;
        if (destroyed || !body) return;
        rawRef = body;
        paint();
        restart();
      })
      .catch(() => { rawBusy = false; });
  }

  /* ---- wiring ---- */
  addListener(logo, 'mouseenter', () => burst(false));
  addListener(tabCockpit, 'click', (e) => {
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button)) return;
    const first = view && view.projects[0];
    if (!first) return;
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    openProject(first.id);
  });
  addListener(tabCockpit, 'pointerenter', () => deps.preloadCockpit?.());
  addListener(stage, 'pointerover', () => deps.preloadCockpit?.(), { passive: true });
  addListener(searchBtn, 'click', () => {
    if (typeof win.KeyboardEvent !== 'function' || typeof doc.dispatchEvent !== 'function') return;
    const mac = /mac|iphone|ipad/i.test(String(win.navigator?.platform || ''));
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k', ctrlKey: !mac, metaKey: mac, bubbles: true }));
  });
  // The views menu closes after a pick, on a click elsewhere and on Escape.
  const closeMenu = () => { if (menu.open) menu.open = false; };
  addListener(nav, 'click', closeMenu);
  addListener(doc, 'click', (e) => {
    if (!menu.open || typeof menu.contains !== 'function') return;
    const t = e && e.target;
    // The tour opens the menu to show a step; its own buttons must not close it again.
    if (t && typeof t.closest === 'function' && t.closest('.cc-tour-overlay')) return;
    if (!menu.contains(t)) closeMenu();
  });
  addListener(tourBtn, 'click', async () => {
    const { hasCompleted, isTourDisabledByQuery, startTour } = await import('./cc-tour.js');
    if (destroyed) return;
    if (isTourDisabledByQuery(win.location)) return;
    const storage = { getItem: (k) => { try { return win.localStorage?.getItem(k) ?? null; } catch { return null; } }, setItem: (k, v) => { try { win.localStorage?.setItem(k, v); } catch { /* ignore */ } } };
    startTour({ doc, storage, userId: 'anonymous', replay: hasCompleted(storage, 'anonymous') });
  });
  const togglePause = () => {
    userPaused = !userPaused;
    setPauseUi();
    restart();
  };
  addListener(pauseBtn, 'click', togglePause);
  addListener(doc, 'keydown', (e) => {
    if (e.key === 'Escape' && menu.open) {
      closeMenu();
      return;
    }
    if (e.key === 'p'&& !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      togglePause();
    }
  });
  addListener(doc, 'visibilitychange', () => {
    setPauseUi();
    restart();
  });
  if (reducedMq?.addEventListener) addListener(reducedMq, 'change', () => { setPauseUi(); restart(); });
  addListener(win, 'resize', () => {
    if (!view) return;
    layout();
    restart();
    if (!shouldAnimate()) drawStillFrame();
  });
  paint();
  setPauseUi();
  loadRaw();
  drawStillFrame();
  motion = mountAmbientMotion({ element: shell, visibilityElement: stage, doc, win, media: reducedMq,
    raf: deps.requestAnimationFrame, caf: deps.cancelAnimationFrame,
    onVisibility: setPauseUi,
    paused: () => !shouldAnimate(), draw: dt => stageApi.frame(dt) });

  return {
    suspend() { suspended = true; motion?.sync(); robotApi?.setAnimationPaused(true); },
    resume() { suspended = false; motion?.sync(); setPauseUi(); },
    update(nextSnapshot, rawSnapshot) {
      parsedRef = nextSnapshot;
      if (rawSnapshot !== undefined) {
        rawRef = rawSnapshot;
        hasSuppliedRaw = true;
      }
      paint();
      restart();
      loadRaw();
    },
    destroy() {
      destroyed = true;
      motion?.destroy();
      if (typeof win.clearTimeout === 'function') for (const id of timers) win.clearTimeout(id);
      timers.length = 0;
      clearCards();
      destroyHeads(panelHeads);
      for (const l of listeners) l.target.removeEventListener(l.type, l.handler, l.options);
      listeners.length = 0;
      if (shell.parentNode) shell.parentNode.removeChild(shell);
    },
  };
}
