// SPDX-License-Identifier: Apache-2.0
import { sanitizeText } from './journal.mjs';

export const BRAIN_LIMITS = { maxOutputChars: 8000, maxQueued: 200 };
const KINDS = new Set(['think', 'digest', 'triage', 'draft', 'polish', 'preflight', 'status']);
const MAX_CONTENT = 60000;
const MAX_SAVED = 2000000;

export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nonNeg(value, max = Infinity) {
  return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0;
}

function cleanText(text, max) {
  const chars = [...String(text ?? '')].slice(0, max);
  let out = '';
  for (let i = 0; i < chars.length; i += 2000) out += sanitizeText(chars.slice(i, i + 2000).join(''));
  return [...out].slice(0, max).join('');
}

function usageOf(usage, messages, text) {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return {
    inTokens: nonNeg(usage?.inTokens ?? Math.ceil(chars / 4)),
    outTokens: nonNeg(usage?.outTokens ?? estimateTokens(text ?? '')),
  };
}

function buildMessages(req) {
  const messages = [];
  if (req.system) messages.push({ role: 'system', content: String(req.system) });
  messages.push({ role: 'user', content: String(req.user ?? '') });
  if (messages.some(m => m.content.length > MAX_CONTENT)) throw fail('brain-request-invalid');
  return messages;
}

export function summarizeBrainLedger(events) {
  const out = { calls: 0, local: 0, haiku: 0, failed: 0, inTokens: 0, outTokens: 0, savedTokens: 0, paidUsd: 0, byKind: {} };
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object' || !KINDS.has(e.kind)) continue;
    // A saved-only event adds the tokens a finished task kept from the orchestrator; it is not another call.
    if (e.savedOnly === true) {
      const saved = nonNeg(e.savedTokens, MAX_SAVED);
      (out.byKind[e.kind] ??= { calls: 0, savedTokens: 0 }).savedTokens += saved;
      out.savedTokens += saved;
      continue;
    }
    out.calls++;
    const kind = out.byKind[e.kind] ??= { calls: 0, savedTokens: 0 };
    kind.calls++;
    const saved = nonNeg(e.savedTokens, MAX_SAVED);
    kind.savedTokens += saved;
    out.savedTokens += saved;
    if (e.ok === false) { out.failed++; continue; }
    if (e.via === 'local') out.local++;
    else if (e.via === 'haiku') out.haiku++;
    out.inTokens += nonNeg(e.inTokens);
    out.outTokens += nonNeg(e.outTokens);
    out.paidUsd += Number.isFinite(e.paidUsd) && e.paidUsd > 0 ? e.paidUsd : 0;
  }
  return out;
}

export function createBrain({ getLink, fallback = null, concurrency = 1, timeoutMs = 240000, ledger = null, now = Date.now } = {}) {
  const width = Math.min(2, Math.max(1, nonNeg(concurrency) || 1));
  const queue = [];
  let running = 0;
  let closed = false;
  let lastLink = null;

  async function writeLedger(event) {
    if (!ledger) return;
    try { await ledger(event); } catch { /* ignored by design */ }
  }

  async function attempt(req, messages, signal) {
    let link = null;
    try { link = await getLink(); } catch { link = null; }
    if (link) {
      lastLink = link;
      try {
        const r = await link.chat(messages, { maxTokens: req.maxTokens, signal, temperature: req.temperature });
        return { text: r?.text, via: 'local', usage: usageOf(r?.usage, messages, r?.text), paidUsd: 0 };
      } catch (error) {
        if (error?.code !== 'brain-unavailable') throw error;
      }
    }
    if (req.sensitive || !fallback) throw fail('brain-unavailable', 'local brain unavailable');
    const r = await fallback(messages, { maxTokens: req.maxTokens });
    const paidUsd = Number.isFinite(r?.paidUsd) && r.paidUsd > 0 ? r.paidUsd : 0;
    return { text: r?.text, via: 'haiku', usage: usageOf(r?.usage, messages, r?.text), paidUsd };
  }

  async function runItem({ req, messages }) {
    const started = now();
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(fail('brain-unavailable', 'brain-unavailable: timeout'));
      }, timeoutMs);
    });
    try {
      const got = await Promise.race([attempt(req, messages, controller.signal), timeout]);
      const ms = now() - started;
      const result = { text: cleanText(got.text, BRAIN_LIMITS.maxOutputChars), via: got.via, usage: got.usage, paidUsd: got.paidUsd, ms };
      await writeLedger({ kind: req.kind, via: got.via, inTokens: got.usage.inTokens, outTokens: got.usage.outTokens, savedTokens: nonNeg(req.savedTokens, MAX_SAVED), paidUsd: got.paidUsd, ms, ok: true });
      return result;
    } catch (error) {
      await writeLedger({ kind: req.kind, via: null, ok: false, error: String(error?.code ?? 'brain-error') });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function pump() {
    while (!closed && running < width && queue.length) {
      const item = queue.shift();
      running++;
      runItem(item).then(item.resolve, item.reject).finally(() => { running--; pump(); });
    }
  }

  async function ask(request = {}) {
    if (closed) throw fail('brain-closed');
    const req = request ?? {};
    if (!KINDS.has(req.kind)) throw fail('brain-request-invalid', 'brain-request-invalid: kind');
    const messages = buildMessages(req);
    const normalized = {
      kind: req.kind,
      sensitive: req.sensitive === true,
      maxTokens: Number.isFinite(req.maxTokens) && req.maxTokens > 0 ? Math.floor(req.maxTokens) : 600,
      temperature: Number.isFinite(req.temperature) ? req.temperature : 0.2,
      savedTokens: req.savedTokens,
    };
    if (queue.length >= BRAIN_LIMITS.maxQueued) throw fail('brain-busy');
    return new Promise((resolve, reject) => {
      queue.push({ req: normalized, messages, resolve, reject });
      pump();
    });
  }

  function status() {
    return { concurrency: width, queued: queue.length, running, linkUp: lastLink?.status?.().up === true };
  }

  function close() {
    closed = true;
    for (const item of queue.splice(0)) item.reject(fail('brain-closed'));
    const link = lastLink;
    lastLink = null;
    try { link?.close?.(); } catch { /* ignored by design */ }
  }

  return { ask, status, close };
}
