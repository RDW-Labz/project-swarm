import { inflateSync } from 'node:zlib';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_INPUT = 20 * 1024 * 1024;
const MAX_W = 4096;
const MAX_H = 20000;
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buffer) {
  if (!(buffer instanceof Uint8Array)) throw fail('png-invalid', 'input must be bytes');
  if (buffer.length > MAX_INPUT) throw fail('png-invalid', 'PNG input too large');
  if (buffer.length < 8 || SIG.some((b, i) => buffer[i] !== b)) {
    throw fail('png-invalid', 'bad PNG signature');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let pos = 8;
  let header = null;
  let palette = null;
  const idat = [];
  let sawEnd = false;

  while (pos < buffer.length && !sawEnd) {
    if (pos + 12 > buffer.length) throw fail('png-invalid', 'truncated chunk');
    const len = view.getUint32(pos);
    if (pos + 12 + len > buffer.length) throw fail('png-invalid', 'chunk runs past end');
    const type = String.fromCharCode(...buffer.subarray(pos + 4, pos + 8));
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    const crc = view.getUint32(pos + 8 + len);
    if (crc32(buffer.subarray(pos + 4, pos + 8 + len)) !== crc) {
      throw fail('png-invalid', 'bad CRC in ' + type);
    }
    if (type === 'IHDR') {
      if (pos !== 8 || len !== 13) throw fail('png-invalid', 'bad IHDR');
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      header = {
        width: dv.getUint32(0),
        height: dv.getUint32(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      sawEnd = true;
    }
    pos += 12 + len;
  }

  if (!header || !sawEnd || idat.length === 0) throw fail('png-invalid', 'missing PNG chunks');
  const { width, height, bitDepth, colorType, compression, filter, interlace } = header;
  if (compression !== 0 || filter !== 0) throw fail('png-invalid', 'bad compression or filter method');
  if (interlace !== 0) throw fail('png-unsupported', 'interlaced PNG is not supported');
  if (bitDepth !== 8 || CHANNELS[colorType] === undefined) {
    throw fail('png-unsupported', 'only 8-bit color types 0, 2, 3, 4, 6 are supported');
  }
  if (colorType === 3 && !palette) throw fail('png-invalid', 'palette image without PLTE');
  if (width < 1 || width > MAX_W || height < 1 || height > MAX_H) {
    throw fail('png-invalid', 'image dimensions out of range');
  }

  let total = 0;
  for (const part of idat) total += part.length;
  const joined = new Uint8Array(total);
  let off = 0;
  for (const part of idat) {
    joined.set(part, off);
    off += part.length;
  }
  let raw;
  try {
    // The pixel data cannot be larger than the image says: a bigger stream is a decompression bomb.
    raw = inflateSync(joined, { maxOutputLength: height * ((width * CHANNELS[colorType]) + 1) });
  } catch {
    throw fail('png-invalid', 'bad zlib stream');
  }

  const ch = CHANNELS[colorType];
  const rowLen = width * ch;
  const stride = rowLen + 1;
  if (raw.length < height * stride) throw fail('png-invalid', 'too little pixel data');

  const out = new Uint8Array(height * rowLen);
  for (let y = 0; y < height; y++) {
    const type = raw[y * stride];
    if (type > 4) throw fail('png-invalid', 'bad filter type');
    const src = y * stride + 1;
    const dst = y * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = raw[src + i];
      const a = i >= ch ? out[dst + i - ch] : 0;
      const b = y > 0 ? out[dst - rowLen + i] : 0;
      const c = y > 0 && i >= ch ? out[dst - rowLen + i - ch] : 0;
      let v;
      if (type === 0) v = x;
      else if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else v = x + paeth(a, b, c);
      out[dst + i] = v & 0xff;
    }
  }

  const n = width * height;
  const data = new Uint8Array(n * 4);
  for (let p = 0; p < n; p++) {
    const s = p * ch;
    const d = p * 4;
    if (colorType === 3) {
      const idx = out[s];
      if (idx * 3 + 2 >= palette.length) throw fail('png-invalid', 'palette index out of range');
      data[d] = palette[idx * 3];
      data[d + 1] = palette[idx * 3 + 1];
      data[d + 2] = palette[idx * 3 + 2];
    } else if (colorType === 0 || colorType === 4) {
      data[d] = out[s];
      data[d + 1] = out[s];
      data[d + 2] = out[s];
    } else {
      data[d] = out[s];
      data[d + 1] = out[s + 1];
      data[d + 2] = out[s + 2];
    }
    if (colorType === 4) data[d + 3] = out[s + 1];
    else if (colorType === 6) data[d + 3] = out[s + 3];
    else data[d + 3] = 255;
  }

  return { width, height, data };
}

export function gridSignature(image, { cols = 24, rows = 48 } = {}) {
  if (!Number.isInteger(cols) || cols < 1 || cols > 512 || !Number.isInteger(rows) || rows < 1 || rows > 512) {
    throw fail('grid-invalid', 'grid size must be 1 to 512');
  }
  const { width: w, height: h, data: d } = image || {};
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || !d || d.length !== w * h * 4) {
    throw fail('grid-invalid', 'bad image');
  }
  const cells = new Float32Array(cols * rows * 3);
  const ink = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const y0 = Math.floor((j * h) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((j + 1) * h) / rows));
    for (let i = 0; i < cols; i++) {
      const x0 = Math.floor((i * w) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * w) / cols));
      let r = 0;
      let g = 0;
      let b = 0;
      let lum = 0;
      let lum2 = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * w + x) * 4;
          const a = d[p + 3] / 255;
          const inv = 255 * (1 - a);
          const pr = d[p] * a + inv;
          const pg = d[p + 1] * a + inv;
          const pb = d[p + 2] * a + inv;
          r += pr;
          g += pg;
          b += pb;
          const l = 0.299 * pr + 0.587 * pg + 0.114 * pb;
          lum += l;
          lum2 += l * l;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const k = (j * cols + i) * 3;
      cells[k] = r / count;
      cells[k + 1] = g / count;
      cells[k + 2] = b / count;
      // ink: how much the brightness varies inside the cell (text, edges, boxes); a blank cell has none
      const mean = lum / count;
      ink[j * cols + i] = Math.sqrt(Math.max(0, lum2 / count - mean * mean));
    }
  }
  return { cols, rows, cells, ink };
}

export function compareSignatures(a, b) {
  if (!a || !b || a.cols !== b.cols || a.rows !== b.rows || a.cells.length !== b.cells.length) {
    throw fail('signature-mismatch', 'signature grids differ in size');
  }
  const n = a.cells.length;
  let sum = 0;
  for (let k = 0; k < n; k++) sum += Math.abs(a.cells[k] - b.cells[k]);
  const meanDiff = n > 0 ? sum / n : 0;
  const colorScore = 1 - meanDiff / 255;
  // Structure: where the pages have ink (text, edges, boxes). Colors alone barely tell a styled page from a blank one (most pixels are
  // background), the ink map does. Both blank counts as the same.
  let inkDiff = 0;
  let inkMax = 0;
  for (let k = 0; k < a.ink.length; k++) {
    inkDiff += Math.abs(a.ink[k] - b.ink[k]);
    inkMax += Math.max(a.ink[k], b.ink[k]);
  }
  const structureScore = inkMax === 0 ? 1 : 1 - inkDiff / inkMax;
  // Colors far apart cap the score (two different solid pages have the same, empty, structure).
  const score = Math.min(0.2 * colorScore + 0.8 * structureScore, colorScore + 0.2);
  return { score, meanDiff, colorScore, structureScore };
}
