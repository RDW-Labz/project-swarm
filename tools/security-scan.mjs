// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac } from 'node:crypto';
const MARKER = 'swarm-secret-allow';
const MAX_FINDINGS = 200, PER_RULE_CAP = 3, MAX_WINDOWS = 20, WINDOW_OVERLAP = 4096;
const LINE_WINDOW = 4096, LINE_OVERLAP = 256, LINE_STEP = LINE_WINDOW - LINE_OVERLAP;
const PLACEHOLDER_WORD = /^(?:example|placeholder|your|test|dummy)$/i;
const SPDX_OPS = ['AND', 'OR', 'WITH'];
const R = (id, name, re, valueGroup = 0) => ({ id, name, re, valueGroup });
const RULE_DEFS = [
R('aws-access-key-id', 'AWS access key ID', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/),
R('aws-secret', 'AWS secret access key', /aws_secret_access_key["']?\s{0,4}[=:]\s{0,4}["']?[A-Za-z0-9\/+=]{40}/i),
R('github-token', 'GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,255}/),
R('github-fine-grained-token', 'GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{22,255}/),
R('gitlab-token', 'GitLab token', /\bglpat-[A-Za-z0-9_-]{20,255}/),
R('npm-token', 'npm token', /\bnpm_[A-Za-z0-9]{36}\b/),
R('slack-token', 'Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,255}/),
R('stripe-live-key', 'Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,255}/),
R('private-key-block', 'Private key block', /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|PGP) )?PRIVATE KEY-----/),
R('google-api-key', 'Google API key', /\bAIza[A-Za-z0-9_-]{35}/),
R('anthropic-key', 'Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,255}/),
R('openai-project-key', 'OpenAI project key', /(?<![A-Za-z])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,255}/),
R('openai-key', 'OpenAI API key', /(?<![A-Za-z])sk-[A-Za-z0-9]{32,255}/),
R('jwt', 'JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,2048}\.eyJ[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,2048}/),
R('url-password', 'Password in URL', /\b[a-z][a-z0-9+.-]{0,16}:\/\/[^\s:\/@]{1,64}:(?!(?:password|changeme|example|\*+)@)[^\s@\/]{6,256}@[^\s\/]{1,256}/i),
R('generic-secret', 'Generic secret assignment', /(?:api[_ -]?key|apikey|secret|token|password)["']?\s{0,4}[:=]\s{0,4}(["'])([A-Za-z0-9\/+_=.-]{20,256})\1/i, 2),
R('env-secret', 'Secret in environment assignment', /^ {0,32}(?:export )?[A-Z][A-Z0-9_]{0,64}(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]{0,64}=([A-Za-z0-9\/+_=.-]{20,256})$/, 1)
];
export const SECRET_RULES = RULE_DEFS.map(r => ({ ...r, g: new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g') }));
export function shannonEntropy(text) {
  const s = String(text ?? '');
  if (!s.length) return 0;
  const c = new Map();
  for (let i = 0; i < s.length; i++) c.set(s[i], (c.get(s[i]) || 0) + 1);
  let h = 0;
  for (const n of c.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
function fingerprint(text, key) {
  const digest = typeof key === 'string' && key.length ? createHmac('sha256', key).update(text) : createHash('sha256').update(text);
  return digest.digest('hex').slice(0, 12);
}
function valueOk(rule, m) {
  if (!rule.valueGroup) return true;
  const v = m[rule.valueGroup] || '';
  if (shannonEntropy(v) < 3.5) return false;
  return !v.split(/[^A-Za-z]+/).some(w => PLACEHOLDER_WORD.test(w));
}
function decode(content) {
  if (typeof content === 'string') return { texts: [content], size: content.length };
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  const texts = [buf.toString('utf8')];
  const head = buf.subarray(0, 4096);
  let nul = 0;
  for (const b of head) if (b === 0) nul++;
  const bom = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
  if (bom || (head.length > 0 && nul * 100 > 30 * head.length)) texts.push(buf.toString('utf16le'));
  return { texts, size: buf.length };
}
function windowsOf(full, size, maxBytes) {
  if (size <= maxBytes) return [{ text: full, base: 0, lineBase: 0 }];
  const step = Math.max(1, maxBytes - WINDOW_OVERLAP);
  const n = 1 + Math.ceil((size - maxBytes) / step);
  if (n > MAX_WINDOWS) return null;
  const out = [];
  for (let k = 0; k < n; k++) {
    const base = k * step;
    out.push({ text: full.slice(base, base + maxBytes), base, lineBase: full.slice(0, base).split('\n').length - 1 });
  }
  return out;
}
function lineSegments(line) {
  if (line.length <= LINE_WINDOW) return [[0, line]];
  const segs = [];
  for (let s = 0; ; s += LINE_STEP) {
    segs.push([s, line.slice(s, s + LINE_WINDOW)]);
    if (s + LINE_WINDOW >= line.length) break;
  }
  return segs;
}
export function scanSecretsDetailed(files = [], { allowFingerprints = [], maxBytes = 1000000, previous = {}, key } = {}) {
  const allow = new Set(allowFingerprints), findings = [], skipped = [];
  for (const f of Array.isArray(files) ? files : []) {
    const path = f?.path;
    if (findings.length >= MAX_FINDINGS) { skipped.push({ path, reason: 'scan limit reached' }); continue; }
    const { texts, size } = decode(f?.content);
    const windows = texts.map(t => windowsOf(t.replace(/\u0000/g, '\n'), size, maxBytes));
    if (windows.some(w => w === null)) { skipped.push({ path, reason: 'too large to scan' }); continue; }
    const prev = previous?.[path];
    const prevText = prev == null ? '' : Buffer.isBuffer(prev) ? prev.toString('utf8') : String(prev);
    const prevLines = new Set(prevText.split(/\r?\n/).map(l => l.trim()));
    const counts = new Map(), seen = new Set();
    windows.forEach((ws, vi) => {
      for (const { text, base, lineBase } of ws) {
        let pos = base;
        const lines = text.split(/\r?\n/);
        for (let li = 0; li < lines.length && findings.length < MAX_FINDINGS; li++) {
          const line = lines[li], lineStart = pos, lineNo = lineBase + li + 1;
          pos += line.length + 1;
          if (line.includes(MARKER) && prevLines.has(line.trim())) continue;
          for (const [segOff, seg] of lineSegments(line)) {
            for (const rule of SECRET_RULES) {
              for (const m of seg.matchAll(rule.g)) {
                if (findings.length >= MAX_FINDINGS) break;
                const dk = `${vi}|${rule.id}|${lineStart + segOff + m.index}`;
                if (seen.has(dk)) continue;
                seen.add(dk);
                if (!valueOk(rule, m)) continue;
                const fp = fingerprint(m[0], key);
                const c = counts.get(rule.id) || 0;
                if (allow.has(fp) || c >= PER_RULE_CAP) continue;
                counts.set(rule.id, c + 1);
                findings.push({ rule: rule.id, name: rule.name, path, line: lineNo, fingerprint: fp });
              }
            }
          }
        }
      }
    });
  }
  return { findings, skipped };
}
export function scanSecrets(files = [], options = {}) {
  return scanSecretsDetailed(files, options).findings;
}
const parseJson = (x) => { if (typeof x !== 'string') return x ?? null; try { return JSON.parse(x); } catch { return null; } };
const arr = (x) => (Array.isArray(x) ? x : []);
const lc = (x) => (typeof x === 'string' ? x.toLowerCase() : '');
const sevNorm = (x) => { const s = lc(x); return s === 'moderate' ? 'medium' : s; };
const isObj = (x) => !!x && typeof x === 'object';
export function parseNpmAudit(input) {
  const j = parseJson(input);
  if (!isObj(j)) return [];
  const out = [];
  if (isObj(j.vulnerabilities)) for (const [name, v] of Object.entries(j.vulnerabilities)) out.push({ name, severity: sevNorm(v?.severity), source: 'npm' });
  else if (isObj(j.advisories)) for (const a of Object.values(j.advisories)) out.push({ name: a?.module_name, severity: sevNorm(a?.severity), source: 'npm' });
  return out;
}
export function parseOsv(input) {
  const j = parseJson(input), out = [];
  for (const r of arr(j?.results)) for (const p of arr(r?.packages)) for (const v of arr(p?.vulnerabilities)) out.push({ name: p?.package?.name, severity: sevNorm(v?.database_specific?.severity) || 'high', id: v?.id, source: 'osv' });
  return out;
}
export function parsePipAudit(input) {
  const j = parseJson(input), deps = Array.isArray(j) ? j : arr(j?.dependencies), out = [];
  for (const d of deps) for (const v of arr(d?.vulns)) out.push({ name: d?.name, severity: 'high', id: v?.id, source: 'pip-audit' });
  return out;
}
export function blockingVulns(vulns = [], blockSeverities = ['high', 'critical']) {
  const s = new Set(arr(blockSeverities).map(lc));
  return arr(vulns).filter(v => s.has(lc(v?.severity)));
}
export function parseSemgrep(input) {
  const j = parseJson(input), MAP = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };
  return arr(j?.results).map(r => { const level = String(r?.extra?.severity ?? ''); return { ruleId: r?.check_id, path: r?.path, line: r?.start?.line, severity: MAP[level.toUpperCase()] ?? lc(level) }; });
}
function legacyBlocked(expression, ok) {
  const text = expression.replace(/[()]/g, ' ').trim();
  if (!text) return false;
  if (ok.has(text.toLowerCase())) return false;
  const gpl = s => !ok.has(s.toLowerCase()) && /(^|[^A-Za-z])A?GPL/i.test(s);
  const blockedAlt = a => a.split(/\s+(?:AND|WITH)\s+/i).some(p => gpl(p.trim()));
  return text.split(/\s+OR\s+/i).every(blockedAlt);
}
function parseSpdxBlocked(expression, isBlocked) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) || [];
  let i = 0;
  const isWord = t => t !== '(' && t !== ')' && !SPDX_OPS.includes(t.toUpperCase());
  const isOp = w => i < tokens.length && tokens[i].toUpperCase() === w;
  function primary() {
    if (tokens[i] === '(') {
      i++;
      const v = orExpr();
      if (tokens[i] !== ')') throw new Error('unbalanced parentheses');
      i++;
      return v;
    }
    const words = [];
    while (i < tokens.length && isWord(tokens[i])) words.push(tokens[i++]);
    if (!words.length) throw new Error('expected license id');
    return isBlocked(words.join(' '));
  }
  function withExpr() {
    const v = primary();
    if (isOp('WITH')) {
      i++;
      if (i >= tokens.length || !isWord(tokens[i])) throw new Error('expected exception id');
      i++;
    }
    return v;
  }
  function andExpr() {
    let v = withExpr();
    while (isOp('AND')) { i++; const r = withExpr(); v = v || r; }
    return v;
  }
  function orExpr() {
    let v = andExpr();
    while (isOp('OR')) { i++; const r = andExpr(); v = v && r; }
    return v;
  }
  const result = orExpr();
  if (i !== tokens.length) throw new Error('trailing tokens');
  return result;
}
export function licenseBlocked(expression, { allowCopyleft = false, approved = [] } = {}) {
  if (allowCopyleft || typeof expression !== 'string') return false;
  const trimmed = expression.trim();
  if (!trimmed) return false;
  const ok = new Set(arr(approved).map(a => String(a).trim().toLowerCase()));
  if (ok.has(trimmed.toLowerCase())) return false;
  const isBlocked = id => {
    const s = id.trim();
    if (!s || ok.has(s.toLowerCase())) return false;
    if (/LGPL|Lesser/i.test(s)) return false;
    return /(^|[^A-Za-z])A?GPL/i.test(s) || /\bGNU (?:Affero )?General Public License\b/i.test(s);
  };
  try {
    return parseSpdxBlocked(trimmed, isBlocked);
  } catch {
    return legacyBlocked(expression, ok);
  }
}
