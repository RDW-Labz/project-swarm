/* Ticket T-0307: glitch effect wrapper with duration, concurrency and reduced-motion limits. */

const MAX_BURST_MS = 380;
const MAX_CONCURRENT = 3;

let activeCount = 0;

export function reducedMotionRequested() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
}

export function activeGlitchCount() {
  return activeCount;
}

export function glitch(el, opts) {
  const options = opts || {};
  if (!el || typeof el.classList === 'undefined') return false;
  if (reducedMotionRequested()) return false;
  if (el.dataset && el.dataset.updating === '1') return false;
  if (el.classList.contains('cc-glitch')) return false;
  if (activeCount >= MAX_CONCURRENT) return false;

  const requested = typeof options.duration === 'number' ? options.duration : 300;
  const duration = Math.max(0, Math.min(requested, MAX_BURST_MS));
  const tone = options.tone === 'red' || options.tone === 'amber' ? options.tone : 'default';

  activeCount += 1;
  el.classList.add('cc-glitch');
  if (el.dataset) el.dataset.glitchTone = tone;

  setTimeout(function endBurst() {
    el.classList.remove('cc-glitch');
    if (el.dataset) delete el.dataset.glitchTone;
    activeCount = Math.max(0, activeCount - 1);
  }, duration);

  return true;
}

export function glitchOnce(el, opts) {
  return glitch(el, opts);
}

export function glitchFailure(el) {
  return glitch(el, { duration: MAX_BURST_MS, tone: 'red' });
}

export function glitchRateLimit(el) {
  return glitch(el, { duration: MAX_BURST_MS, tone: 'amber' });
}
