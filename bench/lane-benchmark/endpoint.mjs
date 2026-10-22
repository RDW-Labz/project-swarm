// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CHARS_PER_TOKEN = 3.5;
const EXCERPT_HEAD_LINES = 150;
const EXCERPT_TAIL_LINES = 150;
const LARGE_FILE_BUDGET_FRACTION = 0.2;

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

function isTestOrFixturePath(filePath) {
  const p = filePath.replace(/\\/g, '/');
  if (p.includes('/fixtures/') || p.startsWith('fixtures/')) return true;
  if (p.startsWith('tests/') || p.includes('/tests/')) return true;
  if (p.endsWith('.test.mjs') || p.endsWith('.test.js')) return true;
  return false;
}

function contextSortKey(filePath) {
  const testLast = isTestOrFixturePath(filePath) ? 1 : 0;
  return `${testLast}\0${filePath}`;
}

function excerptLargeFile(content, pathLabel, maxFileTokens) {
  const lines = content.split('\n');
  if (lines.length > EXCERPT_HEAD_LINES + EXCERPT_TAIL_LINES) {
    const head = lines.slice(0, EXCERPT_HEAD_LINES).join('\n');
    const tail = lines.slice(-EXCERPT_TAIL_LINES).join('\n');
    const omitted = lines.length - EXCERPT_HEAD_LINES - EXCERPT_TAIL_LINES;
    const marker = `--- [excerpt: ${pathLabel}: ${omitted} lines omitted] ---`;
    return {
      content: `${head}\n${marker}\n${tail}`,
      excerpted: true,
      omittedLines: omitted,
    };
  }
  const maxChars = Math.max(200, Math.floor(maxFileTokens * CHARS_PER_TOKEN));
  if (content.length <= maxChars) return { content, excerpted: false };
  const headChars = Math.floor(maxChars / 2);
  const tailChars = maxChars - headChars;
  const omittedChars = content.length - headChars - tailChars;
  const marker = `--- [excerpt: ${pathLabel}: ${omittedChars} characters omitted] ---`;
  return {
    content: `${content.slice(0, headChars)}\n${marker}\n${content.slice(-tailChars)}`,
    excerpted: true,
    omittedLines: omittedChars,
  };
}

/**
 * Build prompt context under a token budget. Owned output paths are always included in full.
 * @returns {{ prompt: string, excluded: string[], excerpted: { path: string, omittedLines: number }[] }}
 */
export function buildPromptWithBudget(task, allContextFiles, { promptTokenBudget = 24000 } = {}) {
  const owned = new Set(task.outputs ?? []);
  const byPath = new Map(allContextFiles.map(f => [f.path, f.content ?? '']));

  const fixedParts = [
    task.prompt,
    `\nReturn a single JSON object: { "files": { "<path>": "<full file contents>", ... } } with exactly these output paths: ${task.outputs.join(', ')}.`,
    '\nContext files at base:\n',
  ];
  let used = fixedParts.reduce((sum, p) => sum + estimateTokens(p), 0);

  const included = [];
  const excerpted = [];
  const excluded = [];

  for (const outPath of task.outputs) {
    const content = byPath.get(outPath) ?? '';
    const block = `--- ${outPath} ---\n${content}`;
    used += estimateTokens(block) + estimateTokens('\n\n');
    included.push({ path: outPath, content, excerpted: false });
  }

  const contextOnly = [...allContextFiles]
    .filter(f => !owned.has(f.path))
    .sort((a, b) => {
      const sizeA = (a.content ?? '').length;
      const sizeB = (b.content ?? '').length;
      if (sizeA !== sizeB) return sizeA - sizeB;
      return contextSortKey(a.path).localeCompare(contextSortKey(b.path));
    });

  const maxFileTokens = Math.floor(promptTokenBudget * LARGE_FILE_BUDGET_FRACTION);

  for (const file of contextOnly) {
    let content = file.content ?? '';
    let fileExcerpted = false;
    let omittedLines = 0;
    const rawTokens = estimateTokens(content);
    if (rawTokens > maxFileTokens && maxFileTokens > 0) {
      const ex = excerptLargeFile(content, file.path, maxFileTokens);
      content = ex.content;
      fileExcerpted = ex.excerpted;
      omittedLines = ex.omittedLines ?? 0;
    }
    const block = `--- ${file.path} ---\n${content}`;
    const blockTokens = estimateTokens(block) + estimateTokens('\n\n');
    if (used + blockTokens > promptTokenBudget) {
      excluded.push(file.path);
      continue;
    }
    used += blockTokens;
    included.push({ path: file.path, content, excerpted: fileExcerpted });
    if (fileExcerpted) excerpted.push({ path: file.path, omittedLines });
  }

  const ctx = included.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n');
  const prompt = `${fixedParts[0]}${fixedParts[1]}${fixedParts[2]}${ctx}`;
  return { prompt, excluded, excerpted };
}

