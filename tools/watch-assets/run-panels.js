// SPDX-License-Identifier: Apache-2.0
(function () {
  'use strict';

  var COLORS = { hermes: '#22d3ee', cursor: '#60a5fa', codex: '#fbbf24', anthropic: '#fb923c', openrouter: '#a78bfa', claude: '#fcd34d' };
  var OTHER = '#a3a3ae';
  var STRIPE = { error: 'var(--red)', warn: 'var(--amber)', info: 'var(--sky)' };
  var BATCH = { ok: '#34d399', bisect: '#fbbf24', conflict: '#fb923c' };
  var BATCH_SYM = { ok: '\u2713', bisect: '\u00bd', conflict: '!' };
  var WAVE_COL = ['#22d3ee', '#60a5fa', '#34d399'];
  var LEAD_PILL = { running: 'info', failed: 'bad', done: 'good', queued: 'lav' };

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function isNum(v) {
    return v !== null && v !== undefined && v !== '' && !isNaN(Number(v));
  }

  function num(v) {
    return isNum(v) ? Number(v).toLocaleString('en-US') : '\u2013';
  }

  function pct(v) {
    return isNum(v) ? Math.round(Number(v) * 100) + '%' : '\u2013';
  }

  function laneColor(name) {
    var k = String(name || '').toLowerCase();
    return COLORS[k] || OTHER;
  }

  function arr(v) {
    return Array.isArray(v) ? v : [];
  }

  function cap(s) {
    s = String(s || '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function pill(cls, text) {
    return el('span', 'pill ' + cls, text);
  }

  function fmtTime(at) {
    var d = new Date(at);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(11, 19);
  }

  function renderLanes(lanes) {
    var box = $('lanes');
    if (!box) return;
    clear(box);
    lanes.forEach(function (ln) {
      var off = !!ln.offline;
      var color = laneColor(ln.name);
      var limit = isNum(ln.limit) ? Number(ln.limit) : 0;
      var inFlight = isNum(ln.inFlight) ? Number(ln.inFlight) : 0;
      var row = el('div', 'lane' + (off ? ' off' : ''));

      var top = el('div', 'lane-top');
      var sw = el('i', 'sw');
      sw.style.background = color;
      sw.style.width = '12px';
      sw.style.height = '12px';
      sw.style.borderRadius = '4px';
      var grow = el('div', 'grow');
      grow.appendChild(el('div', 'lane-name', ln.name));
      grow.appendChild(el('div', 'lane-model', off && ln.reason ? ln.reason : (ln.state || '')));
      var nums = el('div', 'lane-nums num', off ? 'offline' : num(inFlight) + ' / ' + num(limit));
      top.appendChild(sw);
      top.appendChild(grow);
      top.appendChild(nums);
      row.appendChild(top);

      var bar = el('div', 'bar');
      var fill = el('span');
      var w = limit > 0 && !off ? Math.min(100, inFlight / limit * 100) : 0;
      fill.style.width = w + '%';
      fill.style.background = 'linear-gradient(90deg, ' + color + '99, ' + color + ')';
      bar.appendChild(fill);
      row.appendChild(bar);

      var meta = el('div', 'lane-meta');
      meta.appendChild(pill('info', num(ln.done) + ' done'));
      var pr = ln.passRate;
      meta.appendChild(pill(!isNum(pr) || Number(pr) >= 0.95 ? 'good' : 'warn', 'pass ' + pct(pr)));
      meta.appendChild(pill('lav', 'avg ' + (isNum(ln.avgMs) ? (Number(ln.avgMs) / 1000).toFixed(1) + 's' : '\u2013')));
      if (isNum(ln.rateLimits) && Number(ln.rateLimits) > 0) {
        meta.appendChild(pill('warn', '429s ' + num(ln.rateLimits)));
      }
      row.appendChild(meta);
      box.appendChild(row);
    });
  }

  function renderWaves(waves) {
    var box = $('waves');
    if (!box) return;
    clear(box);
    waves.forEach(function (w, i) {
      var total = isNum(w.total) ? Number(w.total) : 0;
      var done = isNum(w.done) ? Number(w.done) : 0;
      var run = isNum(w.running) ? Number(w.running) : 0;
      var p = total ? done / total * 100 : 0;
      var rp = total ? run / total * 100 : 0;
      var c = WAVE_COL[i % WAVE_COL.length];
      var row = el('div', 'wave');
      row.appendChild(el('div', 'w-name', cap(w.name)));
      var bar = el('div', 'bar');
      var s1 = el('span');
      s1.style.width = p + '%';
      s1.style.background = c;
      var s2 = el('span');
      s2.style.left = p + '%';
      s2.style.width = rp + '%';
      s2.style.background = c + '55';
      bar.appendChild(s1);
      bar.appendChild(s2);
      row.appendChild(bar);
      row.appendChild(el('div', 'num mono', done + '/' + total));
      box.appendChild(row);
    });
  }

  function renderFeed(list) {
    var box = $('feed');
    if (!box) return;
    clear(box);
    list.slice(0, 50).forEach(function (a) {
      var ev = el('div', 'ev');
      var stripe = el('span', 'stripe');
      stripe.style.background = STRIPE[a.severity] || STRIPE.info;
      var body = el('div');
      body.style.minWidth = '0';
      body.appendChild(el('div', 't', (a.kind || 'event') + (a.jobId ? ' \u00b7 ' + a.jobId : '')));
      body.appendChild(el('div', 'd', a.text || ''));
      var meta = el('div', 'w', fmtTime(a.at));
      meta.appendChild(el('span', 'untrusted', 'worker text'));
      body.appendChild(meta);
      ev.appendChild(stripe);
      ev.appendChild(body);
      box.appendChild(ev);
    });
  }

  function renderLeads(leads) {
    var body = $('leads');
    if (!body) return;
    clear(body);
    leads.forEach(function (L) {
      var total = isNum(L.total) ? Number(L.total) : 0;
      var done = isNum(L.done) ? Number(L.done) : 0;
      var p = total ? done / total * 100 : 0;
      var tr = el('tr');

      var td1 = el('td');
      td1.appendChild(el('div', 'lead-name', L.lead));
      tr.appendChild(td1);

      var td2 = el('td');
      var wrap = el('div');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '10px';
      var bar = el('div', 'bar');
      bar.style.flex = '1';
      var fill = el('span');
      fill.style.width = p + '%';
      fill.style.background = 'linear-gradient(90deg,var(--teal),var(--lime))';
      bar.appendChild(fill);
      wrap.appendChild(bar);
      wrap.appendChild(el('span', 'num mono', Math.round(p) + '% (' + done + '/' + total + ')'));
      td2.appendChild(wrap);
      tr.appendChild(td2);

      tr.appendChild(el('td', 'num mono', num(L.running)));
      tr.appendChild(el('td', 'num mono', num(L.retries)));
      tr.appendChild(el('td', 'num mono', '\u2013'));

      var td6 = el('td');
      var st = String(L.state || 'queued');
      td6.appendChild(pill(LEAD_PILL[st] || 'info', st));
      tr.appendChild(td6);

      body.appendChild(tr);
    });
  }

  function renderMerge(mq, queued) {
    var q = isNum(queued) ? Number(queued) : 0;
    $('mWait').textContent = num(q);
    $('mBatch').textContent = num(mq ? mq.batches : 0);
    $('mBisect').textContent = num(mq ? mq.bisects : 0);
    $('mConf').textContent = num(mq ? mq.conflicts : 0);
    var box = $('batches');
    if (!box) return;
    clear(box);
    arr(mq ? mq.recent : []).forEach(function (b) {
      var key = String(b);
      var chip = el('span', 'batch', BATCH_SYM[key] || '!');
      chip.style.background = BATCH[key] || BATCH.conflict;
      chip.title = key;
      box.appendChild(chip);
    });
  }

  function render(data) {
    var run = data && data.run;
    if (!run) return;
    var lanesBox = $('lanes');
    var attn = $('attnCount');
    var attnList = arr(run.attention);
    renderLanes(arr(run.lanes));
    renderWaves(arr(run.waves));
    renderFeed(attnList);
    if (attn) attn.textContent = num(attnList.length);
    renderLeads(arr(run.leads));
    renderMerge(run.mergeQueue || null, run.kpi ? run.kpi.queued : 0);
    return lanesBox;
  }

  if (window.SwarmWatch && typeof window.SwarmWatch.register === 'function') {
    window.SwarmWatch.register('run', render);
  }
})();
