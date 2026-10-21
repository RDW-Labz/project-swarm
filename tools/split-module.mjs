// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { tokenizer, tokTypes, parse } from 'acorn';
import { scanModule, topLevelNameIndex } from './split-scan.mjs';

const ACORN_TOKENIZE_OPTS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowHashBang: true,
  allowAwaitOutsideFunction: true,
};

const JS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'of',
  'static', 'get', 'set', 'from', 'as',
]);

const BUILTIN_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'global', 'self', 'window',
  'Object', 'Function', 'Boolean', 'Symbol', 'Error', 'AggregateError', 'EvalError',
  'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
  'Number', 'BigInt', 'Math', 'Date', 'String', 'RegExp', 'Array', 'Int8Array',
  'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'JSON', 'Promise',
  'console', 'process', 'Buffer', 'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask',
  'structuredClone', 'atob', 'btoa', 'fetch', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'Event', 'EventTarget',
  'require', 'module', 'exports', '__proto__', 'arguments', 'eval', 'isNaN', 'isFinite',
  'parseFloat', 'parseInt', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
  'escape', 'unescape', 'Iterator', 'AsyncIterator', 'Reflect', 'Proxy',
]);

try {
  for (const n of Object.getOwnPropertyNames(globalThis)) {
    BUILTIN_GLOBALS.add(n);
  }
} catch {
  // ignore
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function spdxLine(text) {
  const first = text.split('\n')[0];
  if (first.startsWith('// SPDX-License-Identifier:')) return first;
  return null;
}

function mainEntryExpressionIndices(items) {
  const indices = new Set();
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind !== 'expression') break;
    indices.add(i);
  }
  return indices;
}

function findReassignedLetVar(text, items) {
  const letVarNames = new Set();
  for (const item of items) {
    const m = item.text.match(/^\s*(?:export\s+)?(let|var)\b/);
    if (!m) continue;
    for (const n of item.names) letVarNames.add(n);
  }
  if (letVarNames.size === 0) return new Set();

  const reassigned = new Set();
  const names = [...letVarNames];
  const nameAlt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

  const assignRe = new RegExp(
    `(?:^|[^\\w$])(?:(${nameAlt})\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*(${nameAlt})|(${nameAlt})\\s*(?:\\+=|-=|\\*=|\\/=|%=|\\*\\*=|&&=|\\|\\|=|\\?\\?=|<<=|>>=|>>>=|&=|\\|=|\\^=|=)(?!=))`,
    'g',
  );
  let m;
  while ((m = assignRe.exec(text)) !== null) {
    for (let i = 1; i <= 3; i++) {
      if (m[i]) reassigned.add(m[i]);
    }
  }

  const destructureRe = new RegExp(
    `(?:^|[^\\w$])(?:\\[\\s*(${nameAlt})|{\\s*(${nameAlt})\\s*[,}:]|,\\s*(${nameAlt})\\s*[,}:])\\s*=(?!=)`,
    'g',
  );
  while ((m = destructureRe.exec(text)) !== null) {
    for (let i = 1; i <= 3; i++) {
      if (m[i]) reassigned.add(m[i]);
    }
  }

  return reassigned;
}

function itemUsesForbiddenRuntime(item) {
  const t = item.text;
  if (t.includes('import.meta')) return true;
  if (/\b__filename\b/.test(t)) return true;
  if (/\b__dirname\b/.test(t)) return true;
  if (/\bprocess\.argv\s*\[\s*1\s*\]/.test(t)) return true;
  return false;
}

function buildDepIndexGraph(items) {
  const nameIndex = topLevelNameIndex(items);
  const n = items.length;
  const adj = items.map(() => []);
  for (let i = 0; i < n; i++) {
    const deps = new Set();
    for (const use of items[i].uses) {
      const decl = nameIndex.get(use);
      if (decl && decl.index !== i) deps.add(decl.index);
    }
    adj[i] = [...deps].sort((a, b) => a - b);
  }
  return adj;
}

function tarjanSccIndices(adj) {
  const n = adj.length;
  const index = new Array(n).fill(-1);
  const low = new Array(n).fill(0);
  const onStack = new Array(n).fill(false);
  const stack = [];
  const sccs = [];
  let idx = 0;

  function strongConnect(v) {
    index[v] = idx;
    low[v] = idx;
    idx++;
    stack.push(v);
    onStack[v] = true;

    for (const w of adj[v]) {
      if (index[w] === -1) {
        strongConnect(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v], index[w]);
      }
    }

    if (low[v] === index[v]) {
      const comp = [];
      for (;;) {
        const w = stack.pop();
        onStack[w] = false;
        comp.push(w);
        if (w === v) break;
      }
      comp.sort((a, b) => a - b);
      sccs.push(comp);
    }
  }

  for (let v = 0; v < n; v++) {
    if (index[v] === -1) strongConnect(v);
  }
  return sccs;
}

