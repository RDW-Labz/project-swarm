// SPDX-License-Identifier: Apache-2.0
/** Render Hive command-center stat strip (.cc-stat figures) from labelled data. */

function isTrustedSource(source) {
  return typeof source === 'string' && source.length > 0;
}

function formatStatValue(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function statToneClass(tone) {
  if (tone === 'bad' || tone === 'warn' || tone === 'good') return tone;
  return '';
}

/**
 * @param {HTMLElement} container Strip host (e.g. .hive-stat-strip)
 * @param {Array<{ label: string, value: string|number, source: string, tone?: string }>} entries
 */
export function renderHiveStatStrip(container, entries) {
  if (!container) return;

  const existing = [];
  for (const child of container.children || []) {
    if (child.classList && child.classList.contains('cc-stat')) {
      existing.push(child);
    }
  }
  for (const el of existing) {
    container.removeChild(el);
  }

  const list = Array.isArray(entries) ? entries : [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.label !== 'string' || !entry.label.length) continue;
    if (!isTrustedSource(entry.source)) continue;

    const stat = document.createElement('div');
    stat.className = 'cc-stat';

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = entry.label;

    const tone = statToneClass(entry.tone);
    const val = document.createElement('span');
    val.className = tone ? 'val num ' + tone : 'val num';
    val.textContent = formatStatValue(entry.value);
    val.setAttribute('title', entry.source);

    stat.appendChild(lbl);
    stat.appendChild(val);
    container.appendChild(stat);
  }
}