/** @deprecated use buildPromptWithBudget */
export function buildChatPrompt(task, contextFiles) {
  return buildPromptWithBudget(task, contextFiles, { promptTokenBudget: Number.MAX_SAFE_INTEGER }).prompt;
}

function extractJsonObjectText(text) {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```/m.exec(trimmed);
  const body = fence ? fence[1].trim() : trimmed;
  const jsonStart = body.indexOf('{');
  const jsonEnd = body.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) throw new Error('no JSON object in completion');
  return body.slice(jsonStart, jsonEnd + 1);
}

/** Parse OpenAI-style JSON completion into a path -> content map. Ignores reasoning; accepts fences and leading prose. */
export function parseFilesEnvelope(text) {
  if (!text || typeof text !== 'string') throw new Error('empty completion');
  const parsed = JSON.parse(extractJsonObjectText(text));
  if (parsed.files && !Array.isArray(parsed.files) && typeof parsed.files === 'object') {
    return Object.fromEntries(Object.entries(parsed.files).map(([k, v]) => [k, String(v)]));
  }
  if (Array.isArray(parsed.files)) {
    return Object.fromEntries(parsed.files.map(item => {
      if (!item?.path) throw new Error('files entry missing path');
      return [item.path, String(item.content ?? '')];
    }));
  }
  throw new Error('completion JSON missing files');
}

export async function chatCompletion({
  baseUrl,
  model,
  apiKey,
  prompt,
  temperature = 0.2,
  maxTokens = 16000,
  thinking = 'auto',
  fetchImpl = globalThis.fetch,
}) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const messages = [];
  if (thinking === 'off') {
    messages.push({
      role: 'system',
      content: 'Respond directly without step-by-step reasoning or chain-of-thought. Put the full answer in the message content field only.',
    });
  }
  messages.push({ role: 'user', content: prompt });
  const body = {
    model,
    temperature,
    stream: false,
    max_tokens: maxTokens,
    messages,
  };
  if (thinking === 'off') {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = 'request_refused';
    throw err;
  }
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  const reasoningContent = choice?.message?.reasoning_content ?? '';
  const usage = data.usage ?? {};
  const promptChars = prompt.length;
  const completionChars = content.length;
  const reasoningChars = typeof reasoningContent === 'string' ? reasoningContent.length : 0;
  return {
    content,
    reasoningContent,
    finishReason: choice?.finish_reason ?? 'unknown',
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    usage,
    promptChars,
    completionChars,
    reasoningChars,
    completionTokensPerSec: null,
    completionTokensPerSecEstimated: false,
  };
}

function enrichCatchReason(err) {
  const msg = String(err.message ?? err);
  if (err.code === 'request_refused' || /context|token|length|refus/i.test(msg)) {
    return `request refused: ${msg.slice(0, 200)}`;
  }
  if (msg.includes('empty completion') || msg.includes('no JSON')) return 'no envelope';
  return msg.slice(0, 300);
}

function extractBaseTree(srcRepo, baseCommit, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tar = path.join(os.tmpdir(), `bench-replay-${process.pid}.tar`);
  const archive = spawnSync('git', ['-C', srcRepo, 'archive', '--format=tar', '-o', tar, baseCommit, '--', '.', ':(exclude)bench'], { encoding: 'utf8' });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr?.slice(0, 200)}`);
  spawnSync('tar', ['-xf', tar, '-C', dest]);
  fs.rmSync(tar, { force: true });
}

