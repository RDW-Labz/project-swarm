// SPDX-License-Identifier: Apache-2.0
// A small QR code encoder (byte mode, error correction M, versions 1 to 10: up to 213 bytes) so `swarm remote` can print a code a phone camera reads,
// with no dependency. Written from the QR specification (ISO/IEC 18004); the layout, Reed-Solomon and mask steps follow it.

// Per version, error correction M: [[blocks, data codewords per block]..., error codewords per block], alignment pattern centres.
const SPEC = {
  1: { groups: [[1, 16]], ec: 10, align: [] },
  2: { groups: [[1, 28]], ec: 16, align: [6, 18] },
  3: { groups: [[1, 44]], ec: 26, align: [6, 22] },
  4: { groups: [[2, 32]], ec: 18, align: [6, 26] },
  5: { groups: [[2, 43]], ec: 24, align: [6, 30] },
  6: { groups: [[4, 27]], ec: 16, align: [6, 34] },
  7: { groups: [[4, 31]], ec: 18, align: [6, 22, 38] },
  8: { groups: [[2, 38], [2, 39]], ec: 22, align: [6, 24, 42] },
  9: { groups: [[3, 36], [2, 37]], ec: 22, align: [6, 26, 46] },
  10: { groups: [[4, 43], [1, 44]], ec: 26, align: [6, 28, 50] },
};
export const QR_MAX_BYTES = 213;

// GF(256) with the QR polynomial 0x11d.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    poly.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); });
    poly = next;
  }
  return poly;
}

export function reedSolomon(data, degree) {
  const gen = generator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    if (factor !== 0) gen.slice(1).forEach((c, i) => { rem[i] ^= mul(c, factor); });
  }
  return rem;
}

function dataCodewords(bytes, version) {
  const spec = SPEC[version];
  const capacity = spec.groups.reduce((n, [blocks, size]) => n + blocks * size, 0);
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; out.length < capacity; pad += 1) out.push(pad % 2 === 0 ? 0xec : 0x11);
  return out;
}

function interleave(codewords, version) {
  const spec = SPEC[version];
  const blocks = [];
  let at = 0;
  for (const [count, size] of spec.groups) for (let i = 0; i < count; i += 1) { const data = codewords.slice(at, at + size); at += size; blocks.push({ data, ec: reedSolomon(data, spec.ec) }); }
  const out = [];
  const longest = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < longest; i += 1) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < spec.ec; i += 1) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

const bch = (value, poly, bitsLength) => {
  let v = value << bitsLength;
  const top = (n) => 31 - Math.clz32(n);
  while (v !== 0 && top(v) >= top(poly)) v ^= poly << (top(v) - top(poly));
  return v;
};
// Error correction M is the format bits 00; the five bits are that and the mask number.
export const formatBits = (mask) => { const data = (0b00 << 3) | mask; return ((data << 10) | bch(data, 0x537, 10)) ^ 0x5412; };
const versionBits = (version) => (version << 12) | bch(version, 0x1f25, 12);

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0,
];

function buildMatrix(version, codewords, mask) {
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, dark, fixed = true) => { if (r < 0 || c < 0 || r >= size || c >= size) return; modules[r][c] = dark; if (fixed) reserved[r][c] = true; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      set(r0 + r, c0 + c, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  const centres = SPEC[version].align;
  for (const r of centres) for (const c of centres) {
    if ((r === 6 && c === 6) || (r === 6 && c === centres.at(-1)) || (r === centres.at(-1) && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  for (let i = 8; i < size - 8; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  set(size - 8, 8, true);   // the always-dark module
  for (let i = 0; i < 9; i += 1) { reserved[8][i] = true; reserved[i][8] = true; }
  for (let i = 0; i < 8; i += 1) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
  if (version >= 7) {
    const v = versionBits(version);
    for (let i = 0; i < 18; i += 1) { const dark = ((v >>> i) & 1) === 1; set(Math.floor(i / 3), size - 11 + (i % 3), dark); set(size - 11 + (i % 3), Math.floor(i / 3), dark); }
  }
  // Data bits, two columns at a time from the bottom right, skipping the vertical timing column.
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((cw >>> i) & 1);
  let k = 0;
  for (let right = size - 1, up = true; right >= 1; right -= 2, up = !up) {
    if (right === 6) right = 5;
    for (let n = 0; n < size; n += 1) {
      const r = up ? size - 1 - n : n;
      for (const c of [right, right - 1]) {
        if (reserved[r][c]) continue;
        const bit = k < bits.length ? bits[k] === 1 : false;
        k += 1;
        modules[r][c] = bit !== MASKS[mask](r, c);
      }
    }
  }
  const f = formatBits(mask);
  const fbit = i => ((f >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) set(i, 8, fbit(i));
  set(7, 8, fbit(6)); set(8, 8, fbit(7)); set(8, 7, fbit(8));
  for (let i = 9; i < 15; i += 1) set(8, 14 - i, fbit(i));
  for (let i = 0; i < 8; i += 1) set(8, size - 1 - i, fbit(i));
  for (let i = 8; i < 15; i += 1) set(size - 15 + i, 8, fbit(i));
  set(size - 8, 8, true);
  return modules;
}

function penalty(m) {
  const n = m.length;
  let score = 0;
  const runs = (line) => { let s = 0; let run = 1; for (let i = 1; i < n; i += 1) { if (line[i] === line[i - 1]) run += 1; else { if (run >= 5) s += run - 2; run = 1; } } if (run >= 5) s += run - 2; return s; };
  for (let i = 0; i < n; i += 1) { score += runs(m[i]); score += runs(m.map(row => row[i])); }
  for (let r = 0; r < n - 1; r += 1) for (let c = 0; c < n - 1; c += 1) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const hit = (get) => { let s = 0; for (let i = 0; i + 11 <= n; i += 1) { if (pattern.every((p, j) => get(i + j) === p) || pattern.every((p, j) => get(i + 10 - j) === p)) s += 40; } return s; };
  for (let i = 0; i < n; i += 1) { score += hit(j => m[i][j]); score += hit(j => m[j][i]); }
  const dark = m.flat().filter(Boolean).length;
  score += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  return score;
}

// text -> a square matrix of booleans (true = dark module), without the quiet zone.
export function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const version = Object.keys(SPEC).map(Number).find(v => {
    const capacity = SPEC[v].groups.reduce((n, [blocks, size]) => n + blocks * size, 0);
    return 4 + (v <= 9 ? 8 : 16) + bytes.length * 8 <= capacity * 8;
  });
  if (!version) throw new Error(`QR code: ${bytes.length} bytes is more than the ${QR_MAX_BYTES} this encoder holds.`);
  const codewords = interleave(dataCodewords(bytes, version), version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const m = buildMatrix(version, codewords, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { m, score };
  }
  return best.m;
}

// Terminal text. Two rows of modules per line with half blocks; the quiet zone is light; with `color` the colours are set outright so a light or dark terminal both work.
export function qrText(text, { color = false, quiet = 4 } = {}) {
  const m = qrMatrix(text);
  const n = m.length + quiet * 2;
  const dark = (r, c) => { const rr = r - quiet; const cc = c - quiet; return rr >= 0 && cc >= 0 && rr < m.length && cc < m.length && m[rr][cc]; };
  const lines = [];
  for (let r = 0; r < n; r += 2) {
    let line = '';
    for (let c = 0; c < n; c += 1) {
      const top = !dark(r, c); const bottom = r + 1 < n ? !dark(r + 1, c) : true;   // light = a lit block
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(color ? `\u001b[97;40m${line}\u001b[0m` : line);
  }
  return `${lines.join('\n')}\n`;
}
