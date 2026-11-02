// SPDX-License-Identifier: Apache-2.0
// Scanner for splitting tools/swarm.mjs into top-level items (lossless spans).

import { parse } from 'acorn';

const lineIndexCache = new Map();

function buildLineIndex(text) {
  let cached = lineIndexCache.get(text);
  if (cached) return cached;
  const lines = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines.push(i + 1);
  }
  lineIndexCache.set(text, lines);
  return lines;
}

function lineAtFromIndex(lineIndex, index) {
  let lo = 0;
  let hi = lineIndex.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineIndex[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function extendStartWithComments(text, start, minPos) {
  let s = start;
  while (s > minPos) {
    let p = s - 1;
    while (p >= minPos && (text[p] === ' ' || text[p] === '\t')) p--;
    if (p >= minPos && text[p] === '\n') {
      const lineEnd = p;
      let lineStart = p;
      while (lineStart > minPos && text[lineStart - 1] !== '\n') lineStart--;
      const line = text.slice(lineStart, lineEnd).trim();
      if (line === '') break;
      if (line.startsWith('//')) {
        s = lineStart;
        continue;
      }
      if (line.endsWith('*/')) {
        let search = lineStart;
        while (search > minPos) {
          const prevNl = text.lastIndexOf('\n', search - 1);
          const chunk = text.slice(prevNl + 1, search);
          if (chunk.includes('/*')) {
            s = prevNl + 1;
            break;
          }
          if (prevNl < minPos) break;
          search = prevNl;
        }
        if (s !== start) continue;
      }
      break;
    }
    if (p >= minPos && text[p] !== '\n') break;
    s = p + 1;
  }
  return s;
}

function extendEndNewline(text, end) {
  if (end < text.length && text.charCodeAt(end) === 10) return end + 1;
  if (end < text.length && text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10) return end + 2;
  return end;
}

function skipGap(text, pos) {
  while (pos < text.length) {
    const lineStart = pos;
    while (pos < text.length && text.charCodeAt(pos) !== 10) pos++;
    const line = text.slice(lineStart, pos).trim();
    if (line !== '') return lineStart;
    if (pos < text.length) pos++;
    else break;
  }
  return pos;
}

function parseSource(text) {
  const comments = [];
  const base = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    ranges: true,
    onComment: comments,
  };
  try {
    const ast = parse(text, { ...base, sourceType: 'module' });
    return { ast, comments };
  } catch (err) {
    if (!/^Export '[^']+' is not defined/.test(String(err.message))) throw err;
    comments.length = 0;
    const ast = parse(text, {
      ...base,
      sourceType: 'script',
      allowImportExportEverywhere: true,
    });
    return { ast, comments };
  }
}

function topLevelSpans(text, body) {
  const spans = [];
  let prevEnd = 0;
  for (let i = 0; i < body.length; i++) {
    const node = body[i];
    const minStart = prevEnd;
    const pos = skipGap(text, prevEnd);
    let rawStart = extendStartWithComments(text, pos, minStart);
    if (spans.length === 0 && text.startsWith('#!') && rawStart > 0) rawStart = 0;
    const rawEnd = extendEndNewline(text, node.end);
    spans.push({ start: rawStart, end: rawEnd, node });
    prevEnd = rawEnd;
  }
  return spans;
}

function collectDeclarationNames(pattern, names) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      names.push(pattern.name);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'Property') {
          if (prop.value.type === 'AssignmentPattern') {
            collectDeclarationNames(prop.value.left, names);
          } else {
            collectDeclarationNames(prop.value, names);
          }
        } else if (prop.type === 'RestElement') {
          collectDeclarationNames(prop.argument, names);
        }
      }
      break;
    case 'ArrayPattern':
      for (const el of pattern.elements) {
        if (!el) continue;
        if (el.type === 'RestElement') collectDeclarationNames(el.argument, names);
        else if (el.type === 'AssignmentPattern') collectDeclarationNames(el.left, names);
        else collectDeclarationNames(el, names);
      }
      break;
    case 'AssignmentPattern':
      collectDeclarationNames(pattern.left, names);
      break;
    case 'RestElement':
      collectDeclarationNames(pattern.argument, names);
      break;
    default:
      break;
  }
}

