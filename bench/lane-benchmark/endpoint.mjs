// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Parse OpenAI-style JSON completion into a path -> content map. */
export function parseFilesEnvelope(text) {
  if (!text || typeof text !== 'string') throw new Error('empty completion');
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) throw new Error('no JSON object in completion');
  const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
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

export function buildChatPrompt(task, contextFiles) {
  const ctx = contextFiles.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n');
  return `${task.prompt}\n\nReturn a single JSON object: { "files": { "<path>": "<full file contents>", ... } } with exactly these output paths: ${task.outputs.join(', ')}.\n\nContext files at base:\n${ctx}`;
}

export async function chatCompletion({ baseUrl, model, apiKey, prompt, temperature = 0.2, maxTokens = 8000, fetchImpl = globalThis.fetch }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model,
    temperature,
    stream: false,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  const usage = data.usage ?? {};
  return {
    content,
    finishReason: choice?.finish_reason ?? null,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
  };
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

export function runEndpointTask(task, { srcRepo, verifyOutputs, readContextAtBase, api, log = () => {} }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-endpoint-'));
  const started = Date.now();
  extractBaseTree(srcRepo, task.baseCommit, work);
  const contextFiles = task.context.map(file => ({
    path: file,
    content: readContextAtBase(task.baseCommit, file),
  }));
  const prompt = buildChatPrompt(task, contextFiles);
  return api(prompt).then(reply => {
    const outputs = parseFilesEnvelope(reply.content);
    const verified = verifyOutputs(work, task, outputs);
    const wallSec = (Date.now() - started) / 1000;
    const completionTokens = reply.completionTokens ?? 0;
    return {
      taskId: task.id,
      type: task.type,
      pass: verified.pass,
      detail: verified.detail,
      wallSec,
      promptTokens: reply.promptTokens,
      completionTokens,
      completionTokensPerSec: completionTokens && wallSec > 0 ? completionTokens / wallSec : null,
      finishReason: reply.finishReason,
    };
  }).catch(err => ({
    taskId: task.id,
    type: task.type,
    pass: false,
    detail: String(err.message ?? err).slice(0, 300),
    wallSec: (Date.now() - started) / 1000,
    promptTokens: null,
    completionTokens: null,
    completionTokensPerSec: null,
    finishReason: null,
  })).finally(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });
}

export async function runEndpointLane({ tasks, slots, srcRepo, verifyOutputs, readContextAtBase, api, log = () => {} }) {
  const queue = [...tasks];
  const results = [];
  const workers = Array.from({ length: Math.max(1, slots) }, async () => {
    while (queue.length) {
      const task = queue.shift();
      if (!task) break;
      log(`endpoint ${task.id}`);
      const result = await runEndpointTask(task, { srcRepo, verifyOutputs, readContextAtBase, api, log });
      results.push(result);
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.taskId.localeCompare(b.taskId));
  return { lane: 'endpoint', set: 'replay', slots, results };
}
