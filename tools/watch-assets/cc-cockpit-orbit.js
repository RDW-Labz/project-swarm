// SPDX-License-Identifier: Apache-2.0
// Cockpit orchestrator orbit: warm glow, floor shadow, the two-ring ellipse around the robot head (back half behind it, front half in
// front of it), three orbiting dots and the thread from the ring to the highlighted ticket. Ported from the owner-approved artifact
// (drawO / sizeO / frameO) with the same drawing and timing. The loop stops when the tab is hidden and does not run under reduced motion.

const TAU = Math.PI * 2;
const DOT_COLOURS = ['#2fe0a0', '#4d7cff', '#ff4d7e'];
import { mountAmbientMotion } from './cc-hive-stage.js';

/**
 * @param {{
 *   back: HTMLCanvasElement, front: HTMLCanvasElement,
 *   target?: () => (Element|null),
 *   win?: Window, doc?: Document,
 *   requestAnimationFrame?: (cb: (ts: number) => void) => number,
 *   cancelAnimationFrame?: (id: number) => void,
 *   reducedMotion?: boolean,
 * }} opts
 * @returns {{ resize: () => void, draw: (dt: number) => void, destroy: () => void, size: () => { width: number, height: number } }}
 */
export function mountOrbit(opts) {
  const { back, front } = opts;
  const win = opts.win || globalThis;
  const doc = opts.doc || globalThis.document;
  const target = typeof opts.target === 'function' ? opts.target : () => null;
  const raf = opts.requestAnimationFrame || (typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null);
  const caf = opts.cancelAnimationFrame || (typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : null);
  const reduce = opts.reducedMotion != null
    ? Boolean(opts.reducedMotion)
    : Boolean(typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const ox = typeof back?.getContext === 'function' ? back.getContext('2d') : null;
  const fq = typeof front?.getContext === 'function' ? front.getContext('2d') : null;
  if (!ox || !fq) {
    return { resize() {}, draw() {}, destroy() {}, size: () => ({ width: 0, height: 0 }) };
  }

  let OW = 0;
  let OH = 0;
  let ot = 0;
  let CN = null;
  let destroyed = false;

  function draw(dt) {
    ot += dt;
    ox.clearRect(0, 0, OW, OH);
    fq.clearRect(0, 0, OW, OH);
    if (!OW) return;
    const wide = (win.innerWidth || 0) > 900;
    const x = OW / 2;
    const y = OH * (wide ? 0.66 : 0.58);
    const cy = y + 42;
    const RX = Math.min(232, OW / 2 - 8);
    const RY = Math.max(30, RX * 0.25);
    ox.globalCompositeOperation = 'lighter';
    let g = ox.createRadialGradient(x, y - 10, 10, x, y - 10, 330);
    g.addColorStop(0, 'rgba(255,160,100,.38)');
    g.addColorStop(0.3, 'rgba(210,140,190,.22)');
    g.addColorStop(0.6, 'rgba(169,139,255,.08)');
    g.addColorStop(1, 'rgba(169,139,255,0)');
    ox.fillStyle = g;
    ox.fillRect(0, 0, OW, OH);
    ox.globalCompositeOperation = 'source-over';
    ox.save();
    ox.translate(x, y + 128);
    ox.scale(1, 0.17);
    g = ox.createRadialGradient(0, 0, 0, 0, 0, 150);
    g.addColorStop(0, 'rgba(0,0,0,.9)');
    g.addColorStop(0.65, 'rgba(0,0,0,.7)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ox.fillStyle = g;
    ox.beginPath();
    ox.arc(0, 0, 150, 0, TAU);
    ox.fill();
    ox.restore();
    const ring = (c, a0, a1) => {
      c.lineWidth = 1.4;
      c.strokeStyle = 'rgba(200,184,255,.6)';
      c.beginPath();
      c.ellipse(x, cy, RX, RY, 0, a0, a1);
      c.stroke();
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(255,77,126,.42)';
      c.beginPath();
      c.ellipse(x, cy, RX * 0.82, RY * 0.78, 0, a0, a1);
      c.stroke();
    };
    ring(ox, Math.PI, TAU);
    ring(fq, 0, Math.PI);
    for (let i = 0; i < 3; i += 1) {
      const a = ot * (0.5 + i * 0.2) + i * 2.1;
      const px = x + Math.cos(a) * RX * (1 - i * 0.09);
      const py = cy + Math.sin(a) * RY * (1 - i * 0.11);
      const c = Math.sin(a) > 0 ? fq : ox;
      c.fillStyle = DOT_COLOURS[i];
      c.shadowColor = c.fillStyle;
      c.shadowBlur = 8;
      c.beginPath();
      c.arc(px, py, 3.4, 0, TAU);
      c.fill();
      c.shadowBlur = 0;
    }
    if (CN) {
      const P = [[x + RX, cy], [x + RX - 6, cy - 120], [CN[0] - 90, CN[1]], CN];
      const bz = t => [0, 1].map(k => (1 - t) ** 3 * P[0][k] + 3 * (1 - t) ** 2 * t * P[1][k] + 3 * (1 - t) * t * t * P[2][k] + t ** 3 * P[3][k]);
      fq.strokeStyle = 'rgba(240,243,250,.92)';
      fq.lineWidth = 1.5;
      fq.beginPath();
      fq.moveTo(P[0][0], P[0][1]);
      fq.bezierCurveTo(P[1][0], P[1][1], P[2][0], P[2][1], P[3][0], P[3][1]);
      fq.stroke();
      fq.fillStyle = '#f4f6fb';
      for (const t of [0, 0.3, 0.5, 0.7, 1]) {
        const [qx, qy] = bz(t);
        fq.beginPath();
        fq.arc(qx, qy, t === 1 ? 4 : 3.4, 0, TAU);
        fq.fill();
      }
    }
  }

  /** Re-measure the canvases and the highlighted ticket, then repaint one frame. */
  function resize() {
    if (destroyed) return;
    const r = back.getBoundingClientRect();
    OW = Math.floor(r.width);
    OH = Math.floor(r.height);
    back.width = OW;
    front.width = OW;
    back.height = OH;
    front.height = OH;
    const hot = target();
    const hr = hot && hot.getBoundingClientRect();
    CN = hr && hr.width && (win.innerWidth || 0) > 900 ? [hr.left - r.left - 2, hr.top + hr.height / 2 - r.top] : null;
    draw(0);
  }

  const motion = mountAmbientMotion({ element: back, doc, win, raf, caf, draw,
    media: opts.reducedMotion != null ? { matches: reduce } : win.matchMedia?.('(prefers-reduced-motion: reduce)') });

  return {
    resize,
    draw,
    size: () => ({ width: OW, height: OH }),
    destroy() {
      destroyed = true;
      motion.destroy();
    },
  };
}
