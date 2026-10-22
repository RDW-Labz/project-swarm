// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { loadLocalConfig } from './local-config.mjs';

export const BATCH_LIMITS = Object.freeze({ maxRequests: 10000, maxBytes: 200 * 1024 * 1024, collectMs: 2000, maxHoldMs: 15000, pollMs: 30000, expireMs: 25 * 3600 * 1000 })
export const BATCH_DISCOUNT = 0.5
const ERR_STATUS = { invalid_request_error: 400, authentication_error: 401, permission_error: 403, not_found_error: 404, rate_limit_error: 429, overloaded_error: 529 }
const jsonResp = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const errBody = (type, message) => ({ type: 'error', error: { type, message } })
const abortErr = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e }
const parseJson = (t) => { try { return JSON.parse(t) } catch { return null } }
function toResponse(r) {
  switch (r?.type) {
    case 'succeeded': return jsonResp(200, r.message)
    case 'errored': return jsonResp(Object.hasOwn(ERR_STATUS, r.error?.type) ? ERR_STATUS[r.error.type] : 500, { type: 'error', error: r.error })
    case 'canceled': return jsonResp(499, errBody('batch_canceled', 'batch request canceled'))
    default: return jsonResp(504, errBody('batch_expired', 'batch request expired before it was processed'))
  }
}
export function createBatchCollector({ fetchImpl = globalThis.fetch, readKey, baseUrl = 'https://api.anthropic.com', version = '2023-06-01', now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), setTimer = setTimeout, clearTimer = clearTimeout, limits = {}, onEvent = () => {} } = {}) {
  const L = { ...BATCH_LIMITS, ...limits }
  const batches = new Set()
  let pending = [], pendingBytes = 0, timer = null, seq = 0, closed = false, firstAt = 0
  const emit = (e) => { try { onEvent(e) } catch {} }
  const hdr = (extra = {}) => ({ 'x-api-key': readKey(), 'anthropic-version': version, ...extra })
  const finish = (it, v, isErr) => { if (it.settled) return; it.settled = true; it.signal?.removeEventListener('abort', it.onAbort); isErr ? it.reject(v) : it.resolve(v) }
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null }
  function flush() {
    stopTimer()
    if (!pending.length) return
    const b = { id: null, items: pending, state: 'in_progress', created: 0 }
    pending = []; pendingBytes = 0
    b.items.forEach((it) => { it.batch = b })
    batches.add(b)
    runBatch(b).catch(() => {})
  }
  function submit(body, { id, signal, onSent } = {}) {
    if (closed) return Promise.reject(new Error('batch-closed'))
    if (signal?.aborted) return Promise.reject(abortErr())
    let json
    try { json = JSON.stringify(body) } catch { json = undefined }
    const ok = body && typeof body === 'object' && !Array.isArray(body) && typeof body.model === 'string' && Number.isInteger(body.max_tokens) && Array.isArray(body.messages) && body.messages.length > 0 && typeof json === 'string' && Buffer.byteLength(json) < 4 * 1024 * 1024
    if (!ok) return Promise.reject(new Error('batch-request-invalid'))
    const bytes = Buffer.byteLength(json)
    const customId = `${String(id ?? 'job').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56)}-${++seq}`
    return new Promise((resolve, reject) => {
      const it = { customId, params: body, bytes, resolve, reject, signal, onSent, settled: false, aborted: false, batch: null }
      it.onAbort = () => {
        if (it.settled) return
        if (!it.batch) { pending = pending.filter((p) => p !== it); pendingBytes -= it.bytes; if (!pending.length) stopTimer(); finish(it, abortErr(), true) }
        else { it.aborted = true; finish(it, abortErr(), true); maybeCancel(it.batch) }
      }
      signal?.addEventListener('abort', it.onAbort)
      if (pending.length && (pending.length + 1 > L.maxRequests || pendingBytes + bytes > L.maxBytes)) flush()
      pending.push(it); pendingBytes += bytes
      // The window is a quiet period: it restarts with every new request, but no request waits more than maxHoldMs in all.
      if (pending.length === 1) firstAt = now()
      stopTimer()
      timer = setTimer(flush, Math.max(0, Math.min(L.collectMs, L.maxHoldMs - (now() - firstAt))))
    })
  }
  function maybeCancel(b) {
    if (!b.id || b.state !== 'in_progress' || !b.items.every((it) => it.aborted)) return
    cancelRemote(b)
  }
  async function cancelRemote(b) {
    b.state = 'canceled'
    emit({ type: 'canceled', batchId: b.id })
    try { await fetchImpl(`${baseUrl}/v1/messages/batches/${encodeURIComponent(b.id)}/cancel`, { method: 'POST', headers: hdr() }) } catch {}
  }
  async function runBatch(b) {
    let res, text = ''
    try {
      res = await fetchImpl(`${baseUrl}/v1/messages/batches`, { method: 'POST', headers: hdr({ 'content-type': 'application/json' }), body: JSON.stringify({ requests: b.items.map((it) => ({ custom_id: it.customId, params: it.params })) }) })
    } catch (e) { b.state = 'ended'; return b.items.forEach((it) => finish(it, e, true)) }
    try { text = await res.text() } catch {}
    if (!res.ok) { b.state = 'ended'; return b.items.forEach((it) => finish(it, jsonResp(res.status, text), false)) }
    const j = parseJson(text)
    if (!j?.id || !j.processing_status) { b.state = 'ended'; return b.items.forEach((it) => finish(it, new Error('batch-create-invalid'), true)) }
    b.id = j.id; b.created = now()
    // The bodies have been sent; they are not kept in memory for the day the batch may take.
    for (const it of b.items) { it.params = null; try { it.onSent?.({ batchId: b.id, customId: it.customId }) } catch {} }
    emit({ type: 'submitted', batchId: b.id, requests: b.items.length })
    if (b.state === 'canceled' || b.items.every((it) => it.aborted)) { b.state = 'canceled'; return cancelRemote(b) }
    await track(b)
  }
  async function track(b) {
    let fails = 0
    while (b.state === 'in_progress' && !closed) {
      await sleep(L.pollMs)
      if (b.state !== 'in_progress' || closed) return
      // Expired here: the remote batch is cancelled too, so it stops running (and billing) for nobody.
      if (now() - b.created >= L.expireMs) { cancelRemote(b).catch(() => {}); b.state = 'ended'; return b.items.forEach((it) => finish(it, toResponse(null), false)) }
      let j
      try {
        const r = await fetchImpl(`${baseUrl}/v1/messages/batches/${encodeURIComponent(b.id)}`, { headers: hdr() })
        if (!r.ok) throw new Error(`poll-${r.status}`)
        j = await r.json(); fails = 0
      } catch (e) {
        if (++fails >= 6) { b.state = 'ended'; return b.items.forEach((it) => finish(it, e, true)) }
        continue
      }
      emit({ type: 'polled', batchId: b.id, processing_status: j.processing_status, counts: j.request_counts })
      if (j.processing_status === 'ended') return readResults(b, j)
    }
  }
  async function readResults(b, j) {
    let text
    try {
      // The key goes only to the API's own host, whatever URL the answer names.
      let sameHost = false
      try { sameHost = new URL(j.results_url).origin === new URL(baseUrl).origin } catch {}
      if (!sameHost) throw new Error('batch-results-url-invalid')
      const r = await fetchImpl(j.results_url, { headers: hdr() })
      if (!r.ok) throw new Error(`results-${r.status}`)
      text = await r.text()
    } catch (e) { b.state = 'ended'; return b.items.forEach((it) => finish(it, e, true)) }
    const seen = new Map()
    for (const line of text.split('\n')) { const o = parseJson(line.trim()); if (o && typeof o.custom_id === 'string') seen.set(o.custom_id, o.result) }
    b.state = 'ended'
    emit({ type: 'ended', batchId: b.id })
    for (const it of b.items) finish(it, toResponse(seen.get(it.customId)), false)
  }
  async function cancelAll() {
    const list = [...batches].filter((b) => b.state === 'in_progress')
    stopTimer()
    const p = pending; pending = []; pendingBytes = 0
    p.forEach((it) => finish(it, abortErr(), true))
    await Promise.all(list.map(async (b) => { if (b.id) await cancelRemote(b); else b.state = 'canceled'; b.items.forEach((it) => finish(it, abortErr(), true)) }))
  }
  function close() {
    closed = true
    stopTimer()
    const p = pending; pending = []; pendingBytes = 0
    p.forEach((it) => finish(it, new Error('batch-closed'), true))
  }
  function status() {
    return { pending: pending.length, batches: [...batches].filter((b) => b.id).map((b) => ({ id: b.id, requests: b.items.length, state: b.state })) }
  }
  return { submit, cancelAll, close, status }
}
export function defaultBatchTypes(config = {}) {
  const batch = config?.batch ?? {};
  if (batch.reviews === false) return [];
  if (batch.reviews === true || batch.reviews === undefined) return ['review'];
  return [];
}

