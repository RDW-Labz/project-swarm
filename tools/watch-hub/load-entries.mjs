// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY_KEYS = new Set(['id', 'title', 'at', 'body', 'notes', 'tags', 'status']);
const STATUSES = new Set(['active', 'archived', 'draft']);

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isIsoDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  return /\d{4}-\d{2}-\d{2}T/.test(value);
}

export function validateWatchHubEntry(entry) {
  const errors = [];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { ok: false, errors: ['entry must be an object'] };
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) errors.push(`unknown key: ${key}`);
  }
  for (const key of ['id', 'title', 'at']) {
    if (typeof entry[key] !== 'string' || !entry[key].trim()) {
      errors.push(`${key} is required`);
    }
  }
  if (typeof entry.id === 'string' && entry.id.trim() && entry.id.trim() !== entry.id) {
    errors.push('id must not be only whitespace');
  }
  if (typeof entry.title === 'string' && entry.title.trim() && entry.title.trim() !== entry.title) {
    errors.push('title must not be only whitespace');
  }
  if (typeof entry.at === 'string' && entry.at.trim() && !isIsoDateTime(entry.at)) {
    errors.push('at must be an ISO-8601 date-time string');
  }
  if (entry.body !== undefined && typeof entry.body !== 'string') {
    errors.push('body must be a string');
  }
  if (entry.notes !== undefined && typeof entry.notes !== 'string') {
    errors.push('notes must be a string');
  }
  if (entry.tags !== undefined) {
    if (!Array.isArray(entry.tags)) {
      errors.push('tags must be an array');
    } else {
      for (const tag of entry.tags) {
        if (typeof tag !== 'string') errors.push('tags items must be strings');
      }
    }
  }
  if (entry.status !== undefined && (typeof entry.status !== 'string' || !STATUSES.has(entry.status))) {
    errors.push('status must be one of active, archived, draft');
  }
  return { ok: errors.length === 0, errors };
}

function parseFrontMatterLine(key, raw) {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return parsed;
    } catch {
      return value;
    }
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFrontMatter(text) {
  if (!text.startsWith('---')) return { attrs: {}, body: text };
  const nl = text.indexOf('\n');
  if (nl === -1) return { attrs: {}, body: text };
  const end = text.indexOf('\n---\n', nl + 1);
  if (end === -1) return { attrs: {}, body: text };
  const block = text.slice(nl + 1, end);
  const body = text.slice(end + 5);
  const attrs = {};
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = parseFrontMatterLine(key, trimmed.slice(colon + 1));
    attrs[key] = value;
  }
  return { attrs, body };
}

function markdownFromBody(body, fallbackId) {
  const trimmed = body.replace(/^\uFEFF/, '').trimStart();
  const match = trimmed.match(/^#\s+(.+?)(?:\r?\n|$)([\s\S]*)/);
  if (!match) {
    return {
      id: fallbackId,
      title: fallbackId,
      body: trimmed,
    };
  }
  const title = match[1].trim();
  const rest = (match[2] || '').trim();
  return {
    id: fallbackId,
    title: title || fallbackId,
    body: rest,
  };
}

function normalizeTags(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed.map(String) : [trimmed];
      } catch {
        return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}

function entryFromMarkdown(text, filePath, mtimeMs) {
  const base = path.basename(filePath, path.extname(filePath));
  const { attrs, body } = parseFrontMatter(text);
  const fromHeading = markdownFromBody(body, base);
  const at =
    typeof attrs.at === 'string' && attrs.at.trim()
      ? attrs.at.trim()
      : new Date(mtimeMs).toISOString();
  const entry = {
    id: typeof attrs.id === 'string' && attrs.id.trim() ? attrs.id.trim() : fromHeading.id,
    title:
      typeof attrs.title === 'string' && attrs.title.trim() ? attrs.title.trim() : fromHeading.title,
    at,
  };
  const bodyText =
    typeof attrs.body === 'string'
      ? attrs.body
      : fromHeading.body;
  if (bodyText) entry.body = bodyText;
  if (typeof attrs.notes === 'string' && attrs.notes.trim()) entry.notes = attrs.notes.trim();
  const tags = normalizeTags(attrs.tags);
  if (tags && tags.length) entry.tags = tags;
  if (typeof attrs.status === 'string' && attrs.status.trim()) entry.status = attrs.status.trim();
  return entry;
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    const ta = Date.parse(a.at);
    const tb = Date.parse(b.at);
    if (tb !== ta) return tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export async function loadWatchHubEntries(dir) {
  const entries = [];
  const errors = [];
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { entries: [], errors: [{ file: dir, message: 'entries directory does not exist' }] };
    }
    throw error;
  }
  for (const name of names.sort(byName)) {
    const ext = path.extname(name).toLowerCase();
    if (ext !== '.json' && ext !== '.md') continue;
    const file = path.join(dir, name);
    const rel = name;
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (error) {
      errors.push({ file: rel, message: error.message });
      continue;
    }
    if (!stat.isFile()) continue;
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      errors.push({ file: rel, message: error.message });
      continue;
    }
    let candidate;
    if (ext === '.json') {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        errors.push({ file: rel, message: 'not valid JSON' });
        continue;
      }
      candidate = parsed;
    } else {
      try {
        candidate = entryFromMarkdown(text, file, stat.mtimeMs);
      } catch (error) {
        errors.push({ file: rel, message: error.message || 'failed to parse Markdown entry' });
        continue;
      }
    }
    const check = validateWatchHubEntry(candidate);
    if (!check.ok) {
      errors.push({ file: rel, message: check.errors.join('; ') });
      continue;
    }
    entries.push(candidate);
  }
  return { entries: sortEntries(entries), errors };
}

export const watchHubEntrySchemaPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'entry-schema.json',
);
