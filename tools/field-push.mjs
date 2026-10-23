// SPDX-License-Identifier: Apache-2.0
import { scanSecretsDetailed } from './security-scan.mjs';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const HOME = /\/(?:Users|home)\/[^/\s"]+\//;
const PHONE = /(?<!\d)(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?!\d)/;
const LESSON_KEYS = ['id', 'area', 'status', 'version', 'createdAt', 'ruleLength', 'tags'];
const RUN_KEYS = ['lane', 'jobs', 'pass', 'fail', 'medianMinutes'];

function pick(source, keys) {
  const out = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const key of keys) {
    if (Object.hasOwn(source, key)) out[key] = source[key];
  }
  return out;
}

// Only allow-listed metadata fields survive; anything else in the export is dropped before scanning.
export function toMetadataBundle(data) {
  const src = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return {
    projectId: src.projectId,
    exportedAt: src.exportedAt,
    lessons: Array.isArray(src.lessons) ? src.lessons.map(lesson => pick(lesson, LESSON_KEYS)) : [],
    runs: Array.isArray(src.runs) ? src.runs.map(run => pick(run, RUN_KEYS)) : [],
  };
}

function piiKinds(text) {
  const kinds = [];
  if (EMAIL.test(text)) kinds.push('email');
  if (PHONE.test(text)) kinds.push('phone');
  if (IPV4.test(text)) kinds.push('ipv4');
  if (HOME.test(text)) kinds.push('home-path');
  return kinds;
}

// Returns the sorted list of problems found; an empty list means the text passed both secret and PII scanning.
async function scanBundle(text, scan) {
  const found = new Set(piiKinds(text));
  const result = await scan([{ path: 'field-bundle.json', content: text }]);
  const findings = Array.isArray(result) ? result : result?.findings;
  if (!Array.isArray(result) && Array.isArray(result?.skipped) && result.skipped.length > 0) found.add('scan-skipped');
  if (!Array.isArray(findings)) found.add('scan-unreadable');
  if (Array.isArray(findings) && findings.length > 0) found.add('secret');
  return [...found].sort();
}

// Sends one metadata bundle, and only after it has passed secret and PII scanning.
// send receives { bundle, text, bytes } and its return value is passed back in receipt.
export async function pushFieldBundle(data, { send, scan = scanSecretsDetailed } = {}) {
  if (typeof send !== 'function') throw new TypeError('field push requires a send function');
  if (typeof scan !== 'function') throw new TypeError('field push scan must be a function');
  const bundle = toMetadataBundle(data);
  const text = JSON.stringify(bundle);
  const findings = await scanBundle(text, scan);
  if (findings.length > 0) {
    const error = new Error(`field-push-refused: ${findings.join(', ')}`);
    error.code = 'field-push-refused';
    error.findings = findings;
    throw error;
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  const receipt = await send({ bundle, text, bytes });
  return { sent: true, bytes, receipt };
}
