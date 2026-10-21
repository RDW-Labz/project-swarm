// SPDX-License-Identifier: Apache-2.0
// Resolve Claude Code Remote Control chat URLs for orchestrator sessions (read-only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSION_JSON_RE = /^\d{1,10}\.json$/;
const BRIDGE_ID_RE = /^session_[A-Za-z0-9]{10,80}$/;
const URL_RE = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{10,80}$/;
const SCAN_TTL_MS = 15_000;
const MAX_SESSION_FILES = 500;
const MAX_SESSION_FILE_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_TAIL = 512 * 1024;

/** @type {Map<string, { at: number, bySessionId: Map<string, { bridgeSessionId: string, updatedAt: number }> }>} */
const scanCache = new Map();

function acceptedUrl(url) {
  if (typeof url !== 'string' || !URL_RE.test(url)) return null;
  return url;
}

function urlFromBridgeId(bridgeSessionId) {
  if (typeof bridgeSessionId !== 'string' || !BRIDGE_ID_RE.test(bridgeSessionId)) return null;
  return acceptedUrl(`https://claude.ai/code/${bridgeSessionId}`);
}

function scanSessions(home, now) {
  const key = path.resolve(home);
  const cached = scanCache.get(key);
  if (cached && now - cached.at < SCAN_TTL_MS) return cached.bySessionId;

  const bySessionId = new Map();
  const sessionsDir = path.join(home, '.claude', 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    scanCache.set(key, { at: now, bySessionId });
    return bySessionId;
  }

  const jsonNames = names.filter(n => SESSION_JSON_RE.test(n)).slice(0, MAX_SESSION_FILES);
  for (const name of jsonNames) {
    const filePath = path.join(sessionsDir, name);
    let raw;
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const stat = fs.fstatSync(fd);
        const toRead = Math.min(stat.size, MAX_SESSION_FILE_BYTES);
        const buf = Buffer.alloc(toRead);
        fs.readSync(fd, buf, 0, toRead, 0);
        raw = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const sid = data?.sessionId;
    if (typeof sid !== 'string' || !sid) continue;
    const updatedAt = Number(data?.updatedAt) || 0;
    const bridge = typeof data?.bridgeSessionId === 'string' ? data.bridgeSessionId : '';
    const prev = bySessionId.get(sid);
    if (!prev || updatedAt >= prev.updatedAt) {
      bySessionId.set(sid, { bridgeSessionId: bridge, updatedAt });
    }
  }

  scanCache.set(key, { at: now, bySessionId });
  return bySessionId;
}

function projectsRoot(home) {
  return path.join(home, '.claude', 'projects');
}

function transcriptRealUnderProjects(candidate, home) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(projectsRoot(home));
  } catch {
    return null;
  }
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

function urlFromTranscript(transcriptPath, home) {
  const real = transcriptRealUnderProjects(transcriptPath, home);
  if (!real) return null;

  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return null;
  }
  const start = Math.max(0, stat.size - MAX_TRANSCRIPT_TAIL);
  const len = stat.size - start;
  let text;
  try {
    const fd = fs.openSync(real, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = text.split('\n');
  let newestUrl = null;
  let newestScore = -Infinity;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.includes('bridge_status')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== 'system' || e?.subtype !== 'bridge_status') continue;
    const url = acceptedUrl(e?.url);
    if (!url) continue;
    const ts = Number(e.timestamp ?? e.updatedAt);
    const score = Number.isFinite(ts) ? ts : i;
    if (score >= newestScore) {
      newestScore = score;
      newestUrl = url;
    }
  }
  return newestUrl;
}

/** Remote Control URL for a Claude Code session id, or null. Never throws. */
export function chatUrlFor(sessionId, { home = os.homedir(), transcriptPath = null, now = Date.now() } = {}) {
  try {
    if (typeof sessionId !== 'string' || !sessionId) return null;

    const hit = scanSessions(home, now).get(sessionId);
    if (hit) {
      const fromSession = urlFromBridgeId(hit.bridgeSessionId);
      if (fromSession) return fromSession;
    }

    if (typeof transcriptPath === 'string' && transcriptPath) {
      return urlFromTranscript(transcriptPath, home);
    }
    return null;
  } catch {
    return null;
  }
}
