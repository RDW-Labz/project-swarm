import { anyPathMatchesGlobs } from '../skills.mjs';
import { RETURN_JSON_RE } from './patterns.mjs';

function promptPathCovered(candidate, covered) {
  if (candidate.includes('*')) return anyPathMatchesGlobs([candidate], [...covered]);
  return covered.has(candidate) || [...covered].some(file => file.startsWith(candidate + '/'));
}

export function parsePromptDeclaredResultKeys(prompt) {
  const text = String(prompt ?? '');
  const marker = RETURN_JSON_RE.exec(text);
  if (!marker) return null;
  const braceStart = text.indexOf('{', marker.index);
  if (braceStart === -1) return null;
  let depth = 0, inString = false, escape = false, end = -1;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (inString) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  const obj = text.slice(braceStart, end + 1);
  const keys = []; let d = 0;
  for (let i = 0; i < obj.length; i++) {
    if (obj[i] === '{') d++;
    else if (obj[i] === '}') d--;
    else if (d === 1 && obj[i] === '"') {
      const keyMatch = /^"([A-Za-z0-9_]+)"\s*:/.exec(obj.slice(i));
      if (keyMatch) { keys.push(keyMatch[1]); i += keyMatch[0].length - 1; }
    }
  }
  return keys;
}

export { promptPathCovered };
