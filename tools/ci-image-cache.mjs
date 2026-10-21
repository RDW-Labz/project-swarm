// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

const UNCHANGED_REGISTRIES = new Set(['ghcr.io', 'quay.io', 'gcr.io']);

function stripQuotes(value) {
  const t = value.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function splitImageRef(image) {
  let ref = image.trim();
  let digest = '';
  const at = ref.indexOf('@');
  if (at !== -1) {
    digest = ref.slice(at);
    ref = ref.slice(0, at);
  }
  let tag = '';
  const colon = ref.lastIndexOf(':');
  const slash = ref.lastIndexOf('/');
  if (colon > slash) {
    tag = ref.slice(colon);
    ref = ref.slice(0, colon);
  }
  return { ref, tag, digest };
}

function looksLikeRegistry(host) {
  return host.includes('.') || host.includes(':') || host === 'localhost';
}

function dockerHubRepositoryPath(ref) {
  const parts = ref.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0];
  const hasRegistry = parts.length >= 2 && looksLikeRegistry(first);
  if (!hasRegistry) {
    return parts.length === 1 ? `library/${parts[0]}` : parts.join('/');
  }
  if (first !== 'docker.io') return null;
  const rest = parts.slice(1);
  if (rest.length === 0) return null;
  if (rest.length === 1 && !rest[0].includes('/')) return `library/${rest[0]}`;
  return rest.join('/');
}

/**
 * Parse `image:` lines from docker-compose YAML, or a plain newline-separated image list.
 * @param {string} text
 * @returns {string[]}
 */
export function imagesFromCompose(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const fromCompose = [];
  const re = /^\s*image:\s*(.+)\s*$/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    const raw = stripQuotes(match[1]);
    if (!raw || raw.startsWith('${')) continue;
    fromCompose.push(raw);
  }
  if (fromCompose.length > 0) {
    return [...new Set(fromCompose)];
  }
  const list = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    list.push(trimmed);
  }
  return [...new Set(list)];
}

/**
 * Rewrite Docker Hub references to pull through a mirror host; other registries unchanged.
 * @param {string} image
 * @param {string} [mirror]
 * @returns {string}
 */
export function mirroredRef(image, mirror = 'mirror.gcr.io') {
  const trimmed = image.trim();
  const host = mirror.replace(/\/+$/, '');
  const { ref, tag, digest } = splitImageRef(trimmed);
  const hubPath = dockerHubRepositoryPath(ref);
  if (hubPath === null) return trimmed;
  return `${host}/${hubPath}${tag}${digest}`;
}

/**
 * Stable cache key for a set of image references (sorted, sha256 hex).
 * @param {string[]} images
 * @returns {string}
 */
export function cacheKey(images) {
  const sorted = [...images].map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}
