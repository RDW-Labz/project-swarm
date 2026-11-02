// SPDX-License-Identifier: Apache-2.0
// swarm report --client [--since DAYS] [--preview URL]   |   --approve [DIR]   |   --status
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseScope } from './scope.mjs';
import { readLedger } from './tickets.mjs';
import { buildReport, doneTimes, writeDraft, approveReport, listReports, allowedPhrases, checkPreviewUrl } from './client-report.mjs';

export const REPORT_USAGE = 'Usage: swarm report --client [--since DAYS] [--preview HTTPS_URL]     (writes a DRAFT: .swarm/reports/client-DATE/report.html and report.txt)\n       swarm report --client --status                                (the drafts and approved reports)\n       swarm report --client --approve [client-DATE]                 (you approve the files as they are now; any later edit un-approves them)\nFiles only: nothing is sent. Read the draft, change what you like in the files, approve it, then send it yourself.\nDecisions for the client come from a scope section titled "Client decisions" (one "- ..." line each). A scope section "Report allow" lists phrases that are fine for this client ("- support ticket"); money, vendors, ids, paths, secrets and addresses can never be allowed.\n';
const out = (stdout, exitCode = 0) => ({ stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, exitCode });

async function approvedScopeText(root, ledger) {
  for (const file of ['.swarm/project/scope.snapshot.md', ledger?.scope?.file ?? 'docs/scope/scope.md']) {
    try { return await fs.readFile(path.join(root, file), 'utf8'); } catch { /* the next one */ }
  }
  return null;
}

export async function runReportCommand(root, args, { now = Date.now } = {}) {
  if (!args.includes('--client')) return out(`swarm report needs --client\n${REPORT_USAGE}`, 2);
  const flags = {};
  const rest = args.filter(a => a !== '--client');
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--approve') { flags.approve = true; if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags.dir = rest[++i]; }
    else if (a === '--status') flags.status = true;
    else if ((a === '--since' || a === '--preview') && rest[i + 1] !== undefined) flags[a.slice(2)] = rest[++i];
    else return out(`Unknown argument: ${a}\n${REPORT_USAGE}`, 2);
  }
  if (flags.status) {
    const list = await listReports(root);
    return out(list.length ? list.map(r => `${r.dir}  ${r.status}${r.approvedAt ? `  approved ${r.approvedAt}` : ''}`).join('\n') : 'No client reports yet. swarm report --client');
  }
  if (flags.approve) {
    const result = await approveReport(root, flags.dir, { now });
    if (!result.ok) return out([result.error, ...(result.problems ?? []).map(p => `  ${p.what}: ${p.sample}`)].join('\n'), 1);
    return out(`approved ${result.dir} (these exact files, fingerprint ${result.hash.slice(0, 12)}). If you change them again the approval no longer counts; approve again.`);
  }
  let sinceDays = 7;
  if (flags.since !== undefined) { sinceDays = Number(flags.since); if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 60) return out('--since must be a whole number of days, 1 to 60', 2); }
  if (flags.preview !== undefined) { const check = checkPreviewUrl(flags.preview); if (!check.ok) return out(`--preview: ${check.reason}`, 2); }
  const ledger = await readLedger(root).catch((error) => {
    if (error?.code !== 'ENOENT') console.error('[tools/report-commands.mjs] runReportCommand readLedger:', (error instanceof SyntaxError || error?.name === 'SyntaxError') ? 'corrupt ledger (SyntaxError)' : (error?.message ?? error));
    return null;
  });
  if (!ledger) return out('no ticket ledger yet (swarm scope split), so there is nothing to report', 1);
  const text = await approvedScopeText(root, ledger);
  if (text === null) return out('the scope file is missing', 1);
  const scope = parseScope(text);
  const data = buildReport({ scope, ledger, times: await doneTimes(root), now: now(), sinceDays, previewUrl: flags.preview ?? null });
  const allowed = allowedPhrases(scope);
  const written = await writeDraft(root, data, { now, allowed });
  if (!written.ok) return out(['the report was NOT written: it would show something that must not reach a client. Reword the scope text it comes from (the requirements and the "Client decisions" section), or, for an ordinary word of this client\'s own feature, list the phrase in a scope section "Report allow":', ...written.problems.map(p => `  ${p.what}: ...${p.sample}...`)].join('\n'), 1);
  return out([`draft written: ${written.dir}/report.html and report.txt`, `${data.percent}% complete (${data.done} of ${data.total} features); ${data.doneThisWeek.length} done in the last ${sinceDays} days, ${data.inProgress.length} in progress, ${data.next.length} coming up, ${data.decisions.length} decision(s) for the client${data.previewUrl ? ', preview link included' : ', no preview link (--preview URL adds one)'}.`, `Read it, then: swarm report --client --approve ${written.dir.split('/').pop()}`, 'Nothing was sent.'].join('\n'));
}