export function runEndpointTask(task, {
  srcRepo,
  verifyOutputs,
  readContextAtBase,
  api,
  promptTokenBudget = 24000,
  log = () => {},
}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-endpoint-'));
  const started = Date.now();
  extractBaseTree(srcRepo, task.baseCommit, work);
  const contextPaths = [...new Set([...(task.context ?? []), ...(task.outputs ?? [])])];
  const contextFiles = contextPaths.map(file => ({
    path: file,
    content: readContextAtBase(task.baseCommit, file) ?? '',
  }));
  const { prompt, excluded, excerpted } = buildPromptWithBudget(task, contextFiles, { promptTokenBudget });
  const promptChars = prompt.length;

  return api(prompt).then(reply => {
    const wallSec = (Date.now() - started) / 1000;
    let outputs;
    let verified = { pass: false, detail: 'no envelope' };
    let reason;
    if (!reply.content?.trim()) {
      reason = `empty content (finish=${reply.finishReason ?? 'unknown'}, reasoning ${reply.reasoningChars ?? 0} chars)`;
    } else {
      try {
        outputs = parseFilesEnvelope(reply.content);
        verified = verifyOutputs(work, task, outputs);
        reason = verified.pass ? 'passed' : 'tests failed';
      } catch (e) {
        reason = 'no envelope';
        verified = { pass: false, detail: String(e.message ?? e).slice(0, 200) };
      }
    }
    const completionTokens = reply.completionTokens;
    let completionTokensPerSec = reply.completionTokensPerSec;
    let completionTokensPerSecEstimated = reply.completionTokensPerSecEstimated ?? false;
    if (!Number.isFinite(completionTokensPerSec) && reply.completionChars > 0 && wallSec > 0) {
      const est = Math.ceil(reply.completionChars / CHARS_PER_TOKEN);
      completionTokensPerSec = est / wallSec;
      completionTokensPerSecEstimated = true;
    } else if (Number.isFinite(completionTokens) && wallSec > 0 && !Number.isFinite(completionTokensPerSec)) {
      completionTokensPerSec = completionTokens / wallSec;
      completionTokensPerSecEstimated = false;
    }
    return {
      taskId: task.id,
      type: task.type,
      pass: verified.pass,
      detail: verified.detail,
      reason,
      wallSec,
      finishReason: reply.finishReason ?? 'unknown',
      promptChars: reply.promptChars ?? promptChars,
      completionChars: reply.completionChars ?? (reply.content?.length ?? 0),
      reasoningChars: reply.reasoningChars ?? 0,
      promptTokens: reply.promptTokens,
      completionTokens: reply.completionTokens ?? null,
      totalTokens: reply.totalTokens ?? null,
      usage: reply.usage ?? null,
      completionTokensPerSec,
      completionTokensPerSecEstimated,
      promptExcluded: excluded,
      promptExcerpted: excerpted,
    };
  }).catch(err => {
    const wallSec = (Date.now() - started) / 1000;
    const reason = enrichCatchReason(err);
    return {
      taskId: task.id,
      type: task.type,
      pass: false,
      detail: reason,
      reason,
      wallSec,
      finishReason: 'error',
      promptChars,
      completionChars: 0,
      reasoningChars: 0,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usage: null,
      completionTokensPerSec: null,
      completionTokensPerSecEstimated: false,
      promptExcluded: excluded,
      promptExcerpted: excerpted,
    };
  }).finally(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });
}

export async function runEndpointLane({
  tasks,
  slots,
  srcRepo,
  verifyOutputs,
  readContextAtBase,
  api,
  promptTokenBudget = 24000,
  log = () => {},
}) {
  const queue = [...tasks];
  const results = [];
  const workers = Array.from({ length: Math.max(1, slots) }, async () => {
    while (queue.length) {
      const task = queue.shift();
      if (!task) break;
      log(`endpoint ${task.id}`);
      const result = await runEndpointTask(task, {
        srcRepo,
        verifyOutputs,
        readContextAtBase,
        api,
        promptTokenBudget,
        log,
      });
      results.push(result);
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.taskId.localeCompare(b.taskId));
  return { lane: 'endpoint', set: 'replay', slots, results };
}
