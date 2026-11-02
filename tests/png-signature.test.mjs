import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, gridSignature, compareSignatures } from '../tools/png-signature.mjs';

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function predict(type, a, b, c) {
  switch (type) {
    case 0: return 0;
    case 1: return a;
    case 2: return b;
    case 3: return (a + b) >> 1;
    case 4: return paeth(a, b, c);
    default: throw new Error('bad filter type');
  }
}

function filterRow(type, raw, prev, bpp) {
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const a = i >= bpp ? raw[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    out[i] = (raw[i] - predict(type, a, b, c)) & 0xff;
  }
  return out;
}

function encodePng({ width, height, colorType = 6, bitDepth = 8, interlace = 0, rows, filters = [], plte = null }) {
  const channels = CHANNELS[colorType];
  const bpp = Math.max(1, (channels * bitDepth) >> 3);
  const parts = [];
  let prev = new Uint8Array(rows.length ? rows[0].length : 0);
  rows.forEach((raw, y) => {
    const type = filters.length ? filters[y % filters.length] : 0;
    parts.push(Buffer.from([type]), Buffer.from(filterRow(type, raw, prev, bpp)));
    prev = raw;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  const chunks = [chunk('IHDR', ihdr)];
  if (plte) chunks.push(chunk('PLTE', plte));
  chunks.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(parts))));
  chunks.push(chunk('IEND', new Uint8Array(0)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function pattern(x, y, k) {
  return (x * 37 + y * 91 + k * 53 + ((x * y) << 2)) & 255;
}

function rowsOf(width, height, channels, fn) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const r = new Uint8Array(width * channels);
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < channels; k++) r[x * channels + k] = fn(x, y, k);
    }
    rows.push(r);
  }
  return rows;
}

function flat(rows) {
  return Buffer.concat(rows.map((r) => Buffer.from(r)));
}

function solidImage(width, height, rgba) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

function near(actual, expected, tol = 0.5) {
  assert.ok(Math.abs(actual - expected) <= tol, 'expected ' + actual + ' to be within ' + tol + ' of ' + expected);
}

test('round trip of an RGBA image', () => {
  const rows = rowsOf(5, 4, 4, pattern);
  const img = decodePng(encodePng({ width: 5, height: 4, colorType: 6, rows }));
  assert.equal(img.width, 5);
  assert.equal(img.height, 4);
  assert.ok(img.data instanceof Uint8Array);
  assert.deepEqual(Buffer.from(img.data), flat(rows));
});

test('round trip of an RGB image gives opaque alpha', () => {
  const rows = rowsOf(3, 2, 3, pattern);
  const img = decodePng(encodePng({ width: 3, height: 2, colorType: 2, rows }));
  const expected = [];
  for (const r of rows) {
    for (let x = 0; x < 3; x++) expected.push(r[x * 3], r[x * 3 + 1], r[x * 3 + 2], 255);
  }
  assert.deepEqual(Buffer.from(img.data), Buffer.from(expected));
});

test('gray image expands to opaque RGBA', () => {
  const rows = [Uint8Array.from([0, 128, 255])];
  const img = decodePng(encodePng({ width: 3, height: 1, colorType: 0, rows }));
  assert.deepEqual(Buffer.from(img.data), Buffer.from([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]));
});

test('gray-alpha image keeps alpha', () => {
  const rows = [Uint8Array.from([10, 0, 200, 128])];
  const img = decodePng(encodePng({ width: 2, height: 1, colorType: 4, rows }));
  assert.deepEqual(Buffer.from(img.data), Buffer.from([10, 10, 10, 0, 200, 200, 200, 128]));
});

test('palette image maps indices and ignores tRNS alpha', () => {
  const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const rows = [Uint8Array.from([0, 1, 2])];
  const img = decodePng(encodePng({ width: 3, height: 1, colorType: 3, rows, plte }));
  assert.deepEqual(Buffer.from(img.data), Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]));
});

for (const f of [1, 2, 3, 4]) {
  test('filter ' + f + ' decodes back to the raw pixels', () => {
    const rows = rowsOf(6, 5, 4, pattern);
    const img = decodePng(encodePng({ width: 6, height: 5, colorType: 6, rows, filters: [f] }));
    assert.deepEqual(Buffer.from(img.data), flat(rows));
  });
}

test('mixed filters 0 to 4 per row decode back to the raw pixels', () => {
  const rows = rowsOf(7, 5, 3, pattern);
  const img = decodePng(encodePng({ width: 7, height: 5, colorType: 2, rows, filters: [0, 1, 2, 3, 4] }));
  const expected = [];
  for (const r of rows) {
    for (let x = 0; x < 7; x++) expected.push(r[x * 3], r[x * 3 + 1], r[x * 3 + 2], 255);
  }
  assert.deepEqual(Buffer.from(img.data), Buffer.from(expected));
});

test('bad signature is png-invalid', () => {
  const buf = encodePng({ width: 2, height: 1, rows: rowsOf(2, 1, 4, pattern) });
  buf[0] = 0;
  assert.throws(() => decodePng(buf), { code: 'png-invalid' });
});

test('bad CRC is png-invalid', () => {
  const buf = encodePng({ width: 2, height: 1, rows: rowsOf(2, 1, 4, pattern) });
  buf[32] ^= 0xff;
  assert.throws(() => decodePng(buf), { code: 'png-invalid' });
});

test('interlaced PNG is png-unsupported', () => {
  const buf = encodePng({ width: 2, height: 1, interlace: 1, rows: rowsOf(2, 1, 4, pattern) });
  assert.throws(() => decodePng(buf), { code: 'png-unsupported' });
});