function computeLayers(items) {
  const adj = buildDepIndexGraph(items);
  const sccs = tarjanSccIndices(adj);
  const compId = new Map();
  sccs.forEach((comp, id) => {
    for (const i of comp) compId.set(i, id);
  });

  const compDeps = sccs.map(() => new Set());
  for (let i = 0; i < items.length; i++) {
    const from = compId.get(i);
    for (const j of adj[i]) {
      const to = compId.get(j);
      if (from !== to) compDeps[from].add(to);
    }
  }

  const layerOfComp = new Array(sccs.length).fill(-1);
  function compLayer(id) {
    if (layerOfComp[id] >= 0) return layerOfComp[id];
    let maxDep = -1;
    for (const d of compDeps[id]) {
      maxDep = Math.max(maxDep, compLayer(d));
    }
    layerOfComp[id] = maxDep + 1;
    return layerOfComp[id];
  }
  for (let id = 0; id < sccs.length; id++) compLayer(id);

  const layerMap = new Map();
  for (const comp of sccs) {
    const layer = layerOfComp[compId.get(comp[0])];
    if (!layerMap.has(layer)) layerMap.set(layer, []);
    layerMap.get(layer).push(comp);
  }

  const layers = [];
  const maxLayer = Math.max(...layerOfComp);
  for (let L = 0; L <= maxLayer; L++) {
    const groups = layerMap.get(L) || [];
    groups.sort((a, b) => a[0] - b[0]);
    const layerGroups = groups.map((comp) => {
      const sorted = [...comp].sort((a, b) => a - b);
      return sorted.map((i) => items[i]);
    });
    layers.push(layerGroups);
  }
  return layers;
}