export function batchPolicyFor(manifest, flag, env = process.env, root) {
  let machineBatch = {};
  try { machineBatch = loadLocalConfig({ env }).batch ?? {}; } catch { machineBatch = {}; }
  const listed = typeof root === 'string' && Array.isArray(machineBatch.projects) && machineBatch.projects.some(item => typeof item === 'string' && path.resolve(item) === path.resolve(root));
  const config = listed ? machineBatch : {};
  const own = manifest?.batch;
  let types = Array.isArray(own?.types) ? own.types : own === undefined && config.enabled === true && Array.isArray(config.types) && config.types.length ? config.types : [];
  if (listed && !types.length && own === undefined && (config.reviews === true || config.reviews === undefined)) types = ['review'];
  const all = flag === true || own === true || (own === undefined && config.enabled === true && !(Array.isArray(config.types) && config.types.length));
  return { all, types };
}

export function batchEligible(job, { all = false, types = [] } = {}) {
  try {
    if (!job || typeof job !== 'object') return false
    if (job.urgent === true) return false
    if (job.agent !== 'anthropic' || job.type === 'lead' || job.batch === false || job.privateData) return false
    if (job.batch === true || all === true) return true
    return job.type !== undefined && Array.isArray(types) && types.includes(job.type)
  } catch { return false }
}
const round8 = (n) => Math.round(n * 1e8) / 1e8
export function batchCostUsd(standardUsd) {
  return standardUsd == null ? null : round8(standardUsd * BATCH_DISCOUNT)
}
export function estimateBatchSavings(standardUsd, { fraction = BATCH_DISCOUNT } = {}) {
  if (standardUsd == null) return { standardUsd: null, batchUsd: null, savedUsd: null }
  const batchUsd = round8(standardUsd * fraction)
  return { standardUsd, batchUsd, savedUsd: round8(standardUsd - batchUsd) }
}
