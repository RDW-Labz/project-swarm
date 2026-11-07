// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reducedMotionRequested,
  activeGlitchCount,
  glitch,
  glitchOnce,
  glitchFailure,
  glitchRateLimit,
} from '../tools/watch-assets/cc-glitch.js';

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    contains: c => set.has(c),
  };
}

function makeGlitchElement() {
  const classList = makeClassList();
  return {
    classList,
    dataset: {},
  };
}

function installWindow({ reducedMotion = false, matchMedia = true } = {}) {
  const prev = globalThis.window;
  if (!matchMedia) {
    delete globalThis.window;
    return () => {
      if (prev !== undefined) globalThis.window = prev;
      else delete globalThis.window;
    };
  }
  globalThis.window = {
    matchMedia(query) {
      return {
        matches:
          query === '(prefers-reduced-motion: reduce)' && reducedMotion === true,
      };
    },
  };
  return () => {
    if (prev !== undefined) globalThis.window = prev;
    else delete globalThis.window;
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test.beforeEach(async () => {
  installWindow({ reducedMotion: false });
  if (activeGlitchCount() > 0) {
    await delay(400);
    assert.equal(activeGlitchCount(), 0);
  }
});

test.afterEach(() => {
  delete globalThis.window;
});

test('reducedMotionRequested respects matchMedia prefers-reduced-motion', () => {
  const restoreOff = installWindow({ reducedMotion: false });
  assert.equal(reducedMotionRequested(), false);
  restoreOff();

  const restoreOn = installWindow({ reducedMotion: true });
  assert.equal(reducedMotionRequested(), true);
  restoreOn();

  const restoreMissing = installWindow({ matchMedia: false });
  assert.equal(reducedMotionRequested(), false);
  restoreMissing();
});

test('glitch and glitchOnce skip effect when reduced motion is requested', (t) => {
  const restore = installWindow({ reducedMotion: true });
  const el = makeGlitchElement();
  assert.equal(glitch(el), false);
  assert.equal(glitchOnce(el), false);
  assert.equal(el.classList.contains('cc-glitch'), false);
  assert.equal(activeGlitchCount(), 0);
  restore();
});

test('activeGlitchCount tracks concurrent glitches until each completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = makeGlitchElement();
  const b = makeGlitchElement();
  assert.equal(activeGlitchCount(), 0);

  assert.equal(glitch(a, { duration: 120 }), true);
  assert.equal(glitch(b, { duration: 80 }), true);
  assert.equal(activeGlitchCount(), 2);
  assert.equal(a.classList.contains('cc-glitch'), true);
  assert.equal(b.classList.contains('cc-glitch'), true);

  t.mock.timers.tick(80);
  assert.equal(activeGlitchCount(), 1);
  assert.equal(b.classList.contains('cc-glitch'), false);
  assert.equal(a.classList.contains('cc-glitch'), true);

  t.mock.timers.tick(40);
  assert.equal(activeGlitchCount(), 0);
  assert.equal(a.classList.contains('cc-glitch'), false);
  t.mock.timers.reset();
});

test('global concurrency cap rejects a fourth active glitch', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const els = [makeGlitchElement(), makeGlitchElement(), makeGlitchElement(), makeGlitchElement()];
  assert.equal(glitch(els[0], { duration: 200 }), true);
  assert.equal(glitch(els[1], { duration: 200 }), true);
  assert.equal(glitch(els[2], { duration: 200 }), true);
  assert.equal(activeGlitchCount(), 3);
  assert.equal(glitch(els[3], { duration: 200 }), false);
  assert.equal(activeGlitchCount(), 3);

  t.mock.timers.tick(200);
  assert.equal(activeGlitchCount(), 0);
  t.mock.timers.reset();
});

test('glitchRateLimit cannot stack on the same element while cc-glitch is active', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const el = makeGlitchElement();
  assert.equal(glitchRateLimit(el), true);
  assert.equal(el.dataset.glitchTone, 'amber');
  assert.equal(el.classList.contains('cc-glitch'), true);
  assert.equal(glitchRateLimit(el), false);
  assert.equal(glitch(el, { tone: 'amber', duration: 200 }), false);

  t.mock.timers.tick(380);
  assert.equal(el.classList.contains('cc-glitch'), false);
  assert.equal(glitchRateLimit(el), true);
  t.mock.timers.tick(380);
  assert.equal(activeGlitchCount(), 0);
  t.mock.timers.reset();
});

test('glitchFailure applies red tone and respects duration cap', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const el = makeGlitchElement();
  assert.equal(glitchFailure(el), true);
  assert.equal(el.dataset.glitchTone, 'red');
  assert.equal(el.classList.contains('cc-glitch'), true);

  t.mock.timers.tick(379);
  assert.equal(el.classList.contains('cc-glitch'), true);
  t.mock.timers.tick(1);
  assert.equal(el.classList.contains('cc-glitch'), false);
  assert.equal(el.dataset.glitchTone, undefined);
  assert.equal(activeGlitchCount(), 0);
  t.mock.timers.reset();
});

test('glitch clamps duration to burst maximum', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const el = makeGlitchElement();
  assert.equal(glitch(el, { duration: 9999 }), true);
  t.mock.timers.tick(379);
  assert.equal(el.classList.contains('cc-glitch'), true);
  t.mock.timers.tick(1);
  assert.equal(el.classList.contains('cc-glitch'), false);
  assert.equal(activeGlitchCount(), 0);
  t.mock.timers.reset();
});

test('glitch guards invalid element, updating flag, and existing cc-glitch class', () => {
  assert.equal(glitch(null), false);
  assert.equal(glitch({}), false);

  const updating = makeGlitchElement();
  updating.dataset.updating = '1';
  assert.equal(glitch(updating), false);

  const busy = makeGlitchElement();
  busy.classList.add('cc-glitch');
  assert.equal(glitch(busy), false);
});