function commonPrefix(names) {
  if (names.length === 0) return '';
  let prefix = names[0];
  for (let i = 1; i < names.length; i++) {
    const n = names[i];
    let j = 0;
    while (j < prefix.length && j < n.length && prefix[j] === n[j]) j++;
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  const camelBreak = prefix.search(/[a-z][A-Z]/);
  if (camelBreak >= 0) prefix = prefix.slice(0, camelBreak + 1);
  if (prefix.length < 2) return '';
  return prefix;
}

function suggestModuleGroups(items, layers) {
  const suggestions = [];
  for (let li = 0; li < layers.length; li++) {
    for (const group of layers[li]) {
      const indices = group.map((it) => it.index).sort((a, b) => a - b);
      const chunks = [];
      let cur = [indices[0]];
      for (let k = 1; k < indices.length; k++) {
        if (indices[k] === cur[cur.length - 1] + 1) cur.push(indices[k]);
        else {
          chunks.push(cur);
          cur = [indices[k]];
        }
      }
      chunks.push(cur);
      for (const chunk of chunks) {
        const names = chunk.flatMap((i) => items[i].names).filter(Boolean);
        const prefix = commonPrefix(names);
        const label = prefix || names.slice().sort().join('_') || `layer${li}`;
        suggestions.push({
          layer: li,
          names: names.slice().sort(),
          suggestedModule: `${label}.mjs`,
          itemIndices: chunk,
        });
      }
    }
  }
  suggestions.sort((a, b) => a.layer - b.layer || a.itemIndices[0] - b.itemIndices[0]);
  return suggestions;
}

function cannotMoveReasons(items, text) {
  const reassigned = findReassignedLetVar(text, items);
  const mainExprs = mainEntryExpressionIndices(items);
  const reasons = new Map();

  for (const item of items) {
    const list = [];
    if (mainExprs.has(item.index)) list.push('main-entry-expression');
    if (itemUsesForbiddenRuntime(item)) list.push('forbidden-runtime-reference');
    for (const n of item.names) {
      if (reassigned.has(n)) list.push(`reassigned-let-var:${n}`);
    }
    if (list.length) reasons.set(item.index, list);
  }
  return reasons;
}

function itemDescriptor(item) {
  const names = item.names.length ? item.names.join(',') : `(item@${item.index})`;
  const size = item.end - item.start;
  return {
    names: item.names,
    kind: item.kind,
    startLine: item.startLine,
    endLine: item.endLine,
    size,
    label: names,
  };
}

export function planSplit(filePath) {
  const text = readText(filePath);
  const { items } = scanModule(text);
  const layers = computeLayers(items);
  const cannotMove = cannotMoveReasons(items, text);
  const suggestions = suggestModuleGroups(items, layers);

  const layerOut = layers.map((layerGroups, layer) =>
    layerGroups.map((group) => ({
      layer,
      cycle: group.length > 1,
      items: group.map((it) => ({
        ...itemDescriptor(it),
        cannotMoveAlone: cannotMove.get(it.index) || [],
      })),
    })),
  );

  return {
    filePath,
    itemCount: items.length,
    layers: layerOut,
    suggestions,
    cannotMove: Object.fromEntries(
      [...cannotMove.entries()].map(([i, r]) => [String(i), r]),
    ),
  };
}

function parseImportSpecifiers(importText) {
  const specs = [];
  const sideEffect = /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/.exec(importText);
  if (sideEffect) {
    return { type: 'side', source: sideEffect[1], bindings: [] };
  }
  const fromMatch = importText.match(/\bfrom\s+(['"])([^'"]+)\1/);
  if (!fromMatch) return { type: 'unknown', source: null, bindings: [] };
  const source = fromMatch[2];
  const bindings = [];
  const defaultMatch = importText.match(/^\s*import\s+(\w+)\s*,/);
  const onlyDefault = importText.match(/^\s*import\s+(\w+)\s+from\b/);
  if (onlyDefault && !importText.includes('{')) {
    bindings.push({ imported: 'default', local: onlyDefault[1] });
  } else if (defaultMatch) {
    bindings.push({ imported: 'default', local: defaultMatch[1] });
  }
  const brace = importText.match(/\{([^}]+)\}/);
  if (brace) {
    for (const part of brace[1].split(',')) {
      const bit = part.trim();
      if (!bit) continue;
      const as = bit.match(/^(\w+)\s+as\s+(\w+)$/);
      if (as) bindings.push({ imported: as[1], local: as[2] });
      else bindings.push({ imported: bit, local: bit });
    }
  }
  const ns = importText.match(/import\s+\*\s+as\s+(\w+)/);
  if (ns) bindings.push({ imported: '*', local: ns[1] });
  return { type: 'module', source, bindings };
}

function fixImportSource(source, fromDir, toDir) {
  if (!source.startsWith('.') && !source.startsWith('/')) return source;
  const resolved = path.resolve(fromDir, source);
  let rel = path.relative(toDir, resolved);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel.split(path.sep).join('/');
}

function buildFilteredImports(movedItems, allItems, fileDir, moduleDir) {
  const used = new Set();
  for (const it of movedItems) {
    for (const u of it.uses) used.add(u);
  }

  const bySource = new Map();
  for (const it of allItems) {
    if (it.kind !== 'import') continue;
    const parsed = parseImportSpecifiers(it.text);
    if (!parsed.source) continue;
    const needed = parsed.bindings.filter((b) => used.has(b.local));
    if (parsed.type === 'side') {
      if (!bySource.has(parsed.source)) bySource.set(parsed.source, { side: true, lines: [it.text.trimEnd()] });
      continue;
    }
    if (needed.length === 0) continue;
    const src = fixImportSource(parsed.source, fileDir, moduleDir);
    if (!bySource.has(src)) bySource.set(src, { bindings: new Map(), side: false });
    const entry = bySource.get(src);
    for (const b of needed) {
      entry.bindings.set(b.local, b);
    }
  }

  const lines = [];
  const sources = [...bySource.keys()].sort();
  for (const src of sources) {
    const entry = bySource.get(src);
    if (entry.side) {
      for (const ln of entry.lines) {
        const fixed = ln.replace(/from\s+(['"])([^'"]+)\1/, (_, q, s) => {
          const ns = fixImportSource(s, fileDir, moduleDir);
          return `from ${q}${ns}${q}`;
        }).replace(/import\s+(['"])([^'"]+)\1/, (_, q, s) => {
          const ns = fixImportSource(s, fileDir, moduleDir);
          return `import ${q}${ns}${q}`;
        });
        lines.push(fixed.endsWith(';') ? fixed : `${fixed};`);
      }
      continue;
    }
    const bindings = [...entry.bindings.values()].sort((a, b) => a.local.localeCompare(b.local));
    const parts = bindings.map((b) => {
      if (b.imported === 'default') return b.local;
      if (b.imported === '*') return `* as ${b.local}`;
      if (b.imported === b.local) return b.local;
      return `${b.imported} as ${b.local}`;
    });
    const hasDefault = bindings.some((b) => b.imported === 'default');
    const named = bindings.filter((b) => b.imported !== 'default' && b.imported !== '*');
    let stmt = 'import ';
    if (hasDefault) {
      const d = bindings.find((b) => b.imported === 'default');
      stmt += d.local;
      if (named.length) stmt += `, { ${named.map((b) => (b.imported === b.local ? b.local : `${b.imported} as ${b.local}`)).join(', ')} }`;
    } else if (bindings.some((b) => b.imported === '*')) {
      const ns = bindings.find((b) => b.imported === '*');
      stmt += `* as ${ns.local}`;
    } else {
      stmt += `{ ${parts.join(', ')} }`;
    }
    stmt += ` from '${src}';`;
    lines.push(stmt);
  }
  return lines;
}

function itemByMovedName(items, movedNames) {
  const nameIndex = topLevelNameIndex(items);
  const movedItems = [];
  const seen = new Set();
  for (const n of [...movedNames].sort()) {
    const it = nameIndex.get(n);
    if (it && !seen.has(it.index)) {
      seen.add(it.index);
      movedItems.push(it);
    }
  }
  movedItems.sort((a, b) => a.index - b.index);
  return movedItems;
}

function collectFileImportNames(items) {
  const names = new Set();
  for (const it of items) {
    if (it.kind === 'import') {
      for (const n of it.names) names.add(n);
    }
  }
  return names;
}

function validateMove(items, text, movedNames, allowBackReferences) {
  const errors = [];
  const reassigned = findReassignedLetVar(text, items);
  const nameIndex = topLevelNameIndex(items);
  const movedItems = itemByMovedName(items, movedNames);
  const movedSet = new Set(movedNames);
  const remainingNames = new Set();
  for (const it of items) {
    const isMoved = it.names.some((n) => movedSet.has(n));
    if (!isMoved) {
      for (const n of it.names) remainingNames.add(n);
    }
  }
  const importNames = collectFileImportNames(items);
  const mainExprs = mainEntryExpressionIndices(items);

  for (const it of movedItems) {
    if (mainExprs.has(it.index)) errors.push(`cannot move main entry expression (item ${it.names.join(',') || it.index})`);
    if (itemUsesForbiddenRuntime(it)) errors.push(`cannot move item using forbidden runtime reference (${it.names.join(',') || it.index})`);
    for (const n of it.names) {
      if (reassigned.has(n)) errors.push(`cannot move reassigned let/var: ${n}`);
    }
  }

  const backRefs = new Set();
  for (const it of movedItems) {
    for (const use of it.uses) {
      if (movedSet.has(use)) continue;
      if (importNames.has(use)) continue;
      if (BUILTIN_GLOBALS.has(use)) continue;
      if (remainingNames.has(use)) backRefs.add(use);
    }
  }
  if (backRefs.size && !allowBackReferences) {
    errors.push(`back-references to names still in file: ${[...backRefs].sort().join(', ')}`);
  }

  for (const n of movedNames) {
    if (!nameIndex.has(n)) errors.push(`unknown name: ${n}`);
  }

  return { ok: errors.length === 0, errors, movedItems };
}

function exportSuffixForMoved(movedItems) {
  const needExport = [];
  for (const it of movedItems) {
    for (const n of it.names) {
      if (!it.exported && !it.text.match(new RegExp(`\\bexport\\b[\\s\\S]*\\b${n}\\b`))) {
        needExport.push(n);
      }
    }
  }
  const unique = [...new Set(needExport)].sort();
  if (!unique.length) return '';
  return `\nexport { ${unique.join(', ')} };\n`;
}

function buildNewModuleContent(originalText, filePath, modulePath, movedItems, allItems) {
  const fileDir = path.dirname(path.resolve(filePath));
  const moduleDir = path.dirname(path.resolve(modulePath));
  const parts = [];
  const spdx = spdxLine(originalText);
  if (spdx) parts.push(spdx, '');
  const importLines = buildFilteredImports(movedItems, allItems, fileDir, moduleDir);
  if (importLines.length) {
    parts.push(...importLines, '');
  }
  for (const it of movedItems) parts.push(it.text);
  const body = parts.join('\n');
  const suffix = exportSuffixForMoved(movedItems);
  if (suffix && !body.endsWith('\n')) return body + suffix;
  return body + suffix;
}

function relativeImportPath(fromFile, toModule) {
  const fromDir = path.dirname(path.resolve(fromFile));
  const toPath = path.resolve(toModule);
  let rel = path.relative(fromDir, toPath);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel.split(path.sep).join('/');
}

function gapTextSkippingRemoved(text, items, remove, gapStart, gapEnd) {
  let out = '';
  let pos = gapStart;
  for (const it of items) {
    if (it.start >= gapEnd) break;
    if (it.end <= gapStart) continue;
    if (remove.has(it.index)) {
      out += text.slice(pos, it.start);
      pos = it.end;
    }
  }
  out += text.slice(pos, gapEnd);
  return out;
}

function removeItemsPreservingGaps(text, items, removedIndices) {
  const remove = new Set(removedIndices);
  const kept = items.filter((it) => !remove.has(it.index));
  if (kept.length === 0) {
    let end = text.length;
    while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
    return text.slice(0, items[0]?.start ?? 0) + text.slice(end);
  }
  let out = gapTextSkippingRemoved(text, items, remove, 0, kept[0].start);
  for (let k = 0; k < kept.length; k++) {
    out += kept[k].text;
    const next = kept[k + 1];
    if (next) {
      out += gapTextSkippingRemoved(text, items, remove, kept[k].end, next.start);
    } else {
      out += gapTextSkippingRemoved(text, items, remove, kept[k].end, text.length);
    }
  }
  return out;
}

function insertAfterLastImport(text, items, insertLine) {
  let lastImportItem = null;
  for (const it of items) {
    if (it.kind === 'import') lastImportItem = it;
  }
  if (!lastImportItem) {
    const spdx = spdxLine(text);
    if (spdx) {
      const nl = text.indexOf('\n');
      const pos = nl === -1 ? text.length : nl + 1;
      return text.slice(0, pos) + insertLine + (text[pos] === '\n' ? '' : '\n') + text.slice(pos);
    }
    return insertLine + '\n' + text;
  }
  const at = lastImportItem.end;
  return text.slice(0, at) + insertLine + text.slice(at);
}

function buildRewrittenFile(originalText, filePath, modulePath, allItems, movedItems, movedNames) {
  const removed = movedItems.map((it) => it.index);
  let text = removeItemsPreservingGaps(originalText, allItems, removed);
  const rescanned = scanModule(text);

  const sortedMoved = [...movedNames].sort();
  const rel = relativeImportPath(filePath, modulePath);
  const importLine = `import { ${sortedMoved.join(', ')} } from '${rel}';\n`;

  text = insertAfterLastImport(text, rescanned.items, importLine);

  const exportedBefore = new Set();
  for (const it of movedItems) {
    if (it.exported) {
      for (const n of it.names) exportedBefore.add(n);
    }
  }
  const reexports = [...exportedBefore].sort().map(
    (n) => `export { ${n} } from '${rel}';`,
  );
  if (reexports.length) {
    if (!text.endsWith('\n')) text += '\n';
    text += reexports.join('\n') + '\n';
  }
  return text;
}

function nodeCheck(filePath) {
  const r = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  return { ok: r.status === 0, stderr: r.stderr || r.stdout || '' };
}

function isIdentifierChar(ch, first) {
  if (ch === '$' || ch === '_') return true;
  const code = ch.charCodeAt(0);
  if (first) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

/** Top-level import and export-from spans: identifier tokens inside these are not uses. */
function importExportDeclarationRanges(text) {
  const ranges = [];
  try {
    const ast = parse(text, {
      ...ACORN_TOKENIZE_OPTS,
      ranges: true,
    });
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration') {
        ranges.push([node.start, node.end]);
      } else if (node.type === 'ExportNamedDeclaration' && node.source != null) {
        ranges.push([node.start, node.end]);
      } else if (node.type === 'ExportAllDeclaration') {
        ranges.push([node.start, node.end]);
      }
    }
  } catch {
    // ignore
  }
  return ranges;
}

function offsetInsideRanges(offset, ranges) {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

/** Acorn tokenizer pass: name tokens not after `.`/`?.` and not object-literal keys (`name:` inside braces). */
export function acornIdentifierTokens(text) {
  const all = [];
  try {
    const tokIter = tokenizer(text, ACORN_TOKENIZE_OPTS);
    let cur;
    while ((cur = tokIter.getToken()).type !== tokTypes.eof) {
      all.push(cur);
    }
  } catch {
    return [];
  }

  const skipRanges = importExportDeclarationRanges(text);
  const out = [];
  let braceDepth = 0;
  for (let i = 0; i < all.length; i++) {
    const cur = all[i];
    if (cur.type === tokTypes.braceL) braceDepth++;
    else if (cur.type === tokTypes.braceR) braceDepth--;

    if (cur.type !== tokTypes.name) continue;
    if (offsetInsideRanges(cur.start, skipRanges)) continue;

    const prev = i > 0 ? all[i - 1] : null;
    if (prev && (prev.type === tokTypes.dot || prev.type === tokTypes.questionDot)) continue;

    const next = i + 1 < all.length ? all[i + 1] : null;
    if (next && next.type === tokTypes.colon && braceDepth > 0) continue;

    out.push({ name: cur.value, index: cur.start });
  }
  return out;
}

/** Regex-style pass: identifier-like tokens not immediately preceded by `.` (outside comments/strings). */
export function regexIdentifierTokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (q === '`' && text[i] === '$' && text[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < text.length && depth > 0) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') depth--;
            i++;
          }
          continue;
        }
        if (text[i] === q) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '.' && text[i + 1] === '.' && text[i + 2] === '.') {
      i += 3;
      continue;
    }
    if (isIdentifierChar(ch, true)) {
      const prev = i > 0 ? text[i - 1] : '';
      if (prev === '.') {
        i++;
        while (i < text.length && isIdentifierChar(text[i], false)) i++;
        continue;
      }
      const start = i;
      i++;
      while (i < text.length && isIdentifierChar(text[i], false)) i++;
      out.push({ name: text.slice(start, i), index: start });
      continue;
    }
    i++;
  }
  return out;
}

function declaredNamesRegex(text) {
  const declared = new Set();
  const declRe = /\b(?:const|let|var|function|class|catch|import)\b[^;]*?(?=[;\n]|$)/g;
  let block;
  while ((block = declRe.exec(text)) !== null) {
    const chunk = block[0];
    const importFrom = chunk.match(/\bimport\s+(?:[\w$*{}\s,]+)\s+from\b/);
    if (importFrom) {
      const brace = chunk.match(/\{([^}]+)\}/);
      if (brace) {
        for (const part of brace[1].split(',')) {
          const as = part.trim().match(/^(\w+)\s+as\s+(\w+)$/);
          if (as) declared.add(as[2]);
          else {
            const id = part.trim().match(/^(\w+)$/);
            if (id) declared.add(id[1]);
          }
        }
      }
      const def = chunk.match(/\bimport\s+(\w+)\s*,/);
      if (def) declared.add(def[1]);
      const onlyDef = chunk.match(/\bimport\s+(\w+)\s+from\b/);
      if (onlyDef && !chunk.includes('{')) declared.add(onlyDef[1]);
      const ns = chunk.match(/\*\s+as\s+(\w+)/);
      if (ns) declared.add(ns[1]);
    }
    const fn = chunk.match(/\bfunction\s*\*?\s*(\w+)/);
    if (fn) declared.add(fn[1]);
    const cl = chunk.match(/\bclass\s+(\w+)/);
    if (cl) declared.add(cl[1]);
    const catchP = chunk.match(/\bcatch\s*\(\s*(\w+)/);
    if (catchP) declared.add(catchP[1]);
    for (const m of chunk.matchAll(/\b(?:const|let|var)\s+([^;=]+)/g)) {
      const lhs = m[1];
      for (const part of lhs.split(',')) {
        const bit = part.trim();
        const simple = bit.match(/^(\w+)$/);
        if (simple) declared.add(simple[1]);
        const renamed = bit.match(/^\{[^}]+\}$|^\[[^\]]+\]$/);
        if (renamed) {
          for (const id of bit.matchAll(/(?<![:.])(\w+)(?=\s*[,}\]]|$)/g)) declared.add(id[1]);
          for (const rest of bit.matchAll(/\.\.\.(\w+)/g)) declared.add(rest[1]);
        }
      }
    }
    for (const m of chunk.matchAll(/\(([^)]*)\)\s*=>/g)) {
      for (const id of m[1].matchAll(/\b(\w+)\b/g)) declared.add(id[1]);
      for (const rest of m[1].matchAll(/\.\.\.(\w+)/g)) declared.add(rest[1]);
    }
  }
  for (const m of text.matchAll(/\bfunction\s+\w*\s*\(([^)]*)\)/g)) {
    for (const id of m[1].matchAll(/\b(\w+)\b/g)) declared.add(id[1]);
    for (const rest of m[1].matchAll(/\.\.\.(\w+)/g)) declared.add(rest[1]);
  }
  return declared;
}

