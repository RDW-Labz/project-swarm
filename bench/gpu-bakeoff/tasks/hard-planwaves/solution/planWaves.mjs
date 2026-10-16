// Reference solution for TASK.md (planWaves). Solved by Claude in about 30 seconds of wall time, 16/16 tests on the first run.
const fail = (code, extra = {}) => Object.assign(new Error(code), { code }, extra);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (xs) => [...new Set(xs)].sort(cmp);

export function normalizePath(p) {
  let s = String(p).trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  const isDir = s.endsWith('/');
  const parts = s.split('/').filter((seg) => seg !== '.' && seg !== '');
  const out = parts.join('/');
  return isDir ? (out ? out + '/' : '/') : out;
}

export function planWaves(tickets, opts = {}) {
  if (!Array.isArray(tickets)) throw fail('BAD_INPUT');
  for (const t of tickets) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || t.id === '') throw fail('BAD_INPUT');
  }
  const maxPerWave = opts.maxPerWave ?? Infinity;
  const maxWeight = opts.maxWeight ?? Infinity;

  // Duplicates
  const seen = new Set();
  const dups = [];
  for (const t of tickets) { if (seen.has(t.id)) dups.push(t.id); seen.add(t.id); }
  if (dups.length) throw fail('DUPLICATE_ID', { ids: sortedUnique(dups) });

  // Normalize tickets (no mutation)
  const T = new Map();
  for (const t of tickets) {
    T.set(t.id, {
      id: t.id,
      deps: [...new Set(t.dependsOn ?? [])],
      files: (t.files ?? []).map(normalizePath),
      weight: t.size === 'M' ? 2 : 1,
      priority: t.priority ?? 0,
    });
  }

  // Unknown deps
  const missing = [];
  for (const t of T.values()) for (const d of t.deps) if (!T.has(d)) missing.push(`${t.id}->${d}`);
  if (missing.length) throw fail('UNKNOWN_DEP', { missing: sortedUnique(missing) });

  // Cycles: iterative Tarjan SCC
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [];
  const cyc = [];
  let idx = 0;
  for (const root of T.keys()) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    index.set(root, idx); low.set(root, idx); idx++; stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      const deps = T.get(v).deps;
      if (i < deps.length) {
        frame[1]++;
        const w = deps[i];
        if (!index.has(w)) {
          index.set(w, idx); low.set(w, idx); idx++; stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1][0];
          low.set(p, Math.min(low.get(p), low.get(v)));
        }
        if (low.get(v) === index.get(v)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
          if (comp.length > 1 || T.get(v).deps.includes(v)) cyc.push(...comp);
        }
      }
    }
  }
  if (cyc.length) throw fail('CYCLE', { ids: sortedUnique(cyc) });

  // Critical path (longest chain, in tickets) via memoized DFS over a topo order
  const order = [];
  {
    const indeg = new Map([...T.keys()].map((k) => [k, 0]));
    const children = new Map([...T.keys()].map((k) => [k, []]));
    for (const t of T.values()) for (const d of t.deps) { indeg.set(t.id, indeg.get(t.id) + 1); children.get(d).push(t.id); }
    const q = [...T.keys()].filter((k) => indeg.get(k) === 0);
    for (let h = 0; h < q.length; h++) {
      const v = q[h]; order.push(v);
      for (const c of children.get(v)) { indeg.set(c, indeg.get(c) - 1); if (indeg.get(c) === 0) q.push(c); }
    }
  }
  const depth = new Map();
  let criticalPath = 0;
  for (const v of order) {
    let d = 1;
    for (const p of T.get(v).deps) d = Math.max(d, depth.get(p) + 1);
    depth.set(v, d);
    criticalPath = Math.max(criticalPath, d);
  }

  // Greedy wave scheduling
  const waveOf = new Map();
  const waves = [];
  let remaining = [...T.values()];
  let totalWeight = 0;
  for (const t of T.values()) totalWeight += t.weight;
  const byPri = (a, b) => (b.priority - a.priority) || cmp(a.id, b.id);

  while (remaining.length) {
    const w = waves.length;
    const ready = remaining.filter((t) => t.deps.every((d) => waveOf.has(d) && waveOf.get(d) < w)).sort(byPri);
    const wave = [];
    let weight = 0;
    const filesIn = new Set();     // exact file paths and dir claims (with trailing /)
    const prefixes = new Set();    // every dir prefix "a/", "a/b/" of every path in the wave
    const dirClaims = new Set();
    const conflicts = (paths) => {
      for (const p of paths) {
        if (p.endsWith('/')) {
          if (prefixes.has(p) || dirClaims.has(p)) return true;
        } else if (filesIn.has(p)) return true;
        // is p under any claimed dir?
        let i = p.indexOf('/');
        while (i !== -1 && i < p.length - 1) {
          if (dirClaims.has(p.slice(0, i + 1))) return true;
          i = p.indexOf('/', i + 1);
        }
        if (p.endsWith('/') && dirClaims.has(p)) return true;
      }
      return false;
    };
    const claim = (paths) => {
      for (const p of paths) {
        if (p.endsWith('/')) { dirClaims.add(p); prefixes.add(p); } else filesIn.add(p);
        let i = p.indexOf('/');
        while (i !== -1) { prefixes.add(p.slice(0, i + 1)); i = p.indexOf('/', i + 1); }
      }
    };
    for (const t of ready) {
      if (wave.length >= maxPerWave) break;
      const fits = weight + t.weight <= maxWeight || (wave.length === 0 && t.weight > maxWeight);
      if (!fits) continue;
      if (conflicts(t.files)) continue;
      // also a ticket's own paths may conflict with each other: allowed (same ticket)
      wave.push(t.id); weight += t.weight; claim(t.files);
    }
    if (!wave.length) throw new Error('internal: no progress');
    for (const id of wave) waveOf.set(id, w);
    waves.push(wave);
    const placed = new Set(wave);
    remaining = remaining.filter((t) => !placed.has(t.id));
  }

  return {
    waves,
    stats: {
      waveCount: waves.length,
      maxParallel: waves.reduce((m, w) => Math.max(m, w.length), 0),
      criticalPath,
      totalWeight,
    },
  };
}
