import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUiConfig, compareScreen, UI_DEFAULTS } from '../tools/ui-compare.mjs';

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
const PALETTE = ['rgb(10, 20, 30)', 'rgb(200, 100, 50)', 'rgb(255, 255, 255)', 'rgb(0, 0, 0)', 'rgb(120, 60, 200)'];
const THRESHOLDS = { minScore: 0.7, text: 0.5 };

function okScreen(over = {}) {
  return { id: 'home-page', route: '/', mockup: 'design/home.html', ...over };
}

function okRaw(over = {}) {
  return { screens: [okScreen()], ...over };
}

function mockup(over = {}) {
  return {
    viewportWidth: 390,
    scrollWidth: 390,
    bodyFont: 'Figtree',
    bodyMargin: '0px',
    fonts: ['Figtree'],
    colors: PALETTE.slice(),
    backgrounds: [],
    words: WORDS.slice(),
    styled: true,
    ...over,
  };
}

function page(over = {}) {
  return {
    viewportWidth: 390,
    scrollWidth: 390,
    bodyFont: 'Figtree',
    bodyMargin: '0px',
    fonts: ['Figtree'],
    colors: PALETTE.slice(),
    backgrounds: [],
    words: WORDS.slice(),
    styled: true,
    ...over,
  };
}

function run(m, p, visual = 0.9, thresholds = THRESHOLDS) {
  return compareScreen({ mockup: m, page: p, visual }, thresholds);
}

