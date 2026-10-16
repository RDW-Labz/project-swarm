// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
const MARKER = 'swarm-secret-allow';
const PLACEHOLDER_WORD = /^(?:example|placeholder|your|test|dummy)$/i;
const R = (id, name, re) => ({ id, name, re });
export const SECRET_RULES = [
R('aws-access-key-id', 'AWS access key ID', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/),
R('aws-secret', 'AWS secret access key', /aws_secret_access_key[\x22']?\s*[=:]\s*[\x22']?[A-Za-z0-9\/+=]{40}/i),
R('github-token', 'GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/),
R('slack-token', 'Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/),
R('stripe-live-key', 'Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/),
R('private-key-block', 'Private key block', /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|PGP) )?PRIVATE KEY-----/),
R('google-api-key', 'Google API key', /\bAIza[A-Za-z0-9_-]{35}/),
R('anthropic-key', 'Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/),
R('openai-key', 'OpenAI API key', /(?<![A-Za-z])sk-[A-Za-z0-9]{32,}/),
R('jwt', 'JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/),
R('url-password', 'Password in URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:(?!(?:password|changeme|example|\*+)@)[^\s@\/]{6,}@[^\s\/]+/i),
R('generic-secret', 'Generic secret assignment', /(?:api[_ -]?key|apikey|secret|token|password)[\x22']?\s*[:=]\s*([\x22'])([A-Za-z0-9\/+_=.-]{20,})\1/i)
];
export function shannonEntropy(text) {
  const s = String(text ?? '');
  if (!s.length) return 0;
  const c = new Map();
  for (let i = 0; i < s.length; i++) c.set(s[i], (c.get(s[i]) || 0) + 1);
  let h = 0;
  for (const n of c.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
export function scanSecrets(files = [], { allowFingerprints = [], maxBytes = 1000000 } = {}) {
  const allow = new Set(allowFingerprints), out = [];
  for (const f of Array.isArray(files) ? files : []) {
    const buf = Buffer.isBuffer(f?.content) ? f.content : Buffer.from(String(f?.content ?? ''), 'utf8');
    if (buf.length > maxBytes || buf.includes(0)) continue;
    const counts = new Map(), lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < 200; i++) {
      if (lines[i].includes(MARKER)) continue;
      for (const rule of SECRET_RULES) {
        if (out.length >= 200) break;
        const m = rule.re.exec(lines[i]);
        if (!m) continue;
        if (rule.id === 'generic-secret' && (shannonEntropy(m[2]) < 3.5 || m[2].split(/[^A-Za-z]+/).some(w => PLACEHOLDER_WORD.test(w)))) continue;
        const fp = createHash('sha256').update(m[0]).digest('hex').slice(0, 12);
        const c = counts.get(rule.id) || 0;
        if (allow.has(fp) || c >= 3) continue;
        counts.set(rule.id, c + 1);
        out.push({ rule: rule.id, name: rule.name, path: f.path, line: i + 1, fingerprint: fp });
      }
    }
  }
  return out;
}
const parseJson = (x) => { if (typeof x !== 'string') return x ?? null; try { return JSON.parse(x); } catch { return null; } };
const arr = (x) => (Array.isArray(x) ? x : []);
const lc = (x) => (typeof x === 'string' ? x.toLowerCase() : '');
const isObj = (x) => !!x && typeof x === 'object';
export function parseNpmAudit(input) {
  const j = parseJson(input);
  if (!isObj(j)) return [];
  const out = [];
  if (isObj(j.vulnerabilities)) for (const [name, v] of Object.entries(j.vulnerabilities)) out.push({ name, severity: lc(v?.severity), source: 'npm' });
  else if (isObj(j.advisories)) for (const a of Object.values(j.advisories)) out.push({ name: a?.module_name, severity: lc(a?.severity), source: 'npm' });
  return out;
}
export function parseOsv(input) {
  const j = parseJson(input), out = [];
  for (const r of arr(j?.results)) for (const p of arr(r?.packages)) for (const v of arr(p?.vulnerabilities)) out.push({ name: p?.package?.name, severity: lc(v?.database_specific?.severity) || 'high', id: v?.id, source: 'osv' });
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
  return arr(j?.results).map(r => { const sev = String(r?.extra?.severity ?? ''); return { ruleId: r?.check_id, path: r?.path, line: r?.start?.line, severity: MAP[sev.toUpperCase()] ?? lc(sev), message: String(r?.extra?.message ?? '').slice(0, 200) }; });
}
export function licenseBlocked(expression, { allowCopyleft = false, approved = [] } = {}) {
  if (allowCopyleft || typeof expression !== 'string') return false;
  const text = expression.replace(/[()]/g, ' ').trim();
  if (!text) return false;
  const ok = new Set(arr(approved).map(a => String(a).trim().toLowerCase()));
  if (ok.has(text.toLowerCase())) return false;
  const gpl = t => !ok.has(t.toLowerCase()) && /(^|[^A-Za-z])A?GPL/i.test(t);
  const blockedAlt = a => a.split(/\s+(?:AND|WITH)\s+/i).some(p => gpl(p.trim()));
  return text.split(/\s+OR\s+/i).every(blockedAlt);
}