function parseItemMetaFromNode(node) {
  const names = [];
  let exported = false;
  let kind = 'expression';
  let inner = node;

  if (node.type === 'ExportDefaultDeclaration') {
    exported = true;
    kind = 'export';
    if (node.declaration?.type === 'Identifier') return { kind, names, exported: true };
    inner = node.declaration;
  } else if (node.type === 'ExportNamedDeclaration') {
    exported = true;
    if (node.declaration) {
      inner = node.declaration;
    } else if (node.source) {
      kind = 'export';
      for (const spec of node.specifiers) {
        if (spec.exported.type === 'Identifier') names.push(spec.exported.name);
        else if (spec.local.type === 'Identifier') names.push(spec.local.name);
      }
      return { kind, names, exported: true };
    } else {
      kind = 'export';
      for (const spec of node.specifiers) {
        if (spec.exported.type === 'Identifier') names.push(spec.exported.name);
      }
      return { kind, names, exported: true };
    }
  } else if (node.type === 'ExportAllDeclaration') {
    return { kind: 'export', names, exported: true };
  }

  if (inner.type === 'ImportDeclaration') {
    kind = 'import';
    for (const spec of inner.specifiers) {
      if (spec.local.type === 'Identifier') names.push(spec.local.name);
    }
    return { kind, names, exported: false };
  }

  if (inner.type === 'FunctionDeclaration') {
    kind = 'function';
    if (inner.id) names.push(inner.id.name);
    return { kind, names, exported };
  }

  if (inner.type === 'ClassDeclaration') {
    kind = 'class';
    if (inner.id) names.push(inner.id.name);
    return { kind, names, exported };
  }

  if (inner.type === 'VariableDeclaration') {
    kind = 'declaration';
    for (const decl of inner.declarations) {
      collectDeclarationNames(decl.id, names);
    }
    return { kind, names, exported };
  }

  return { kind, names, exported };
}

function createScope(parent) {
  return {
    parent,
    lexical: new Set(),
    var: new Set(),
    hoistedFuncs: new Set(),
  };
}

function scopeLookup(scope, name) {
  for (let s = scope; s; s = s.parent) {
    if (s.lexical.has(name) || s.var.has(name) || s.hoistedFuncs.has(name)) return true;
  }
  return false;
}

function bindLexical(scope, name) {
  scope.lexical.add(name);
}

function bindVar(scope, name) {
  let s = scope;
  while (s) {
    if (s.var) {
      s.var.add(name);
      return;
    }
    s = s.parent;
  }
}

function collectPatternDefaultUses(pattern, uses, scope) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'AssignmentPattern':
      collectUsesFromNode(pattern.right, uses, scope);
      collectPatternDefaultUses(pattern.left, uses, scope);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'Property') {
          if (prop.value.type === 'AssignmentPattern') {
            collectUsesFromNode(prop.value.right, uses, scope);
            collectPatternDefaultUses(prop.value.left, uses, scope);
          } else {
            collectPatternDefaultUses(prop.value, uses, scope);
          }
        } else if (prop.type === 'RestElement') {
          collectPatternDefaultUses(prop.argument, uses, scope);
        }
      }
      break;
    case 'ArrayPattern':
      for (const el of pattern.elements) {
        if (!el) continue;
        collectPatternDefaultUses(el, uses, scope);
      }
      break;
    default:
      break;
  }
}

function bindPattern(scope, pattern, kind) {
  if (!pattern) return;
  const bind = kind === 'var' ? (n) => bindVar(scope, n) : (n) => bindLexical(scope, n);
  switch (pattern.type) {
    case 'Identifier':
      bind(pattern.name);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'Property') {
          if (prop.value.type === 'AssignmentPattern') bindPattern(scope, prop.value.left, kind);
          else bindPattern(scope, prop.value, kind);
        } else if (prop.type === 'RestElement') {
          bindPattern(scope, prop.argument, kind);
        }
      }
      break;
    case 'ArrayPattern':
      for (const el of pattern.elements) {
        if (!el) continue;
        if (el.type === 'RestElement') bindPattern(scope, el.argument, kind);
        else if (el.type === 'AssignmentPattern') bindPattern(scope, el.left, kind);
        else bindPattern(scope, el, kind);
      }
      break;
    case 'AssignmentPattern':
      bindPattern(scope, pattern.left, kind);
      break;
    case 'RestElement':
      bindPattern(scope, pattern.argument, kind);
      break;
    default:
      break;
  }
}

