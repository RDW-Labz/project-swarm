// SPDX-License-Identifier: Apache-2.0
// A plain-DOM mount for the ported robot-heads drawing (the React component of https://github.com/fayazara/robot-heads, MIT, was
// rewritten here without React; the drawing itself is in robot-*.js). One head is one agent: its face shows the agent's real state.
// Motion rules: a head is static under prefers-reduced-motion or when animation is paused, it stops drawing while it is off screen,
// and the shared loop sleeps when no head is moving or the tab is hidden.
// Keep the public mount cheap to import. The software 3D graph is decoration, loaded only for a visible head.
let getShape, RobotSim, restPose, RobotRenderer, frameFor, linear, parseColor, subscribe;
let core = null;
function loadCore() {
  return core ||= Promise.all([
    import('./robot-geometry.js'), import('./robot-sim.js'), import('./robot-render.js'),
    import('./robot-light.js'), import('./robot-color.js'), import('./robot-ticker.js'),
  ]).then(([geometry, sim, render, light, color, ticker]) => {
    ({ getShape } = geometry); ({ RobotSim, restPose } = sim); ({ RobotRenderer, frameFor } = render);
    ({ linear } = light); ({ parseColor } = color); ({ subscribe } = ticker);
  }).catch(error => { core = null; throw error; });
}

export const STATES = ['idle', 'thinking', 'working', 'error', 'sleeping'];

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let paused = false;
const heads = new Set();
// Drawing a head is software 3D on a 2D canvas, so animation has a budget: at most MAX_ANIMATED heads move at once (the rest show a still frame of their state),
// each repaints at about 15 frames per second, and a head that is off screen or hidden costs nothing. 60 live agents therefore cost the same as 12.
export const MAX_ANIMATED = 12;
const FRAME_S = 1 / 15;
const animating = new Set();
let rebalanceQueued = false;
function rebalance() { if (rebalanceQueued) return; rebalanceQueued = true; setTimeout(() => { rebalanceQueued = false; heads.forEach(h => h.sync(true)); }, 60); }

function palette(color, trim, screen) {
  const shell = parseColor(color) ?? [48, 80, 172];
  const metal = parseColor(trim) ?? [150, 168, 200];
  const led = parseColor(screen) ?? [232, 242, 255];
  return {
    shell: { albedo: linear(shell), f0: 0.05, metal: 0.15, spec: 0.55, shininess: 70, rim: 0.9 },
    trim: { albedo: linear(metal), f0: 0.2, metal: 0.65, spec: 0.8, shininess: 45, rim: 0.7 },
    led,
  };
}

const hashSeed = id => { let h = 2166136261; for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619); return ((h >>> 0) % 1000) / 1000; };

export function reducedMotion() { return Boolean(media && media.matches); }
export function animationPaused() { return paused; }

/** Pause or resume every head (a control on the page, and the reduced-motion setting, both end up here). */
export function setAnimationPaused(value) {
  paused = Boolean(value);
  heads.forEach(h => h.sync());
}
if (media && media.addEventListener) media.addEventListener('change', () => heads.forEach(h => h.sync()));

/**
 * host: an element to put the head in. options: state, size (px), color, trimColor, screenColor, shape, antenna, id (any string: spreads blinks),
 * label (accessible name). Returns { setState, setColor, destroy }.
 */
export function mountRobotHead(host, options = {}) {
  const placeholder = document.createElement('span');
  placeholder.style.cssText = `display:block;width:${options.size || 56}px;height:${options.size || 56}px`;
  placeholder.setAttribute('role', 'img');
  placeholder.setAttribute('aria-label', options.label || `Agent, ${options.state || 'idle'}`);
  host.appendChild(placeholder);
  let mounted = null;
  let removed = false;
  let loading = false;
  let visible = typeof IntersectionObserver !== 'function';
  const start = () => {
    if (removed || loading || mounted || !visible || document.hidden) return;
    loading = true;
    void loadCore().then(() => {
      loading = false;
      if (removed || !visible || document.hidden) return;
      placeholder.remove();
      mounted = mountLoadedRobotHead(host, options);
      observer?.disconnect();
      document.removeEventListener?.('visibilitychange', start);
    }).catch(() => { loading = false; });
  };
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    visible = entries[entries.length - 1].isIntersecting; start();
  }) : null;
  observer?.observe(placeholder);
  document.addEventListener?.('visibilitychange', start);
  start();
  return {
    setState(state) { options = { ...options, state }; mounted?.setState(state); },
    setColor(color) { options = { ...options, color }; mounted?.setColor(color); },
    destroy() { removed = true; observer?.disconnect(); document.removeEventListener?.('visibilitychange', start); mounted?.destroy(); placeholder.remove(); },
  };
}

