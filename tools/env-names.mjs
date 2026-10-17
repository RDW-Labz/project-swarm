// SPDX-License-Identifier: Apache-2.0
const NAME_LINE = /^(?:export +)?([A-Z][A-Z0-9_]{0,63})=/;

export function parseEnvNames(text) {
  const names = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = NAME_LINE.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names].sort().slice(0, 100);
}

export function envNamesLine(names) {
  if (!names || names.length === 0) return '';
  return `Environment variable names this project reads (names only, values are not shared): ${names.join(', ')}.`;
}