test('16-bit PNG is png-unsupported', () => {
  const buf = encodePng({ width: 2, height: 1, colorType: 2, bitDepth: 16, rows: rowsOf(2, 1, 6, pattern) });
  assert.throws(() => decodePng(buf), { code: 'png-unsupported' });
});

test('truncated pixel data is png-invalid', () => {
  const buf = encodePng({ width: 4, height: 4, rows: rowsOf(4, 2, 4, pattern) });
  assert.throws(() => decodePng(buf), { code: 'png-invalid' });
});

test('width at the limit of 4096 is accepted', () => {
  const rows = rowsOf(4096, 1, 4, pattern);
  const img = decodePng(encodePng({ width: 4096, height: 1, rows }));
  assert.equal(img.width, 4096);
  assert.equal(img.height, 1);
});

test('width above 4096 is refused', () => {
  const rows = rowsOf(4097, 1, 4, pattern);
  const buf = encodePng({ width: 4097, height: 1, rows });
  assert.throws(() => decodePng(buf), Error);
});

test('height above 20000 is refused', () => {
  const buf = encodePng({ width: 1, height: 20001, rows: [] });
  assert.throws(() => decodePng(buf), Error);
});

test('input above 20 MB is refused', () => {
  const big = Buffer.alloc(20 * 1024 * 1024 + 1);
  assert.throws(() => decodePng(big), Error);
});

test('gridSignature of a solid color gives that color in every cell', () => {
  const sig = gridSignature(solidImage(4, 4, [200, 100, 50, 255]), { cols: 4, rows: 4 });
  assert.equal(sig.cols, 4);
  assert.equal(sig.rows, 4);
  assert.equal(sig.cells.length, 4 * 4 * 3);
  for (let i = 0; i < 16; i++) {
    near(sig.cells[i * 3], 200);
    near(sig.cells[i * 3 + 1], 100);
    near(sig.cells[i * 3 + 2], 50);
  }
});

test('gridSignature of a half-black image: top two rows black, bottom two white', () => {
  const data = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const v = y < 2 ? 0 : 255;
      data.set([v, v, v, 255], (y * 4 + x) * 4);
    }
  }
  const sig = gridSignature({ width: 4, height: 4, data }, { cols: 4, rows: 4 });
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const expected = r < 2 ? 0 : 255;
      const i = (r * 4 + c) * 3;
      near(sig.cells[i], expected);
      near(sig.cells[i + 1], expected);
      near(sig.cells[i + 2], expected);
    }
  }
});

test('gridSignature defaults to 24 by 48 cells', () => {
  const sig = gridSignature(solidImage(4, 4, [1, 2, 3, 255]));
  assert.equal(sig.cols, 24);
  assert.equal(sig.rows, 48);
  assert.equal(sig.cells.length, 24 * 48 * 3);
});

test('transparent pixels are composited on white', () => {
  const sig = gridSignature(solidImage(4, 4, [0, 0, 0, 0]), { cols: 4, rows: 4 });
  for (let i = 0; i < sig.cells.length; i++) near(sig.cells[i], 255);
});

test('half-transparent black composites to mid gray on white', () => {
  const sig = gridSignature(solidImage(4, 4, [0, 0, 0, 128]), { cols: 4, rows: 4 });
  for (let i = 0; i < sig.cells.length; i++) near(sig.cells[i], 127, 1);
});

test('compareSignatures of identical grids gives score 1', () => {
  const a = gridSignature(solidImage(4, 4, [10, 20, 30, 255]), { cols: 4, rows: 4 });
  const b = gridSignature(solidImage(4, 4, [10, 20, 30, 255]), { cols: 4, rows: 4 });
  const r = compareSignatures(a, b);
  assert.equal(r.meanDiff, 0);
  assert.equal(r.score, 1);
});

test('compareSignatures of opposite solid grids: colors differ completely, so the score is capped at 0.2', () => {
  const a = gridSignature(solidImage(4, 4, [0, 0, 0, 255]), { cols: 4, rows: 4 });
  const b = gridSignature(solidImage(4, 4, [255, 255, 255, 255]), { cols: 4, rows: 4 });
  const r = compareSignatures(a, b);
  assert.equal(r.meanDiff, 255);
  assert.equal(r.colorScore, 0);
  assert.equal(r.structureScore, 1);
  assert.ok(Math.abs(r.score - 0.2) < 1e-9);
});

test('the ink map tells a page with text from a blank page of the same color, and a moved layout from a copy', () => {
  const page = (w, h, ink) => ({ width: w, height: h, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => { const p = Math.floor(i / 4); const x = p % w, y = Math.floor(p / w); const c = i % 4; if (c === 3) return 255; return ink(x, y) ? 20 : 245; }) });
  const stripes = (x, y) => y % 4 === 0 && x > 2 && x < 20;
  const moved = (x, y) => y % 4 === 0 && x > 10 && x < 28;
  const opts = { cols: 8, rows: 8 };
  const full = gridSignature(page(32, 32, stripes), opts);
  assert.equal(compareSignatures(full, gridSignature(page(32, 32, stripes), opts)).structureScore, 1);
  const blank = compareSignatures(full, gridSignature(page(32, 32, () => false), opts));
  assert.equal(blank.structureScore, 0);
  assert.ok(blank.score < 0.3, String(blank.score));
  const shifted = compareSignatures(full, gridSignature(page(32, 32, moved), opts));
  assert.ok(shifted.structureScore > 0 && shifted.structureScore < 1);
});

test('compareSignatures of different-size grids throws signature-mismatch', () => {
  const a = gridSignature(solidImage(4, 4, [0, 0, 0, 255]), { cols: 4, rows: 4 });
  const b = gridSignature(solidImage(4, 4, [0, 0, 0, 255]), { cols: 2, rows: 2 });
  assert.throws(() => compareSignatures(a, b), { code: 'signature-mismatch' });
});