function hoistFunctionScopeBody(scope, body) {
  if (!body) return;
  if (body.type !== 'BlockStatement') return;
  for (const stmt of body.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      scope.hoistedFuncs.add(stmt.id.name);
    } else if (stmt.type === 'VariableDeclaration' && stmt.kind === 'var') {
      for (const decl of stmt.declarations) {
        bindPattern(scope, decl.id, 'var');
      }
    }
  }
}

function collectUsesFromNode(node, uses, scope) {
  if (!node || typeof node !== 'object') return;

  switch (node.type) {
    case 'Program':
      for (const stmt of node.body) collectUsesFromNode(stmt, uses, scope);
      return;

    case 'BlockStatement': {
      const blockScope = createScope(scope);
      hoistFunctionScopeBody(blockScope, node);
      for (const stmt of node.body) collectUsesFromNode(stmt, uses, blockScope);
      return;
    }

    case 'FunctionDeclaration': {
      const fnScope = createScope(scope);
      if (node.id) bindLexical(fnScope, node.id.name);
      hoistFunctionScopeBody(fnScope, node.body);
      for (const param of node.params) {
        collectPatternDefaultUses(param, uses, fnScope);
        bindPattern(fnScope, param, 'lexical');
      }
      collectUsesFromNode(node.body, uses, fnScope);
      return;
    }

    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const fnScope = createScope(scope);
      if (node.id) bindLexical(fnScope, node.id.name);
      hoistFunctionScopeBody(fnScope, node.body);
      for (const param of node.params) {
        collectPatternDefaultUses(param, uses, fnScope);
        bindPattern(fnScope, param, 'lexical');
      }
      if (node.body.type === 'BlockStatement') collectUsesFromNode(node.body, uses, fnScope);
      else collectUsesFromNode(node.body, uses, fnScope);
      return;
    }

    case 'ClassDeclaration': {
      const classScope = createScope(scope);
      if (node.id) bindLexical(classScope, node.id.name);
      if (node.superClass) collectUsesFromNode(node.superClass, uses, classScope);
      collectClassBody(node.body, uses, classScope);
      return;
    }

    case 'ClassExpression': {
      const classScope = createScope(scope);
      if (node.id) bindLexical(classScope, node.id.name);
      if (node.superClass) collectUsesFromNode(node.superClass, uses, classScope);
      collectClassBody(node.body, uses, classScope);
      return;
    }

    case 'VariableDeclaration': {
      const kind = node.kind;
      for (const decl of node.declarations) {
        if (kind === 'var') bindPattern(scope, decl.id, 'var');
        else bindPattern(scope, decl.id, 'lexical');
        if (decl.init) collectUsesFromNode(decl.init, uses, scope);
      }
      return;
    }

    case 'ImportDeclaration':
      for (const spec of node.specifiers) {
        if (spec.local.type === 'Identifier') bindLexical(scope, spec.local.name);
      }
      return;

    case 'ExportNamedDeclaration':
      if (node.declaration) {
        collectUsesFromNode(node.declaration, uses, scope);
      } else {
        for (const spec of node.specifiers) {
          if (spec.local.type === 'Identifier' && !scopeLookup(scope, spec.local.name)) {
            uses.add(spec.local.name);
          }
        }
      }
      return;

    case 'ExportDefaultDeclaration':
      collectUsesFromNode(node.declaration, uses, scope);
      return;

    case 'ExportAllDeclaration':
      return;

    case 'CatchClause': {
      const catchScope = createScope(scope);
      if (node.param) bindPattern(catchScope, node.param, 'lexical');
      collectUsesFromNode(node.body, uses, catchScope);
      return;
    }

    case 'ForStatement': {
      const forScope = createScope(scope);
      if (node.init) {
        if (node.init.type === 'VariableDeclaration') {
          const kind = node.init.kind;
          for (const decl of node.init.declarations) {
            if (kind === 'var') bindPattern(forScope, decl.id, 'var');
            else bindPattern(forScope, decl.id, 'lexical');
            if (decl.init) collectUsesFromNode(decl.init, uses, forScope);
          }
        } else {
          collectUsesFromNode(node.init, uses, forScope);
        }
      }
      if (node.test) collectUsesFromNode(node.test, uses, forScope);
      if (node.update) collectUsesFromNode(node.update, uses, forScope);
      collectUsesFromNode(node.body, uses, forScope);
      return;
    }

    case 'ForInStatement':
    case 'ForOfStatement': {
      const forScope = createScope(scope);
      if (node.left.type === 'VariableDeclaration') {
        const kind = node.left.kind;
        for (const decl of node.left.declarations) {
          if (kind === 'var') bindPattern(forScope, decl.id, 'var');
          else bindPattern(forScope, decl.id, 'lexical');
          if (decl.init) collectUsesFromNode(decl.init, uses, forScope);
        }
      } else {
        bindPattern(forScope, node.left, 'lexical');
      }
      collectUsesFromNode(node.right, uses, forScope);
      collectUsesFromNode(node.body, uses, forScope);
      return;
    }

    case 'LabeledStatement':
      collectUsesFromNode(node.body, uses, scope);
      return;

    case 'Identifier':
      if (node.name === 'undefined') return;
      if (!scopeLookup(scope, node.name)) uses.add(node.name);
      return;

    case 'MemberExpression':
      collectUsesFromNode(node.object, uses, scope);
      if (node.computed) collectUsesFromNode(node.property, uses, scope);
      return;

    case 'ChainExpression':
      collectUsesFromNode(node.expression, uses, scope);
      return;

    case 'Property': {
      if (node.computed) collectUsesFromNode(node.key, uses, scope);
      if (node.shorthand) {
        if (node.key.type === 'Identifier' && !scopeLookup(scope, node.key.name)) {
          uses.add(node.key.name);
        }
      } else {
        collectUsesFromNode(node.value, uses, scope);
      }
      return;
    }

    case 'AssignmentExpression':
      if (node.left.type === 'MemberExpression') {
        collectUsesFromNode(node.left, uses, scope);
      } else if (node.left.type === 'Identifier') {
        if (!scopeLookup(scope, node.left.name)) uses.add(node.left.name);
      } else if (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') {
        collectAssignmentPatternUses(node.left, uses, scope);
      } else {
        collectUsesFromNode(node.left, uses, scope);
      }
      collectUsesFromNode(node.right, uses, scope);
      return;

    case 'AssignmentPattern':
      bindPattern(scope, node.left, 'lexical');
      collectUsesFromNode(node.right, uses, scope);
      return;

    case 'RestElement':
      bindPattern(scope, node.argument, 'lexical');
      return;

    case 'SpreadElement':
      collectUsesFromNode(node.argument, uses, scope);
      return;

    case 'TaggedTemplateExpression':
      collectUsesFromNode(node.tag, uses, scope);
      collectUsesFromNode(node.quasi, uses, scope);
      return;

    case 'TemplateLiteral':
      for (const expr of node.expressions) collectUsesFromNode(expr, uses, scope);
      return;

    case 'MetaProperty':
      return;

    case 'Super':
    case 'ThisExpression':
      return;

    case 'PrivateIdentifier':
      return;

    case 'ClassBody':
      collectClassBody(node, uses, scope);
      return;

    case 'MethodDefinition':
    case 'PropertyDefinition': {
      if (node.computed) collectUsesFromNode(node.key, uses, scope);
      if (node.value) collectUsesFromNode(node.value, uses, scope);
      return;
    }

    case 'UnaryExpression':
    case 'UpdateExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
      collectUsesFromNode(node.argument, uses, scope);
      return;

    case 'BinaryExpression':
    case 'LogicalExpression':
      collectUsesFromNode(node.left, uses, scope);
      collectUsesFromNode(node.right, uses, scope);
      return;

    case 'ConditionalExpression':
      collectUsesFromNode(node.test, uses, scope);
      collectUsesFromNode(node.consequent, uses, scope);
      collectUsesFromNode(node.alternate, uses, scope);
      return;

    case 'SequenceExpression':
      for (const expr of node.expressions) collectUsesFromNode(expr, uses, scope);
      return;

    case 'CallExpression':
    case 'NewExpression':
      collectUsesFromNode(node.callee, uses, scope);
      for (const arg of node.arguments) {
        if (arg?.type === 'SpreadElement') collectUsesFromNode(arg.argument, uses, scope);
        else collectUsesFromNode(arg, uses, scope);
      }
      return;

    case 'ArrayExpression':
      for (const el of node.elements) {
        if (!el) continue;
        if (el.type === 'SpreadElement') collectUsesFromNode(el.argument, uses, scope);
        else collectUsesFromNode(el, uses, scope);
      }
      return;

    case 'ObjectExpression':
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement') collectUsesFromNode(prop.argument, uses, scope);
        else collectUsesFromNode(prop, uses, scope);
      }
      return;

    case 'ExpressionStatement':
      collectUsesFromNode(node.expression, uses, scope);
      return;

    case 'ReturnStatement':
    case 'ThrowStatement':
      if (node.argument) collectUsesFromNode(node.argument, uses, scope);
      return;

    case 'IfStatement':
      collectUsesFromNode(node.test, uses, scope);
      collectUsesFromNode(node.consequent, uses, scope);
      if (node.alternate) collectUsesFromNode(node.alternate, uses, scope);
      return;

    case 'SwitchStatement':
      collectUsesFromNode(node.discriminant, uses, scope);
      for (const cs of node.cases) {
        for (const c of cs.consequent) collectUsesFromNode(c, uses, scope);
      }
      return;

    case 'TryStatement':
      collectUsesFromNode(node.block, uses, scope);
      if (node.handler) collectUsesFromNode(node.handler, uses, scope);
      if (node.finalizer) collectUsesFromNode(node.finalizer, uses, scope);
      return;

    case 'WhileStatement':
    case 'DoWhileStatement':
      collectUsesFromNode(node.test, uses, scope);
      collectUsesFromNode(node.body, uses, scope);
      return;

    case 'BreakStatement':
    case 'ContinueStatement':
    case 'EmptyStatement':
    case 'DebuggerStatement':
      return;

    case 'Literal':
    case 'RegExpLiteral':
      return;

    default:
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) collectUsesFromNode(c, uses, scope);
        } else if (child && typeof child.type === 'string') {
          collectUsesFromNode(child, uses, scope);
        }
      }
      return;
  }
}

