// SPDX-License-Identifier: Apache-2.0

const SPLIT_PARK_PREFIX = 'split-park-';
const STAGE_TICKET_RE = /^split-park-(S\d+)-(.+)$/;
const INGEST_RUN_RE = /swarm scope split --ingest ([A-Za-z0-9][A-Za-z0-9._-]*)/;

export function parseSplitParkStage(id) {
  if (typeof id !== 'string') return null;
  const match = STAGE_TICKET_RE.exec(id);
  return match ? { stage: match[1], ticket: match[2] } : null;
}

export function parseSplitParkIngestRun(text) {
  const match = INGEST_RUN_RE.exec(String(text ?? ''));
  return match ? match[1] : null;
}

function eventTime(event, index) {
  const parsed = Date.parse(event?.ts ?? '');
  return Number.isFinite(parsed) ? parsed : index;
}

/**
 * @param {object[]} events
 * @param {{ stage?: string }} [options]
 */
export function supersededSplitParks(events, { stage: stageFilter } = {}) {
  const list = Array.isArray(events) ? events : [];
  const newestRunByStage = new Map();

  list.forEach((event, index) => {
    if (event?.kind !== 'blocker' || !String(event.id ?? '').startsWith(SPLIT_PARK_PREFIX)) return;
    if (event.resolved === true) return;
    const parsed = parseSplitParkStage(event.id);
    if (!parsed) return;
    if (stageFilter && parsed.stage !== stageFilter) return;
    const time = eventTime(event, index);
    const prev = newestRunByStage.get(parsed.stage);
    if (!prev || time >= prev.time) {
      newestRunByStage.set(parsed.stage, {
        time,
        run: parseSplitParkIngestRun(event.text),
      });
    }
  });

  const open = new Map();
  list.forEach((event, index) => {
    if (event?.kind !== 'blocker' && event?.kind !== 'human') return;
    if (event.id === undefined || event.id === null) return;
    const key = `${event.kind}:${event.id}`;
    const prev = open.get(key);
    if (!prev || index >= prev.index) open.set(key, { event, index });
  });

  const superseded = [];
  const kept = [];

  for (const { event } of open.values()) {
    if (event.kind !== 'blocker' || event.resolved === true) continue;
    if (!String(event.id).startsWith(SPLIT_PARK_PREFIX)) continue;

    const parsed = parseSplitParkStage(event.id);
    if (!parsed) {
      kept.push({
        id: event.id,
        stage: null,
        ticket: event.ticket ?? null,
        run: parseSplitParkIngestRun(event.text),
        reason: 'unparseable stage from blocker id',
      });
      continue;
    }
    if (stageFilter && parsed.stage !== stageFilter) continue;

    const run = parseSplitParkIngestRun(event.text);
    const ticket = event.ticket ?? parsed.ticket;
    const base = { id: event.id, stage: parsed.stage, ticket, run };

    if (!run) {
      kept.push({ ...base, reason: 'unparseable ingest run in blocker text' });
      continue;
    }

    const newest = newestRunByStage.get(parsed.stage);
    const newestRun = newest?.run ?? null;
    if (!newestRun) {
      kept.push({ ...base, reason: 'newest stage blocker has unparseable ingest run' });
      continue;
    }
    if (run === newestRun) {
      kept.push({ ...base, reason: 'matches newest ingest run for stage' });
      continue;
    }

    superseded.push({ ...base, newerRun: newestRun });
  }

  return { superseded, kept };
}
