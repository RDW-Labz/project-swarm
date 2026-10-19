// SPDX-License-Identifier: Apache-2.0
// swarm time log HOURS "note" | list      swarm quote SCOPE.md | record | list | config
import fs from 'node:fs/promises';
import path from 'node:path';
import { ownerHoursOf, renderSummary } from './time-auto.mjs';
import { parseScope } from './scope.mjs';
import { logTime, readTime, readQuoteConfig, writeQuoteConfig, readRecords, recordsDamaged, saveRecord, buildRecord, buildQuote, estimatedFull, renderQuote, traitsOf, quotesDir } from './quotes.mjs';

export const TIME_USAGE = [
  'Usage: swarm time log HOURS ["note"] [--date YYYY-MM-DD | --through YYYY-MM-DD]   your own hours (--date: a past day; --through: a total up to that day)',
  '       swarm time summary [--days N]    estimated hands-on hours per day from your activity (marked estimated); your entries replace the estimate for their days',
  '       swarm time list                  your entries',
].join('\n');
export const QUOTE_USAGE = [
  'Usage: swarm quote SCOPE.md                                  ranges from the most similar finished projects (price blank until rate and margin are set)',
  '       swarm quote record [--name NAME] [--charged USD] [--change-orders N] [--gpu-hours H] [--backfill]   keep this project\'s numbers',
  '       swarm quote list                                      the finished projects kept so far',
  '       swarm quote config [--rate USD_PER_HOUR] [--margin PERCENT]   show or set your rate and margin (no default is invented)',
].join('\n');
const out = (stdout, exitCode = 0) => ({ stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, exitCode });

export async function runTimeCommand(root, args, { now = Date.now, activity } = {}) {
  const [sub, ...rest] = args;
  if (sub === 'log') {
    const words = [];
    const flags = {};
    for (let i = 0; i < rest.length; i += 1) {
      if ((rest[i] === '--date' || rest[i] === '--through') && rest[i + 1] !== undefined) flags[rest[i].slice(2)] = rest[++i];
      else if (rest[i].startsWith('--')) return out(`Unknown argument: ${rest[i]}\n${TIME_USAGE}`, 2);
      else words.push(rest[i]);
    }
    if (words[0] === undefined) return out(TIME_USAGE, 2);
    const result = await logTime(root, words[0], words.slice(1).join(' '), { now, ...flags });
    if (!result.ok) return out(result.error, 2);
    const daily = await ownerHoursOf(root, activity);
    return out(`logged ${result.entry.hours} hours${flags.through ? ` as your total through ${flags.through}` : flags.date ? ` for ${flags.date}` : ''}; hours that count on this project now: ${daily.total} (${daily.estimatedPart} estimated)`);
  }
  if (sub === 'summary') {
    let days = 14;
    if (rest[0] === '--days') { days = Number(rest[1]); if (!Number.isInteger(days) || days < 1 || days > 400) return out('--days must be a whole number from 1 to 400', 2); }
    else if (rest.length) return out(TIME_USAGE, 2);
    return out(renderSummary(await ownerHoursOf(root, activity), { days, now }));
  }
  if (sub === 'list') {
    const t = await readTime(root);
    const lines = t.entries.map(e => `${e.day ?? e.at.slice(0, 10)}  ${String(e.hours).padStart(5)} h  ${e.through ? `(total through ${e.through}) ` : ''}${e.note}`.trimEnd());
    return out(t.entries.length ? [...lines, `entered ${t.total} hours${t.skipped ? ` (${t.skipped} unreadable line(s) skipped)` : ''}; swarm time summary shows what counts`].join('\n') : 'No hours entered yet. swarm time log HOURS "note"   (swarm time summary shows the estimate)');
  }
  return out(TIME_USAGE, 2);
}