function collectAssignmentPatternUses(pattern, uses, scope) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      return;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'Property') {
          if (prop.value.type === 'AssignmentPattern') {
            collectAssignmentPatternUses(prop.value.left, uses, scope);
            collectUsesFromNode(prop.value.right, uses, scope);
          } else {
            collectAssignmentPatternUses(prop.value, uses, scope);
          }
        } else if (prop.type === 'RestElement') {
          collectAssignmentPatternUses(prop.argument, uses, scope);
        }
      }
      break;
    case 'ArrayPattern':
      for (const el of pattern.elements) {
        if (!el) continue;
        if (el.type === 'RestElement') collectAssignmentPatternUses(el.argument, uses, scope);
        else if (el.type === 'AssignmentPattern') {
          collectAssignmentPatternUses(el.left, uses, scope);
          collectUsesFromNode(el.right, uses, scope);
        } else collectAssignmentPatternUses(el, uses, scope);
      }
      break;
    case 'AssignmentPattern':
      collectAssignmentPatternUses(pattern.left, uses, scope);
      collectUsesFromNode(pattern.right, uses, scope);
      break;
    case 'RestElement':
      collectAssignmentPatternUses(pattern.argument, uses, scope);
      break;
    default:
      collectUsesFromNode(pattern, uses, scope);
      break;
  }
}

