// Anonymize a swarm ticket ledger for use as a test fixture: keep structure, drop all free text and real names.
import fs from 'node:fs';
import crypto from 'node:crypto';
const [src, dst, salt = 'swarm-fixture'] = process.argv.slice(2);
const ledger = JSON.parse(fs.readFileSync(src, 'utf8'));
const h = (s, n = 6) => crypto.createHash('sha256').update(salt + '\0' + s).digest('hex').slice(0, n);
const seg = (s) => {
  const m = s.match(/^(.*?)((?:\.[A-Za-z0-9]+)+)$/);
  return m ? `${/^[A-Za-z]{1,3}$/.test(m[1]) ? m[1] : 'f' + h(m[1])}${m[2]}` : 'd' + h(s);
};
const anonPath = (p) => (typeof p === 'string' ? p.split('/').map(seg).join('/') : p);
const stageMap = new Map();
const stage = (s) => { if (s == null) return s; if (!stageMap.has(s)) stageMap.set(s, `S${stageMap.size}`); return stageMap.get(s); };
const epicMap = new Map();
const epic = (e) => { if (e == null) return e; if (!epicMap.has(e)) epicMap.set(e, `E${epicMap.size + 1}`); return epicMap.get(e); };
const tickets = ledger.tickets.map((t, i) => ({
  id: t.id,
  title: `${t.type ?? 'build'} ticket ${t.id}`,
  type: t.type,
  stage: stage(t.stage),
  epic: epic(t.epic),
  scopeRefs: (t.scopeRefs ?? []).map(r => (/^R-\d+$/.test(r) ? r : 'ref-' + h(r))),
  acceptance: (t.acceptance ?? []).map((_, k) => `Acceptance line ${k + 1} of ${t.id}.`),
  files: (t.files ?? []).map(anonPath),
  context: (t.context ?? []).map(anonPath),
  contracts: (t.contracts ?? []).map(anonPath),
  ...(t.tests ? { tests: t.tests.map(anonPath) } : {}),
  dependsOn: t.dependsOn ?? [],
  size: t.size,
  risk: t.risk,
  sensitive: t.sensitive === true,
  status: t.status,
}));
const out = {
  version: ledger.version,
  scope: { name: 'Anonymized Project', version: ledger.scope?.version ?? 1, hash: h(JSON.stringify(ledger.scope ?? {}), 64), file: 'docs/scope/scope.md' },
  tickets,
  changeOrders: [],
  approved: ledger.approved ?? null,
  createdAt: ledger.createdAt,
  updatedAt: ledger.updatedAt,
};
fs.writeFileSync(dst, JSON.stringify(out, null, 1) + '\n');
const c = {}; for (const t of tickets) c[t.status] = (c[t.status] || 0) + 1;
console.log(dst, tickets.length, 'tickets', JSON.stringify(c), fs.statSync(dst).size, 'bytes');