function mountLoadedRobotHead(host, { state = 'idle', size = 56, color = '#2b49a3', trimColor = '#93a6c8', screenColor = '#e8f2ff', shape = 'rectangle', antenna = false, id = '', label } = {}) {
  const box = document.createElement('span');
  box.setAttribute('role', 'img');
  box.style.cssText = `position:relative;display:block;flex:none;width:${size}px;height:${size}px`;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  box.appendChild(canvas);
  host.appendChild(box);
  const geometry = getShape(shape);
  const frame = frameFor(geometry, antenna, size);
  canvas.style.cssText = `position:absolute;left:${-frame.padSide}px;top:${-frame.padTop}px;width:${frame.box + 2 * frame.padSide}px;height:${frame.box + frame.padTop + frame.padBottom}px;display:block;pointer-events:none`;
  let current = STATES.includes(state) ? state : 'idle';
  let pal = palette(color, trimColor, screenColor);
  const sim = new RobotSim(hashSeed(String(id)), current);
  sim.setState(current);
  const renderer = new RobotRenderer();
  let visible = typeof IntersectionObserver !== 'function';
  let unsubscribe = null;
  const label0 = () => label ?? `Agent, ${current}`;
  box.setAttribute('aria-label', label0());

  let paintedStill = '';
  const paint = animated => {
    // A still frame is drawn once per state and colour, not on every sync.
    const key = animated ? '' : `${current}|${JSON.stringify(pal)}`;
    if (!animated && key === paintedStill) return;
    paintedStill = key;
    const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    const w = Math.round((frame.box + 2 * frame.padSide) * dpr);
    const h = Math.round((frame.box + frame.padTop + frame.padBottom) * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderer.draw(ctx, frame, dpr, animated ? sim.pose : restPose(current), animated ? sim : null, current, geometry, pal, { floorShadow: false, antenna });
  };

  let acc = 0;
  const handle = {
    sync(fromRebalance) {
      let still = paused || reducedMotion() || !visible || document.hidden;
      if (!still && !animating.has(handle)) { if (animating.size < MAX_ANIMATED) animating.add(handle); else still = true; }
      if (still) {
        const had = animating.delete(handle);
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        if (visible && !document.hidden) paint(false);
        if (had && !fromRebalance) rebalance();   // a freed slot goes to a head that was waiting
        return;
      }
      if (!unsubscribe) unsubscribe = subscribe(dt => { acc += dt; if (acc + 1e-6 >= FRAME_S) { sim.pointer = null; sim.update(acc); acc = 0; paint(true); } });
    },
    setState(next) {
      const s = STATES.includes(next) ? next : 'idle';
      if (s === current) return;
      current = s; sim.setState(s); box.setAttribute('aria-label', label0());
      handle.sync();
      if (visible && !document.hidden) paint(false);
    },
    setColor(c) { pal = palette(c, trimColor, screenColor); if (visible && !document.hidden) paint(false); },
    destroy() { if (unsubscribe) unsubscribe(); unsubscribe = null; observer?.disconnect(); document.removeEventListener?.('visibilitychange', onVisibility); heads.delete(handle); const had = animating.delete(handle); box.remove(); if (had) rebalance(); },
  };
  // Stop drawing while the head is off screen.
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { visible = entries[entries.length - 1].isIntersecting; handle.sync(); }) : null;
  observer?.observe(box);
  const onVisibility = () => handle.sync();
  document.addEventListener?.('visibilitychange', onVisibility);
  heads.add(handle);
  handle.sync();
  return handle;
}