function approx(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to be ${expected}`);
}

// ---------- config validation ----------

test('UI_DEFAULTS is frozen with the designed values', () => {
  assert.ok(Object.isFrozen(UI_DEFAULTS));
  assert.equal(UI_DEFAULTS.baseUrl, 'http://127.0.0.1:3000');
  assert.equal(UI_DEFAULTS.readyPath, '/');
  assert.equal(UI_DEFAULTS.timeoutSec, 120);
  assert.deepEqual(UI_DEFAULTS.viewport, { width: 390, height: 844 });
  assert.equal(UI_DEFAULTS.minScore, 0.7);
  assert.equal(UI_DEFAULTS.text, 0.5);
});

test('validateUiConfig fills defaults for a minimal valid profile', () => {
  const { config, errors } = validateUiConfig(okRaw());
  assert.deepEqual(errors, []);
  assert.equal(config.baseUrl, 'http://127.0.0.1:3000');
  assert.equal(config.readyPath, '/');
  assert.equal(config.timeoutSec, 120);
  assert.deepEqual(config.viewport, { width: 390, height: 844 });
  assert.equal(config.screens.length, 1);
  assert.equal(config.screens[0].id, 'home-page');
  assert.equal(config.screens[0].route, '/');
  assert.equal(config.screens[0].mockup, 'design/home.html');
  assert.equal(config.screens[0].minScore, 0.7);
  assert.equal(config.screens[0].text, 0.5);
});

test('validateUiConfig undefined raw gives null config and no errors', () => {
  const result = validateUiConfig(undefined);
  assert.deepEqual(result, { config: null, errors: [] });
});

test('validateUiConfig rejects unknown keys', () => {
  const { config, errors } = validateUiConfig(okRaw({ bogus: true }));
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

test('validateUiConfig rejects unknown keys on a screen', () => {
  const { config, errors } = validateUiConfig(okRaw({ screens: [okScreen({ extra: 1 })] }));
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

test('validateUiConfig rejects duplicate screen ids', () => {
  const { config, errors } = validateUiConfig(
    okRaw({ screens: [okScreen(), okScreen({ route: '/other' })] }),
  );
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

test('validateUiConfig rejects an absolute mockup path', () => {
  const { config, errors } = validateUiConfig(okRaw({ screens: [okScreen({ mockup: '/etc/home.html' })] }));
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

test('validateUiConfig rejects a mockup path with dotdot', () => {
  const { config, errors } = validateUiConfig(
    okRaw({ screens: [okScreen({ mockup: '../outside/home.html' })] }),
  );
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

test('validateUiConfig rejects bad routes: scheme, dotdot, no leading slash', () => {
  for (const route of ['https://evil.example/', '/a/../b', 'home']) {
    const { config, errors } = validateUiConfig(okRaw({ screens: [okScreen({ route })] }));
    assert.ok(errors.length > 0, `route ${route} should be rejected`);
    assert.deepEqual(config, {});
  }
});

test('validateUiConfig rejects baseUrl that is https or a remote host', () => {
  for (const baseUrl of ['https://127.0.0.1:3000', 'http://example.com', 'http://10.0.0.5:3000']) {
    const { config, errors } = validateUiConfig(okRaw({ baseUrl }));
    assert.ok(errors.length > 0, `baseUrl ${baseUrl} should be rejected`);
    assert.deepEqual(config, {});
  }
});

test('validateUiConfig accepts localhost, 127.0.0.1 and [::1] over http', () => {
  for (const baseUrl of ['http://localhost:3000', 'http://127.0.0.1:4000', 'http://[::1]:3000']) {
    const { errors } = validateUiConfig(okRaw({ baseUrl }));
    assert.deepEqual(errors, [], `baseUrl ${baseUrl} should be accepted`);
  }
});

test('validateUiConfig rejects a viewport outside the designed ranges', () => {
  const tooNarrow = validateUiConfig(okRaw({ viewport: { width: 100, height: 844 } }));
  assert.ok(tooNarrow.errors.length > 0);
  assert.deepEqual(tooNarrow.config, {});

  const tooTall = validateUiConfig(okRaw({ viewport: { width: 390, height: 5000 } }));
  assert.ok(tooTall.errors.length > 0);
  assert.deepEqual(tooTall.config, {});
});

test('validateUiConfig accepts a viewport at the range limits', () => {
  const { errors, config } = validateUiConfig(okRaw({ viewport: { width: 200, height: 4000 } }));
  assert.deepEqual(errors, []);
  assert.deepEqual(config.viewport, { width: 200, height: 4000 });
});

test('validateUiConfig start argv: valid argv is kept', () => {
  const { config, errors } = validateUiConfig(okRaw({ start: ['npm', 'run', 'dev'] }));
  assert.deepEqual(errors, []);
  assert.deepEqual(config.start, ['npm', 'run', 'dev']);
});

test('validateUiConfig start argv: empty array is rejected', () => {
  const { config, errors } = validateUiConfig(okRaw({ start: [] }));
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

test('validateUiConfig start argv: absolute program path is rejected', () => {
  const { config, errors } = validateUiConfig(okRaw({ start: ['/usr/bin/node', 'server.js'] }));
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

test('validateUiConfig start argv: empty item is rejected', () => {
  const { config, errors } = validateUiConfig(okRaw({ start: ['npm', ''] }));
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

test('validateUiConfig start argv: NUL character is rejected', () => {
  const { config, errors } = validateUiConfig(okRaw({ start: ['npm', 'run' + String.fromCharCode(0)] }));
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

test('validateUiConfig start argv: more than 20 items is rejected', () => {
  const argv = Array.from({ length: 21 }, (_, i) => 'arg' + i);
  argv[0] = 'npm';
  const { config, errors } = validateUiConfig(okRaw({ start: argv }));
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

test('validateUiConfig rejects more than 60 screens', () => {
  const screens = Array.from({ length: 61 }, (_, i) => okScreen({ id: 'screen-' + i }));
  const { config, errors } = validateUiConfig({ screens });
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

test('validateUiConfig rejects zero screens', () => {
  const { config, errors } = validateUiConfig({ screens: [] });
  assert.ok(errors.length > 0);
  assert.deepEqual(config, {});
});

// ---------- compareScreen ----------

test('compareScreen passes a matching page and returns parts', () => {
  const result = run(mockup(), page(), 0.9);
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
  approx(result.score, 0.9);
  approx(result.parts.visual, 0.9);
  approx(result.parts.text, 1);
  approx(result.parts.colors, 1);
  assert.deepEqual(result.parts.fonts.missing, []);
});

test('compareScreen: unstyled page fails with reason unstyled', () => {
  const result = run(mockup(), page({ styled: false }));
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes('unstyled'));
});

test('compareScreen: unstyled is not reported when the mockup is also unstyled', () => {
  const result = run(mockup({ styled: false }), page({ styled: false }));
  assert.ok(!result.reasons.includes('unstyled'));
});

test('compareScreen: missing font is reported with its name', () => {
  const result = run(mockup({ fonts: ['Figtree'] }), page({ fonts: ['Arial'] }));
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes('font-missing: Figtree'));
  assert.deepEqual(result.parts.fonts.missing, ['Figtree']);
});

test('compareScreen: loader hash name counts as the same family', () => {
  const result = run(mockup({ fonts: ['Figtree'] }), page({ fonts: ['__Figtree_a1b2c3'] }));
  assert.ok(!result.reasons.some((r) => r.startsWith('font-missing')));
  assert.deepEqual(result.parts.fonts.missing, []);
});

test('compareScreen: fallback family name counts as the same family', () => {
  const result = run(mockup({ fonts: ['Figtree'] }), page({ fonts: ['Figtree Fallback'] }));
  assert.ok(!result.reasons.some((r) => r.startsWith('font-missing')));
  assert.deepEqual(result.parts.fonts.missing, []);
});

test('compareScreen: font names compare case-insensitively', () => {
  const result = run(mockup({ fonts: ['FIGTREE'] }), page({ fonts: ['figtree'] }));
  assert.deepEqual(result.parts.fonts.missing, []);
});

test('compareScreen: generic fonts are ignored when missing', () => {
  const result = run(
    mockup({ fonts: ['Arial', 'Helvetica', 'Inter'] }),
    page({ fonts: ['Inter'] }),
  );
  assert.deepEqual(result.parts.fonts.missing, []);
  assert.ok(!result.reasons.some((r) => r.includes('Arial')));
  assert.ok(!result.reasons.some((r) => r.includes('Helvetica')));
});

test('compareScreen: horizontal overflow of more than 2px fails', () => {
  const result = run(mockup(), page({ scrollWidth: 393 }));
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes('horizontal-overflow'));
});

test('compareScreen: overflow of exactly 2px is allowed', () => {
  const result = run(mockup(), page({ scrollWidth: 392 }));
  assert.ok(!result.reasons.includes('horizontal-overflow'));
});

test('compareScreen: text mismatch below the threshold fails', () => {
  const result = run(mockup(), page({ words: ['alpha', 'bravo'] }));
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some((r) => /^text-mismatch: /.test(r)));
  approx(result.parts.text, 0.2);
});

test('compareScreen: text check is skipped for a mockup with fewer than 5 words', () => {
  const result = run(mockup({ words: ['alpha', 'bravo', 'charlie', 'delta'] }), page({ words: [] }));
  assert.equal(result.parts.text, null);
  assert.ok(!result.reasons.some((r) => r.startsWith('text-mismatch')));
});

test('compareScreen: colors missing when fewer than 40 percent match', () => {
  const mockupColors = ['rgb(10, 20, 30)', 'rgb(200, 100, 50)', 'rgb(0, 0, 0)'];
  const pageColors = ['rgb(100, 150, 200)', 'rgb(250, 10, 10)', 'rgb(90, 90, 90)'];
  const result = run(mockup({ colors: mockupColors }), page({ colors: pageColors }));
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some((r) => /^colors-missing: /.test(r)));
  approx(result.parts.colors, 0);
});

test('compareScreen: colors within per-channel distance 12 match', () => {
  const mockupColors = ['rgb(10, 20, 30)', 'rgb(200, 100, 50)', 'rgb(0, 0, 0)'];
  const pageColors = ['rgb(22, 32, 42)', 'rgb(212, 112, 62)', 'rgb(12, 12, 12)'];
  const result = run(mockup({ colors: mockupColors }), page({ colors: pageColors }));
  assert.ok(!result.reasons.some((r) => r.startsWith('colors-missing')));
  approx(result.parts.colors, 1);
});

test('compareScreen: a color 13 away on one channel does not match', () => {
  const mockupColors = ['rgb(10, 20, 30)', 'rgb(200, 100, 50)', 'rgb(0, 0, 0)'];
  const pageColors = ['rgb(23, 33, 43)', 'rgb(213, 113, 63)', 'rgb(13, 13, 13)'];
  const result = run(mockup({ colors: mockupColors }), page({ colors: pageColors }));
  assert.ok(result.reasons.some((r) => r.startsWith('colors-missing')));
  approx(result.parts.colors, 0);
});

test('compareScreen: color check is skipped for a mockup with fewer than 3 colors', () => {
  const result = run(mockup({ colors: ['rgb(10, 20, 30)', 'rgb(200, 100, 50)'] }), page({ colors: [] }));
  assert.equal(result.parts.colors, null);
  assert.ok(!result.reasons.some((r) => r.startsWith('colors-missing')));
});

test('compareScreen: visual score under minScore fails', () => {
  const result = run(mockup(), page(), 0.6, { minScore: 0.7, text: 0.5 });
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some((r) => /^visual: /.test(r)));
  approx(result.parts.visual, 0.6);
  approx(result.score, 0.6);
});

test('compareScreen: visual score at minScore passes', () => {
  const result = run(mockup(), page(), 0.7, { minScore: 0.7, text: 0.5 });
  assert.equal(result.pass, true);
  assert.deepEqual(result.reasons, []);
});

test('compareScreen: parts report visual, text, colors and fonts numbers', () => {
  const result = run(mockup(), page({ words: WORDS.slice(0, 6) }), 0.85);
  assert.deepEqual(Object.keys(result.parts).sort(), ['colors', 'fonts', 'text', 'visual']);
  approx(result.parts.visual, 0.85);
  approx(result.parts.text, 0.6);
  approx(result.parts.colors, 1);
  assert.deepEqual(result.parts.fonts, { missing: [] });
  assert.equal(result.score, 0.85);
});