export async function runQuoteCommand(root, args, { now = Date.now, env = process.env, activity } = {}) {
  const dir = quotesDir(env);
  const [sub, ...rest] = args;
  if (sub === 'config') {
    const flags = {};
    for (let i = 0; i < rest.length; i += 1) {
      if ((rest[i] === '--rate' || rest[i] === '--margin') && rest[i + 1] !== undefined) flags[rest[i].slice(2)] = rest[++i];
      else return out(`Unknown argument: ${rest[i]}\n${QUOTE_USAGE}`, 2);
    }
    if (flags.rate !== undefined || flags.margin !== undefined) {
      const result = await writeQuoteConfig(dir, flags);
      if (!result.ok) return out(result.error, 2);
    }
    const c = await readQuoteConfig(dir);
    return out([`hourly rate: ${c.hourlyRate === null ? 'not set' : `$${c.hourlyRate}`}`, `margin:      ${c.margin === null ? 'not set' : `${Math.round(c.margin * 1000) / 10}% of the price`}`, c.hourlyRate === null || c.margin === null ? 'The price line stays blank until both are set.' : 'Quotes now show a price range.'].join('\n'));
  }
  if (sub === 'list') {
    const damaged = await recordsDamaged(dir);
    if (damaged) return out(`${damaged}; fix it or move it aside`, 1);
    const list = await readRecords(dir);
    if (!list.length) return out('No finished projects kept yet. In a project folder: swarm quote record');
    const f = v => (v === null || v === undefined ? '?' : v);
    return out(list.map(p => `${p.name}${p.source === 'backfill' ? ' (backfilled)' : ''}: requirements ${f(p.requirements)}, tickets ${f(p.tickets)}, estimated full ${estimatedFull(p) === null ? '?' : `$${Math.round(estimatedFull(p) * 100) / 100}`} (billed ${p.billedUsd === null || p.billedUsd === undefined ? '?' : `$${p.billedUsd}`}), owner hours ${f(p.ownerHours)}, days ${f(p.calendarDays)}${p.chargedUsd === null ? '' : `, charged $${p.chargedUsd}`}`).join('\n'));
  }
  if (sub === 'record') {
    const flags = {};
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i];
      if (a === '--backfill') flags.backfill = true;
      else if (['--name', '--charged', '--change-orders', '--gpu-hours'].includes(a) && rest[i + 1] !== undefined) flags[a.slice(2)] = rest[++i];
      else return out(`Unknown argument: ${a}\n${QUOTE_USAGE}`, 2);
    }
    const numeric = (key, int) => {
      if (flags[key] === undefined) return undefined;
      const v = Number(flags[key]);
      if (!Number.isFinite(v) || v < 0 || (int && !Number.isInteger(v))) throw new Error(`--${key} must be a ${int ? 'whole number' : 'number'} of 0 or more`);
      return v;
    };
    let record;
    try {
      record = await buildRecord(root, { name: flags.name ?? path.basename(root), source: flags.backfill ? 'backfill' : 'recorded', charged: numeric('charged'), changeOrders: numeric('change-orders', true), gpuHours: numeric('gpu-hours'), now, activity });
    } catch (error) { return out(error.message, 2); }
    let saved;
    try { saved = await saveRecord(dir, record); } catch (error) { return out(error.message, 1); }
    return out([`${saved.replaced ? 'updated' : 'kept'}: ${record.name}${record.source === 'backfill' ? ' (backfilled)' : ''}`, `requirements ${record.requirements ?? '?'}, tickets ${record.tickets ?? '?'}, estimated full ${record.estimatedFullUsd === null ? '? (no runs here)' : `$${record.estimatedFullUsd}`} (billed ${record.billedUsd === null ? '?' : `$${record.billedUsd}`}), flat-rate list value ${record.flatRateListUsd === null ? '?' : `$${record.flatRateListUsd}`}, owner hours ${record.ownerHours ?? 'none'}${record.ownerHoursEstimated ? ` (${record.ownerHoursEstimated} of them estimated)` : ''}, calendar days ${record.calendarDays ?? '?'}`].join('\n'));
  }
  if (sub && !sub.startsWith('--')) {
    let text;
    try { text = await fs.readFile(path.resolve(root, sub), 'utf8'); } catch { return out(`cannot read the scope file: ${sub}`, 2); }
    const scope = parseScope(text);
    const traits = traitsOf(scope);
    if (!TRAITSET.some(k => traits[k])) return out('that scope has no requirements, stages, screens or services to size a quote from', 1);
    const damaged = await recordsDamaged(dir);
    if (damaged) return out(`${damaged}; fix it or move it aside (a quote from damaged history would be wrong)`, 1);
    const quote = buildQuote({ traits, records: await readRecords(dir), config: await readQuoteConfig(dir) });
    return out(renderQuote(quote));
  }
  return out(QUOTE_USAGE, 2);
}

const TRAITSET = ['requirements', 'stages', 'screens', 'services'];