function propertyKeyPositions(text) {
  const keys = new Set();
  for (const m of text.matchAll(/(\w+)\s*:(?!=)/g)) {
    const name = m[1];
    const idx = m.index ?? 0;
    const before = text.slice(Math.max(0, idx - 3), idx);
    if (before.endsWith('?.')) continue;
    if (text[idx - 1] === '.') continue;
    keys.add(name);
  }
  for (const m of text.matchAll(/['"](\w+)['"]\s*:/g)) keys.add(m[1]);
  return keys;
}

/** Names that look free (second pass), not counting obvious declarations/keys. */
export function possiblyUnresolvedNames(text) {
  const declared = declaredNamesRegex(text);
  const propKeys = propertyKeyPositions(text);
  const unresolved = new Set();
  for (const { name, index } of acornIdentifierTokens(text)) {
    if (JS_KEYWORDS.has(name)) continue;
    if (BUILTIN_GLOBALS.has(name)) continue;
    if (declared.has(name)) continue;
    if (propKeys.has(name)) {
      const after = text.slice(index + name.length).trimStart();
      if (after.startsWith(':')) continue;
    }
    const ctxBefore = text.slice(Math.max(0, index - 8), index);
    if (/\.\.\.\s*$/.test(ctxBefore)) continue;
    if (/\b(?:const|let|var|function|class|catch)\s+$/.test(ctxBefore)) continue;
    unresolved.add(name);
  }
  return unresolved;
}

function importBindingNames(items) {
  const map = new Map();
  for (const it of items) {
    if (it.kind !== 'import') continue;
    const parsed = parseImportSpecifiers(it.text);
    for (const b of parsed.bindings) map.set(b.local, parsed.source);
  }
  return map;
}

function moduleDeclaresOrImports(name, modText, modScan) {
  for (const it of modScan.items) {
    if (it.names.includes(name)) return true;
  }
  return declaredNamesRegex(modText).has(name);
}

export function checkUnresolvedImportsForMove(originalText, moduleText, movedItems) {
  const issues = [];
  const origScan = scanModule(originalText);
  const modScan = scanModule(moduleText);
  const origImports = importBindingNames(origScan.items);
  const importNames = collectFileImportNames(origScan.items);

  for (const it of movedItems) {
    for (const use of it.uses) {
      if (!importNames.has(use)) continue;
      if (moduleDeclaresOrImports(use, moduleText, modScan)) continue;
      issues.push(`moved item missing import for ${use} (used by ${it.names.join(',') || it.index})`);
    }
  }

  for (const name of possiblyUnresolvedNames(moduleText)) {
    if (!origImports.has(name)) continue;
    if (moduleDeclaresOrImports(name, moduleText, modScan)) continue;
    issues.push(`possibly unresolved import ${name} in new module`);
  }

  return issues;
}

export function smokeImportModules(paths, options = {}) {
  const { timeoutMs = 20_000, allowProcessExit = false } = options;
  const issues = [];
  for (const absPath of paths) {
    const url = pathToFileURL(path.resolve(absPath)).href;
    const script = `
const allowExit = ${allowProcessExit ? 'true' : 'false'};
const deadline = Date.now() + ${timeoutMs};
let exited = false;
const origExit = process.exit;
process.exit = (code) => {
  exited = true;
  if (!allowExit) origExit(code ?? 0);
};
const fail = (msg) => { console.error(msg); origExit(1); };
const t = setTimeout(() => fail('smoke import timeout'), ${timeoutMs});
try {
  await import(${JSON.stringify(url)});
} catch (e) {
  if (e instanceof SyntaxError || e instanceof ReferenceError) fail(String(e));
  else if (e?.name === 'SyntaxError' || e?.name === 'ReferenceError') fail(String(e));
} finally {
  clearTimeout(t);
  process.exit = origExit;
}
if (!allowExit && exited) fail('process.exit during load');
`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: timeoutMs + 5000,
      cwd: path.dirname(absPath),
    });
    if (r.status !== 0) {
      issues.push(`smoke import failed for ${absPath}: ${(r.stderr || r.stdout || '').trim()}`);
    }
  }
  return issues;
}

function exportNamesFromScan(scan) {
  return new Set(scan.exports);
}

export function verifyMove(filePath, modulePath, originalFilePath, options = {}) {
  const issues = [];
  const originalText = readText(originalFilePath);
  const origScan = scanModule(originalText);
  const fileText = fs.existsSync(filePath) ? readText(filePath) : '';
  const modText = fs.existsSync(modulePath) ? readText(modulePath) : '';

  const modScan = modText ? scanModule(modText) : { items: [], exports: [] };
  const fileScan = fileText ? scanModule(fileText) : { items: [], exports: [] };

  const modBodyItems = modScan.items.filter((it) => {
    if (it.kind === 'import') return false;
    const t = it.text.trimStart();
    if (/^export\s+\{[^}]+\}\s*;\s*$/.test(t)) return false;
    return true;
  });

  const movedFromOrig = [];
  const usedOrig = new Set();
  for (const mit of modBodyItems) {
    const match = origScan.items.find((o) => o.text === mit.text && !usedOrig.has(o.index));
    if (match) {
      movedFromOrig.push(match);
      usedOrig.add(match.index);
    }
  }
  movedFromOrig.sort((a, b) => a.index - b.index);

  const remainingFromOrig = origScan.items.filter((o) => !usedOrig.has(o.index));

  const expectedMovedBlob = movedFromOrig.map((it) => it.text).join('');
  const modBlob = modBodyItems.map((it) => it.text).join('');
  if (modBlob !== expectedMovedBlob) {
    issues.push('moved item texts in module do not match original byte-for-byte');
  }

  const isReexportBridge = (t) => /^export\s+\{[^}]+\}\s+from\s+['"]/.test(t.trimStart());
  const nonBridge = (it) => it.kind !== 'import' && !isReexportBridge(it.text);
  const origNonBridge = origScan.items.filter(nonBridge);
  const recomposed2 = [...remainingFromOrig, ...movedFromOrig]
    .sort((a, b) => a.index - b.index)
    .filter(nonBridge)
    .map((it) => it.text)
    .join('');
  const origBodies = origNonBridge.map((it) => it.text).join('');
  if (recomposed2 !== origBodies) {
    issues.push('remaining file plus moved items (ignoring import/re-export bridges) does not equal original');
  }

  if (fs.existsSync(filePath)) {
    const chk = nodeCheck(filePath);
    if (!chk.ok) issues.push(`node --check failed on file: ${chk.stderr.trim()}`);
  } else {
    issues.push('file path does not exist');
  }
  if (fs.existsSync(modulePath)) {
    const chk = nodeCheck(modulePath);
    if (!chk.ok) issues.push(`node --check failed on module: ${chk.stderr.trim()}`);
  } else {
    issues.push('module path does not exist');
  }

  const origExports = exportNamesFromScan(origScan);
  const newExports = exportNamesFromScan(fileScan);
  for (const ex of origExports) {
    if (!newExports.has(ex)) issues.push(`missing export in file after move: ${ex}`);
  }

  const fileRel = relativeImportPath(modulePath, filePath);
  for (const it of modScan.items) {
    if (it.kind === 'import' && it.text.includes(fileRel)) {
      issues.push('module imports file (cycle)');
    }
  }

  if (movedFromOrig.length) {
    issues.push(...checkUnresolvedImportsForMove(originalText, modText, movedFromOrig));
    const fileUnresolved = possiblyUnresolvedNames(fileText);
    const origImports = importBindingNames(origScan.items);
    for (const name of fileUnresolved) {
      if (!origImports.has(name)) continue;
      if (moduleDeclaresOrImports(name, fileText, fileScan)) continue;
      issues.push(`possibly unresolved import ${name} in rewritten file`);
    }
  }

  if (!options.noSmoke && fs.existsSync(filePath) && fs.existsSync(modulePath)) {
    issues.push(...smokeImportModules([modulePath, filePath], {
      allowProcessExit: options.noSmoke,
    }));
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function moveItems(filePath, modulePath, names, options = {}) {
  const { dryRun = false, allowBackReferences = false, noSmoke = false } = options;
  const originalText = readText(filePath);
  const { items } = scanModule(originalText);
  const nameList = [...names].sort();
  const movedNames = new Set(nameList);

  const validation = validateMove(items, originalText, movedNames, allowBackReferences);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, wrote: false };
  }

  const movedItems = validation.movedItems;
  const moduleContent = buildNewModuleContent(originalText, filePath, modulePath, movedItems, items);
  const newFileContent = buildRewrittenFile(
    originalText,
    filePath,
    modulePath,
    items,
    movedItems,
    nameList,
  );

  const verifyDir = path.join(path.dirname(filePath), '.split-module-verify');
  const tmpFile = path.join(verifyDir, `file-${path.basename(filePath)}`);
  const tmpMod = path.join(verifyDir, `mod-${path.basename(modulePath)}`);

  if (!dryRun) {
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  }

  try {
    fs.mkdirSync(verifyDir, { recursive: true });
    fs.writeFileSync(tmpMod, moduleContent, 'utf8');
    fs.writeFileSync(tmpFile, newFileContent, 'utf8');

    const unresolved = checkUnresolvedImportsForMove(originalText, moduleContent, movedItems);
    if (unresolved.length) {
      return { ok: false, errors: unresolved, wrote: false };
    }

    if (!noSmoke) {
      const smoke = smokeImportModules([tmpMod, tmpFile], { allowProcessExit: false });
      if (smoke.length) {
        return { ok: false, errors: smoke, wrote: false };
      }
    }

    const verify = verifyMove(tmpFile, tmpMod, filePath, { noSmoke });
    if (!verify.ok) {
      return { ok: false, errors: verify.issues, wrote: false };
    }
    if (dryRun) {
      return { ok: true, errors: [], wrote: false, dryRun: true };
    }
    fs.writeFileSync(modulePath, moduleContent, 'utf8');
    fs.writeFileSync(filePath, newFileContent, 'utf8');
    return { ok: true, errors: [], wrote: true };
  } finally {
    for (const p of [tmpFile, tmpMod]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }
}

function formatPlanHuman(plan) {
  const lines = [];
  lines.push(`Plan: ${plan.filePath} (${plan.itemCount} items)`);
  for (const layer of plan.layers) {
    for (const group of layer) {
      const cycle = group.cycle ? ' [cycle]' : '';
      lines.push(`  layer ${group.layer}${cycle}:`);
      for (const it of group.items) {
        const flags = it.cannotMoveAlone.length ? ` cannotMoveAlone=${it.cannotMoveAlone.join(',')}` : '';
        lines.push(
          `    ${it.label} lines ${it.startLine}-${it.endLine} size=${it.size}${flags}`,
        );
      }
    }
  }
  if (plan.suggestions.length) {
    lines.push('Suggested modules:');
    for (const s of plan.suggestions) {
      lines.push(`  layer ${s.layer} -> ${s.suggestedModule}: ${s.names.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = [...argv];
  const cmd = args.shift();
  if (!cmd) return { error: 'missing command' };
  if (cmd === 'plan') {
    const json = args.includes('--json');
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) return { error: 'missing FILE' };
    return { cmd, file, json };
  }
  if (cmd === 'move') {
    const dryRun = args.includes('--dry-run');
    const noSmoke = args.includes('--no-smoke');
    const allowBack = args.includes('--allow-back-references');
    const toIdx = args.indexOf('--to');
    const namesIdx = args.indexOf('--names');
    const file = args[0] && !args[0].startsWith('--') ? args[0] : null;
    if (!file || toIdx < 0 || namesIdx < 0) return { error: 'usage: move FILE --to MODULE --names a,b' };
    const modulePath = args[toIdx + 1];
    const names = args[namesIdx + 1].split(',').map((s) => s.trim()).filter(Boolean);
    return { cmd, file, modulePath, names, dryRun, allowBack, noSmoke };
  }
  if (cmd === 'verify') {
    const toIdx = args.indexOf('--to');
    const origIdx = args.indexOf('--original');
    const file = args[0] && !args[0].startsWith('--') ? args[0] : null;
    if (!file || toIdx < 0 || origIdx < 0) return { error: 'usage: verify FILE --to MODULE --original ORIG' };
    return {
      cmd,
      file,
      modulePath: args[toIdx + 1],
      original: args[origIdx + 1],
    };
  }
  return { error: `unknown command ${cmd}` };
}

function isCliMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isCliMain()) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(1);
  }
  if (parsed.cmd === 'plan') {
    const plan = planSplit(parsed.file);
    if (parsed.json) console.log(JSON.stringify(plan, null, 2));
    else console.log(formatPlanHuman(plan));
    process.exit(0);
  }
  if (parsed.cmd === 'move') {
    const result = moveItems(parsed.file, parsed.modulePath, parsed.names, {
      dryRun: parsed.dryRun,
      allowBackReferences: parsed.allowBack,
      noSmoke: parsed.noSmoke,
    });
    if (!result.ok) {
      console.error(result.errors.join('\n'));
      process.exit(1);
    }
    process.exit(0);
  }
  if (parsed.cmd === 'verify') {
    const result = verifyMove(parsed.file, parsed.modulePath, parsed.original);
    if (!result.ok) {
      console.error(result.issues.join('\n'));
      process.exit(1);
    }
    process.exit(0);
  }
}
