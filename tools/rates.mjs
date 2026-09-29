// SPDX-License-Identifier: Apache-2.0
// Field lesson #252: a job that dies before the CLI ever emits its own `result` event (killed,
// timed out, or ended on a transient provider error) still spent real tokens — its own
// provider.jsonl transcript is the only record of that spend, read here at a fixed per-model
// USD/MTok rate instead of `inspect` reporting `costNotReported` for real, non-zero spend.
export const MODEL_RATES = Object.freeze({
  sonnet: Object.freeze({ in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 }),
  opus: Object.freeze({ in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 }),
  haiku: Object.freeze({ in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 }),
});

// Output tokens, when a stream's own output count is partial (fewer than the content it is
// actually reporting could hold), are estimated from that content's character count.
const OUTPUT_CHARS_TO_TOKENS = 1.72;

function modelFamily(model) {
  const text = (model ?? '').toLowerCase();
  if (text.includes('opus')) return 'opus';
  if (text.includes('haiku')) return 'haiku';
  if (text.includes('sonnet')) return 'sonnet';
  return null;
}

function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) return content.reduce((sum, block) => sum + (typeof block?.text === 'string' ? block.text.length : 0), 0);
  return 0;
}

// Sums usage over unique assistant message ids (a resumed/retried stream can repeat one message
// id; each field is taken as the max seen for that id, never summed twice for the same id).
export function estimateCostFromTranscript(jsonlText, model) {
  const perMessage = new Map();
  for (const line of (jsonlText ?? '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'assistant') continue;
    const id = event.message?.id ?? `line-${perMessage.size}`;
    const usage = event.message?.usage ?? {};
    const chars = contentChars(event.message?.content);
    const existing = perMessage.get(id) ?? { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, chars: 0 };
    perMessage.set(id, {
      input_tokens: Math.max(existing.input_tokens, usage.input_tokens ?? 0),
      output_tokens: Math.max(existing.output_tokens, usage.output_tokens ?? 0),
      cache_creation_input_tokens: Math.max(existing.cache_creation_input_tokens, usage.cache_creation_input_tokens ?? 0),
      cache_read_input_tokens: Math.max(existing.cache_read_input_tokens, usage.cache_read_input_tokens ?? 0),
      chars: Math.max(existing.chars, chars),
    });
  }
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let outputEstimated = false;
  for (const entry of perMessage.values()) {
    usage.input_tokens += entry.input_tokens;
    usage.cache_creation_input_tokens += entry.cache_creation_input_tokens;
    usage.cache_read_input_tokens += entry.cache_read_input_tokens;
    // A partial stream output count under what its own content could hold is replaced by the
    // content-size estimate; a genuinely short reply keeps its own (also small) reported count.
    const fromChars = Math.round(entry.chars * OUTPUT_CHARS_TO_TOKENS);
    if (fromChars > entry.output_tokens) { usage.output_tokens += fromChars; outputEstimated = true; }
    else usage.output_tokens += entry.output_tokens;
  }
  usage.total_tokens = usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  if (!perMessage.size) return { costUsd: null, usage: null, outputEstimated: false };
  const family = modelFamily(model);
  const rate = family ? MODEL_RATES[family] : null;
  if (!rate) return { costUsd: null, usage, outputEstimated };
  const costUsd = (usage.input_tokens / 1e6) * rate.in
    + (usage.output_tokens / 1e6) * rate.out
    + (usage.cache_creation_input_tokens / 1e6) * rate.cacheWrite
    + (usage.cache_read_input_tokens / 1e6) * rate.cacheRead;
  return { costUsd, usage, outputEstimated };
}