function collectClassBody(body, uses, scope) {
  const classScope = createScope(scope);
  for (const el of body.body) {
    if (el.type === 'MethodDefinition') {
      if (el.computed) collectUsesFromNode(el.key, uses, classScope);
      const methodScope = createScope(classScope);
      for (const param of el.value.params) {
        collectPatternDefaultUses(param, uses, methodScope);
        bindPattern(methodScope, param, 'lexical');
      }
      collectUsesFromNode(el.value.body, uses, methodScope);
    } else if (el.type === 'PropertyDefinition') {
      if (el.computed) collectUsesFromNode(el.key, uses, classScope);
      if (el.value) collectUsesFromNode(el.value, uses, classScope);
    } else if (el.type === 'StaticBlock') {
      const staticScope = createScope(classScope);
      for (const stmt of el.body) collectUsesFromNode(stmt, uses, staticScope);
    } else {
      collectUsesFromNode(el, uses, classScope);
    }
  }
}

function collectUsesForStatement(node) {
  const uses = new Set();
  const scope = createScope(null);
  collectUsesFromNode(node, uses, scope);
  const meta = parseItemMetaFromNode(node);
  for (const n of meta.names) uses.delete(n);
  return uses;
}

const opaqueRangeCache = new Map();

function buildOpaqueRanges(text) {
  let cached = opaqueRangeCache.get(text);
  if (cached) return cached;
  const ranges = [];
  try {
    const { ast, comments } = parseSource(text);
    for (const c of comments) {
      ranges.push([c.start, c.end]);
    }
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'Literal' && typeof node.value === 'string') {
        ranges.push([node.start, node.end]);
        return;
      }
      if (node.type === 'RegExpLiteral') {
        ranges.push([node.start, node.end]);
        return;
      }
      if (node.type === 'TemplateLiteral') {
        ranges.push([node.start, node.end]);
        return;
      }
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const c of child) walk(c);
        } else if (child && typeof child.type === 'string') walk(child);
      }
    }
    walk(ast);
  } catch (error) {
    console.error('[tools/split-scan.mjs] parseSource opaque ranges:', error?.message ?? error);
  }
  opaqueRangeCache.set(text, ranges);
  return ranges;
}

