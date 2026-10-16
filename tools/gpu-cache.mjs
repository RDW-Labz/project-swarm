// SPDX-License-Identifier: Apache-2.0
const HIT_NAMES = ['vllm:prefix_cache_hits_total', 'vllm:gpu_prefix_cache_hits_total'];
const QUERY_NAMES = ['vllm:prefix_cache_queries_total', 'vllm:gpu_prefix_cache_queries_total'];
const RATE_NAMES = ['vllm:gpu_prefix_cache_hit_rate', 'vllm:prefix_cache_hit_rate'];
const LINE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/;

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function nulls() {
  return { hits: null, queries: null, hitRate: null };
}

export function parseCacheStats(text) {
  const sums = { hits: 0, queries: 0 };
  const found = { hits: false, queries: false };
  const rates = {};
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const name = m[1];
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    if (HIT_NAMES.includes(name)) {
      sums.hits += value;
      found.hits = true;
    } else if (QUERY_NAMES.includes(name)) {
      sums.queries += value;
      found.queries = true;
    } else if (RATE_NAMES.includes(name)) {
      if (!(name in rates)) rates[name] = value;
    }
  }
  if (found.hits || found.queries) {
    const hits = found.hits ? sums.hits : null;
    const queries = found.queries ? sums.queries : null;
    let hitRate = null;
    if (hits !== null && queries !== null) {
      hitRate = queries === 0 ? 0 : round4(hits / queries);
    }
    return { hits, queries, hitRate };
  }
  const rateName = RATE_NAMES.find((n) => n in rates);
  if (rateName !== undefined) {
    return { hits: null, queries: null, hitRate: round4(rates[rateName]) };
  }
  return nulls();
}

export async function fetchCacheStats(endpoint, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(endpoint + '/metrics');
    if (!res || !res.ok) return nulls();
    const text = await res.text();
    return parseCacheStats(text);
  } catch {
    return nulls();
  }
}

export function combineCacheStats(list) {
  let hits = 0;
  let queries = 0;
  let pairs = 0;
  const rates = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.hits === 'number' && typeof s.queries === 'number') {
      hits += s.hits;
      queries += s.queries;
      pairs++;
    }
    if (typeof s.hitRate === 'number') rates.push(s.hitRate);
  }
  if (pairs > 0) {
    return { hits, queries, hitRate: queries === 0 ? 0 : round4(hits / queries) };
  }
  if (rates.length > 0) {
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    return { hits: null, queries: null, hitRate: round4(avg) };
  }
  return nulls();
}
