// SPDX-License-Identifier: Apache-2.0
// The Orchestrator lane: one robot head per Claude Code session that drives a project, labelled by project, with what it is doing now, how long, its tokens and list cost (a subscription
// session), and how much of the project it built by hand. Shared by the board, the project page, the Live tab and the run page.
// Text is always set with textContent. Read-only: everything comes from the board data.
import { mountRobotHead } from './robot-head.js';

var HEAD = { working: 'working', thinking: 'thinking', waiting: 'idle', idle: 'sleeping', ended: 'sleeping' };
var COLOR = '#c084fc';
function el(tag, cls, text) { var n = document.createElement(tag); if (cls) { n.className = cls; } if (text !== undefined && text !== null) { n.textContent = text; } return n; }
function tokens(n) { return typeof n !== 'number' ? '-' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n); }
function span(ms) { var s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'; }

export var STATE_TEXT = { working: 'working', thinking: 'thinking', waiting: 'waiting on you', idle: 'idle', ended: 'ended' };

function stateText(s, now) {
  if (s.state === 'ended') {
    var at = Date.parse(s.endedAt || s.since);
    return 'ended' + (isFinite(at) ? ' ' + span(now - at) + ' ago' : '');
  }
  return STATE_TEXT[s.state] || s.state;
}

/** What the session is doing now, short: "Edit src/a.ts, 12s", "Bash npm test, 4s", "thinking, 8s", "waiting on you, 4m". */
export function doingText(s, now) {
  if (s.state === 'ended') { return stateText(s, now); }
  var since = s.since ? now - Date.parse(s.since) : null;
  var tail = since === null ? '' : ', ' + span(since);
  if (s.state === 'working' && s.doing) { return s.doing.tool + ' ' + (s.doing.file || s.doing.command || '') + tail; }
  return STATE_TEXT[s.state] + tail;
}

/** "swarm-built 83%, hand-built 17% (12 files)"; null when nothing was built yet. */
export function buildMixText(o) {
  if (!o || o.swarmPct === null || o.swarmPct === undefined) { return null; }
  return 'swarm-built ' + o.swarmPct + '%, hand-built ' + o.handPct + '% (' + o.handBuilt.files + ' file' + (o.handBuilt.files === 1 ? '' : 's') + (o.handBuilt.blocked ? ', ' + o.handBuilt.blocked + ' blocked' : '') + ')';
}

export function renderOrchestrator(host, sessions, opts) {
  var now = (opts && opts.now) || Date.now();
  var size = (opts && opts.size) || 44;
  var map = host.__orch || (host.__orch = new Map());
  var keep = {};
  var list = sessions || [];
  if (!list.length) {
    if (!host.__empty) { host.__empty = el('p', 'board-note', 'No Claude Code session is driving a project right now. Sessions appear once the swarm hooks are installed (swarm init or swarm update) and a session in that project does something.'); host.appendChild(host.__empty); }
    host.__empty.hidden = false;
  } else if (host.__empty) { host.__empty.hidden = true; }
  list.forEach(function (s) {
    var key = s.projectId + '|' + s.id;
    keep[key] = true;
    var hit = map.get(key);
    if (!hit) {
      var card = el('div', 'orch-card'); var holder = el('div', 'orch-head');
      var handle = mountRobotHead(holder, { state: HEAD[s.state] || 'idle', size: size, color: COLOR, screenColor: '#efe4ff', id: 'orch|' + key, label: 'orchestrator session in ' + s.project + ', ' + stateText(s, now) });
      var text = el('div', 'orch-text');
      hit = { card: card, handle: handle, name: el('div', 'orch-name'), chat: el('a', 'board-link', 'Open chat'), doing: el('div', 'orch-doing mono'), cost: el('div', 'orch-cost sub'), hand: el('div', 'orch-hand') };
      hit.chat.target = '_blank'; hit.chat.rel = 'noopener noreferrer';
      card.appendChild(holder); text.appendChild(hit.name); text.appendChild(hit.doing); text.appendChild(hit.cost); text.appendChild(hit.hand); card.appendChild(text);
      host.appendChild(card); map.set(key, hit);
    }
    hit.handle.setState(HEAD[s.state] || 'idle');
    hit.card.dataset.state = s.state;
    hit.name.textContent = s.project + '  ' + s.id + (s.machine ? ' · ' + s.machine : '');
    var chatOk = typeof s.chatUrl === 'string' && /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{10,80}$/.test(s.chatUrl);
    if (chatOk) {
      hit.chat.setAttribute('href', s.chatUrl);
      if (!hit.chat.parentNode) { hit.doing.parentNode.insertBefore(hit.chat, hit.doing); }
    } else if (hit.chat.parentNode) { hit.chat.remove(); }
    hit.doing.textContent = doingText(s, now);
    hit.cost.textContent = typeof s.tokensToday === 'number' ? tokens(s.tokensToday) + ' tokens today' : 'tokens not read yet';
    hit.hand.textContent = (s.handBuilt ? s.handBuilt + ' hand-built edit' + (s.handBuilt === 1 ? '' : 's') : '') + (s.handBuilt && s.blocked ? ', ' : '') + (s.blocked ? s.blocked + ' blocked by the guard' : '');
    hit.hand.hidden = !(s.handBuilt || s.blocked);
  });
  map.forEach(function (v, k) { if (!keep[k]) { v.handle.destroy(); v.card.remove(); map.delete(k); } });
}