/** True when offset sits in whitespace, a comment, string, template, or regex per the parser. */
export function offsetInScannerOpaque(text, offset) {
  const ranges = buildOpaqueRanges(text);
  for (const [start, end] of ranges) {
    if (start <= offset && offset < end) return true;
  }
  return false;
}

function moduleImportsExports(items) {
  const imports = [];
  const exports = [];
  for (const item of items) {
    if (item.kind === 'import') {
      for (const n of item.names) imports.push(n);
    }
    if (item.exported) {
      for (const n of item.names) exports.push(n);
    }
    if (item.kind === 'export') {
      for (const n of item.names) exports.push(n);
    }
  }
  return { imports, exports };
}

export function scanModule(text) {
  const lineIndex = buildLineIndex(text);
  const { ast } = parseSource(text);
  const spans = topLevelSpans(text, ast.body);
  const items = [];
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    const slice = text.slice(span.start, span.end);
    const meta = parseItemMetaFromNode(span.node);
    const uses = collectUsesForStatement(span.node);
    items.push({
      index,
      kind: meta.kind,
      names: meta.names,
      exported: meta.exported,
      start: span.start,
      end: span.end,
      startLine: lineAtFromIndex(lineIndex, span.start),
      endLine: lineAtFromIndex(lineIndex, span.end - 1),
      text: slice,
      uses,
    });
  }
  const order = items.map((_, i) => i);
  const { imports, exports } = moduleImportsExports(items);
  return { items, imports, exports, order };
}

export function topLevelNameIndex(items) {
  const index = new Map();
  for (const item of items) {
    for (const name of item.names) {
      if (!index.has(name)) index.set(name, item);
    }
  }
  return index;
}

export function dependencyGraph(items) {
  const nameIndex = topLevelNameIndex(items);
  const graph = items.map(() => []);
  for (let i = 0; i < items.length; i++) {
    const deps = new Set();
    for (const use of items[i].uses) {
      const decl = nameIndex.get(use);
      if (decl && decl.index !== i) deps.add(use);
    }
    graph[i] = [...deps].sort();
  }
  return graph;
}
