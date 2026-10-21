// SPDX-License-Identifier: Apache-2.0
// Scanner for splitting tools/swarm.mjs into top-level items (lossless spans).

const KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'of',
  'static', 'get', 'set', 'from', 'as',
]);

const REGEX_PREFIX = new Set([
  '(', '[', '{', ',', ';', ':', '?', '!', '~', '+', '-', '*', '%', '^', '|', '&', '<', '>',
  '=', '+=', '-=', '*=', '/=', '%=', '**', '**=', '<<', '>>', '>>>', '<<=', '>>=', '>>>=',
  '&=', '|=', '^=', '&&', '||', '??', '?.', '=>', ')', ']', '}', '++', '--',
]);

// Slow path (large modules): scanModule called lineAt() without a line index (O(file) per item)
// and collectUsesFast re-tokenized every top-level slice (O(file) × item count).

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

function lineAt(text, index, lineIndex) {
  if (lineIndex) return lineAtFromIndex(lineIndex, index);
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function isIdStart(ch) {
  return ch === '$' || ch === '_' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isIdPart(ch) {
  return isIdStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function canRegexAfter(prev) {
  if (!prev) return true;
  if (prev.type === 'keyword') {
    return ['return', 'typeof', 'void', 'delete', 'case', 'in', 'instanceof', 'throw', 'new', 'yield', 'await', 'of'].includes(prev.value);
  }
  if (prev.type === 'punct') {
    return REGEX_PREFIX.has(prev.value);
  }
  return false;
}

function createLexer(text, start = 0) {
  const lineIndex = buildLineIndex(text);
  let pos = start;
  let line = lineAt(text, start, lineIndex);
  let prevSignificant = null;

  function peek(i = 0) {
    return pos + i < text.length ? text[pos + i] : '';
  }

  function advance(n = 1) {
    for (let k = 0; k < n; k++) {
      if (pos < text.length && text.charCodeAt(pos) === 10) line++;
      pos++;
    }
  }

  function skipShebang() {
    if (start === 0 && text.startsWith('#!', start)) {
      while (pos < text.length && text.charCodeAt(pos) !== 10) pos++;
    }
  }

  skipShebang();

  function readIdentifier() {
    const s = pos;
    advance();
    while (pos < text.length && isIdPart(peek())) advance();
    const value = text.slice(s, pos);
    const type = KEYWORDS.has(value) ? 'keyword' : 'identifier';
    return { type, value, start: s, end: pos, line };
  }

  function readString(quote) {
    const s = pos;
    advance();
    while (pos < text.length) {
      const ch = peek();
      if (ch === '\\') {
        advance(2);
        continue;
      }
      if (ch === quote) {
        advance();
        break;
      }
      if (ch === '\n' && quote !== '`') break;
      advance();
    }
    return { type: 'string', value: text.slice(s, pos), start: s, end: pos, line };
  }

  function readTemplate() {
    const s = pos;
    advance();
    let exprDepth = 0;
    let nestedTpl = 0;
    while (pos < text.length) {
      const ch = peek();
      if (ch === '\\') {
        advance(2);
        continue;
      }
      if (ch === '`') {
        if (exprDepth > 0) {
          if (nestedTpl === 0) {
            advance();
            nestedTpl = 1;
            continue;
          }
          nestedTpl--;
          advance();
          continue;
        }
        advance();
        break;
      }
      if (ch === '$' && peek(1) === '{' && nestedTpl === 0) {
        advance(2);
        exprDepth++;
        continue;
      }
      if (ch === '{' && exprDepth > 0) {
        exprDepth++;
        advance();
        continue;
      }
      if (ch === '}' && exprDepth > 0) {
        exprDepth--;
        advance();
        continue;
      }
      advance();
    }
    return { type: 'template', value: text.slice(s, pos), start: s, end: pos, line };
  }

  function readRegex() {
    const s = pos;
    advance();
    while (pos < text.length) {
      const ch = peek();
      if (ch === '\\') {
        advance(2);
        continue;
      }
      if (ch === '/') {
        advance();
        while (pos < text.length && /[a-z]/i.test(peek())) advance();
        break;
      }
      if (ch === '\n') break;
      advance();
    }
    return { type: 'regex', value: text.slice(s, pos), start: s, end: pos, line };
  }

  function readNumber() {
    const s = pos;
    if (peek() === '0' && (peek(1) === 'x' || peek(1) === 'X')) {
      advance(2);
      while (pos < text.length && /[0-9a-fA-F]/.test(peek())) advance();
    } else if (peek() === '0' && (peek(1) === 'o' || peek(1) === 'O')) {
      advance(2);
      while (pos < text.length && /[0-7]/.test(peek())) advance();
    } else if (peek() === '0' && (peek(1) === 'b' || peek(1) === 'B')) {
      advance(2);
      while (pos < text.length && /[01]/.test(peek())) advance();
    } else {
      while (pos < text.length && isDigit(peek())) advance();
      if (peek() === '.' && isDigit(peek(1))) {
        advance();
        while (pos < text.length && isDigit(peek())) advance();
      }
      if (peek() === 'e' || peek() === 'E') {
        advance();
        if (peek() === '+' || peek() === '-') advance();
        while (pos < text.length && isDigit(peek())) advance();
      }
      if (peek() === 'n') advance();
    }
    return { type: 'number', value: text.slice(s, pos), start: s, end: pos, line };
  }

  function readPunct() {
    const s = pos;
    const two = text.slice(pos, pos + 3);
    const pairs = [
      '===', '!==', '>>>', '<<=', '>>=', '>>>=', '**=', '??=', '&&=', '||=',
      '**', '<<', '>>', '&&', '||', '??', '?.', '=>', '==', '!=', '<=', '>=',
      '+=', '-=', '*=', '/=', '%=', '^=', '|=', '&=',
    ];
    for (const p of pairs) {
      if (text.startsWith(p, pos)) {
        advance(p.length);
        const tok = { type: 'punct', value: p, start: s, end: pos, line };
        prevSignificant = tok;
        return tok;
      }
    }
    const ch = peek();
    advance();
    const tok = { type: 'punct', value: ch, start: s, end: pos, line };
    prevSignificant = tok;
    return tok;
  }

  function nextToken(significantOnly = false) {
    while (pos < text.length) {
      const ch = peek();
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v') {
        advance();
        continue;
      }
      if (ch === '/' && peek(1) === '/') {
        while (pos < text.length && text.charCodeAt(pos) !== 10) advance();
        if (!significantOnly) continue;
        advance();
        continue;
      }
      if (ch === '/' && peek(1) === '*') {
        advance(2);
        while (pos < text.length && !(text.charCodeAt(pos) === 42 && text.charCodeAt(pos + 1) === 47)) advance();
        if (pos < text.length) advance(2);
        if (!significantOnly) continue;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const tok = readString(ch);
        prevSignificant = tok;
        return tok;
      }
      if (ch === '`') {
        const tok = readTemplate();
        prevSignificant = tok;
        return tok;
      }
      if (ch === '/' && canRegexAfter(prevSignificant)) {
        const tok = readRegex();
        prevSignificant = tok;
        return tok;
      }
      if (isIdStart(ch)) {
        const tok = readIdentifier();
        prevSignificant = tok;
        return tok;
      }
      if (isDigit(ch) || (ch === '.' && isDigit(peek(1)))) {
        const tok = readNumber();
        prevSignificant = tok;
        return tok;
      }
      return readPunct();
    }
    return { type: 'eof', value: '', start: pos, end: pos, line };
  }

  return {
    get position() { return pos; },
    set position(p) {
      pos = p;
      line = lineAt(text, p, lineIndex);
      prevSignificant = null;
    },
    lineIndex,
    next: nextToken,
    cloneState() { return { pos, line, prevSignificant }; },
    restoreState(st) {
      pos = st.pos;
      line = st.line;
      prevSignificant = st.prevSignificant;
    },
  };
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

function asiForbidden(next) {
  if (!next || next.type === 'eof') return true;
  if (next.type === 'punct') return ['(', '[', '`', '++', '--', '.', '?.'].includes(next.value);
  if (next.type === 'keyword') return ['else', 'catch', 'finally', 'while', 'in', 'of'].includes(next.value);
  return false;
}

function findStatementEnd(lexer, text, start) {
  lexer.position = start;
  let depth = 0;
  let paren = 0;
  let bracket = 0;
  let lastEnd = start;

  const first = lexer.next();
  if (first.type === 'eof') return { end: start, empty: true };
  lastEnd = first.end;

  let isDecl = first.type === 'keyword' && ['class', 'function'].includes(first.value);
  if (first.type === 'keyword' && first.value === 'export') {
    const st = lexer.cloneState();
    const n = lexer.next();
    if (n.type === 'keyword' && (n.value === 'function' || n.value === 'class')) {
      isDecl = true;
    } else if (n.type === 'keyword' && n.value === 'async') {
      const n2 = lexer.next();
      if (n2.type === 'keyword' && n2.value === 'function') isDecl = true;
    } else if (n.type === 'punct' && (n.value === '{' || n.value === '*')) {
      isDecl = false;
    } else {
      lexer.restoreState(st);
    }
  }
  if (first.type === 'keyword' && first.value === 'async') {
    const st = lexer.cloneState();
    const n = lexer.next();
    if (n.type === 'keyword' && n.value === 'function') isDecl = true;
    else lexer.restoreState(st);
  }

  for (;;) {
    const tok = lexer.next();
    if (tok.type === 'eof') return { end: lastEnd };
    lastEnd = tok.end;

    if (tok.type === 'punct') {
      if (tok.value === '{') depth++;
      else if (tok.value === '}') {
        depth = Math.max(0, depth - 1);
        if (depth === 0 && paren === 0 && bracket === 0 && isDecl) {
          const st = lexer.cloneState();
          const n = lexer.next();
          if (n.type === 'punct' && n.value === ';') return { end: n.end };
          if (asiForbidden(n)) return { end: tok.end };
          lexer.restoreState(st);
          return { end: tok.end };
        }
      } else if (tok.value === '(') paren++;
      else if (tok.value === ')') paren = Math.max(0, paren - 1);
      else if (tok.value === '[') bracket++;
      else if (tok.value === ']') bracket = Math.max(0, bracket - 1);
      else if (tok.value === ';' && depth === 0 && paren === 0 && bracket === 0) return { end: tok.end };
    }
  }
}

function splitTopLevel(text) {
  const spans = [];
  const lexer = createLexer(text, 0);
  let pos = 0;
  if (text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    pos = nl === -1 ? text.length : nl + 1;
  }
  let prevEnd = 0;
  while (pos < text.length) {
    pos = skipGap(text, pos);
    if (pos >= text.length) break;
    const minStart = prevEnd;
    let rawStart = pos;
    rawStart = extendStartWithComments(text, rawStart, minStart);
    if (spans.length === 0 && text.startsWith('#!') && rawStart > 0) rawStart = 0;
    const { end: rawEnd, empty } = findStatementEnd(lexer, text, rawStart);
    if (empty) break;
    let end = extendEndNewline(text, rawEnd);
    spans.push({ start: rawStart, end });
    prevEnd = end;
    pos = end;
  }
  return spans;
}

function skipBalanced(lx, open, close) {
  let depth = 1;
  while (depth > 0) {
    const t = lx.next();
    if (t.type === 'eof') return;
    if (t.type === 'punct') {
      if (t.value === open) depth++;
      else if (t.value === close) depth--;
    }
  }
}

function declarePattern(lx, text, declare) {
  const t = lx.next();
  if (t.type === 'identifier') {
    const n = lx.next();
    if (n.type === 'punct' && n.value === ':') declarePattern(lx, text, declare);
    else declare(t.value);
    if (n.type !== 'eof') lx.restoreState({ pos: n.start, line: lineAt(text, n.start), prevSignificant: null });
    return;
  }
  if (t.type === 'punct' && (t.value === '{' || t.value === '[')) {
    const open = t.value;
    const close = open === '{' ? '}' : ']';
    let depth = 1;
    while (depth > 0) {
      const inner = lx.next();
      if (inner.type === 'eof') return;
      if (inner.type === 'punct' && inner.value === open) depth++;
      else if (inner.type === 'punct' && inner.value === close) depth--;
      else if (depth === 1 && inner.type === 'identifier') {
        const n = lx.next();
        if (n.type === 'punct' && n.value === ':') declarePattern(lx, text, declare);
        else declare(inner.value);
        if (n.type !== 'eof') lx.restoreState({ pos: n.start, line: lineAt(text, n.start), prevSignificant: null });
      }
    }
  }
}

function skipDeclaratorValue(lx) {
  let depth = 0;
  let paren = 0;
  let bracket = 0;
  for (;;) {
    const t = lx.next();
    if (t.type === 'eof') return;
    if (t.type === 'punct') {
      if (t.value === '{') depth++;
      else if (t.value === '}') depth--;
      else if (t.value === '(') paren++;
      else if (t.value === ')') paren--;
      else if (t.value === '[') bracket++;
      else if (t.value === ']') bracket--;
      else if (t.value === ',' && depth === 0 && paren === 0 && bracket === 0) {
        lx.restoreState({ pos: t.start, line: 1, prevSignificant: null });
        return;
      }
      else if (t.value === ';' && depth === 0 && paren === 0 && bracket === 0) return;
    }
  }
}

function collectDeclNames(lexer, names, text) {
  const t = lexer.next();
  if (t.type === 'identifier') {
    const n = lexer.next();
    if (n.type === 'punct' && n.value === ':') {
      const sub = new Set();
      declarePattern(lexer, text, (nm) => sub.add(nm));
      for (const nm of sub) names.add(nm);
    } else {
      names.add(t.value);
      if (n.type !== 'eof') lexer.restoreState({ pos: n.start, line: lineAt(text, n.start), prevSignificant: null });
    }
    skipDeclaratorValue(lexer);
    return;
  }
  if (t.type === 'punct' && (t.value === '{' || t.value === '[')) {
    lexer.restoreState({ pos: t.start, line: lineAt(text, t.start), prevSignificant: null });
    declarePattern(lexer, text, (nm) => names.add(nm));
    skipDeclaratorValue(lexer);
  }
}

function usesInTemplate(templateText) {
  const extra = new Set();
  let i = 0;
  while (i < templateText.length) {
    if (templateText[i] === '$' && templateText[i + 1] === '{') {
      i += 2;
      let depth = 1;
      const start = i;
      while (i < templateText.length && depth > 0) {
        if (templateText[i] === '{') depth++;
        else if (templateText[i] === '}') depth--;
        i++;
      }
      const expr = templateText.slice(start, i - 1);
      for (const u of collectUses(expr)) extra.add(u);
      continue;
    }
    i++;
  }
  return extra;
}

function tokenBoundsForSpan(tokens, start, end) {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].end <= start) lo = mid + 1;
    else hi = mid;
  }
  const i0 = lo;
  lo = i0;
  hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start < end) lo = mid + 1;
    else hi = mid;
  }
  return [i0, lo];
}

function tokenizeAll(text) {
  const tokens = [];
  const lx = createLexer(text, 0);
  for (;;) {
    const t = lx.next();
    tokens.push(t);
    if (t.type === 'eof') break;
  }
  return tokens;
}

function collectUsesFastFromTokens(tokens, i0, i1) {
  const uses = new Set();
  let afterDot = false;
  for (let idx = i0; idx < i1; ) {
    const tok = tokens[idx++];
    if (tok.type === 'eof') break;
    if (afterDot) {
      afterDot = false;
      continue;
    }
    if (tok.type === 'punct' && (tok.value === '.' || tok.value === '?.')) {
      afterDot = true;
      continue;
    }
    if (tok.type === 'identifier') {
      const n = idx < i1 ? tokens[idx] : { type: 'eof' };
      if (n.type === 'punct' && n.value === ':') continue;
      uses.add(tok.value);
      // idx already points at n; next iteration consumes n (matches lexer restoreState to n.start).
    }
  }
  return uses;
}

function collectUsesFast(text) {
  const tokens = tokenizeAll(text);
  const [i0, i1] = tokenBoundsForSpan(tokens, 0, text.length);
  return collectUsesFastFromTokens(tokens, i0, i1);
}

function collectUses(text) {
  const uses = new Set();
  const scopes = [new Set()];
  const declare = (name) => scopes[scopes.length - 1].add(name);
  const isBound = (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) return true;
    }
    return false;
  };

  const lx = createLexer(text, 0);
  let afterDot = false;
  let objectKey = false;
  let arrowParams = null;
  let arrowDepth = 0;
  let prevTok = null;

  for (;;) {
    const tok = lx.next();
    if (tok.type === 'eof') break;

    if (afterDot) {
      afterDot = false;
      continue;
    }

    if (tok.type === 'punct') {
      if (tok.value === '.' || tok.value === '?.') afterDot = true;
      else if (tok.value === '{') {
        scopes.push(new Set());
        objectKey = true;
      } else if (tok.value === '}') {
        if (scopes.length > 1) scopes.pop();
        objectKey = false;
      } else if (tok.value === ',') objectKey = true;
      else if (tok.value === '(') {
        const noArrow = prevTok && prevTok.type === 'keyword'
          && ['if', 'for', 'while', 'switch', 'catch', 'function', 'with', 'return', 'typeof', 'void', 'delete', 'new'].includes(prevTok.value);
        if (!noArrow) {
          arrowParams = [];
          arrowDepth = 1;
        }
      } else if (tok.value === ')' && arrowParams) {
        const st = lx.cloneState();
        const n = lx.next();
        if (n.type === 'punct' && n.value === '=>') {
          for (const p of arrowParams) declare(p);
        } else lx.restoreState(st);
        arrowParams = null;
        arrowDepth = 0;
      } else if (arrowParams && tok.value === '(') arrowDepth++;
      else if (arrowParams && tok.value === ')') arrowDepth = Math.max(0, arrowDepth - 1);
      else objectKey = false;
      prevTok = tok;
      continue;
    }

    if (tok.type === 'keyword') {
      if (tok.value === 'function') {
        const n = lx.next();
        if (n.type === 'punct' && n.value === '*') {
          const id = lx.next();
          if (id.type === 'identifier') declare(id.value);
        } else if (n.type === 'identifier') declare(n.value);
        else if (n.type !== 'eof') lx.restoreState({ pos: n.start, line: lineAt(text, n.start), prevSignificant: null });
        const open = lx.next();
        if (open.type === 'punct' && open.value === '(') {
          let depth = 1;
          while (depth > 0) {
            const p = lx.next();
            if (p.type === 'eof') break;
            if (p.type === 'punct' && p.value === '(') depth++;
            else if (p.type === 'punct' && p.value === ')') depth--;
            else if (depth === 1 && p.type === 'identifier') {
              const nxt = lx.next();
              if (nxt.type === 'punct' && nxt.value === '=>') {
                lx.restoreState({ pos: p.start, line: lineAt(text, p.start), prevSignificant: null });
                break;
              }
              declare(p.value);
              if (nxt.type !== 'eof') lx.restoreState({ pos: nxt.start, line: lineAt(text, nxt.start), prevSignificant: null });
            } else if (depth === 1 && p.type === 'punct' && (p.value === '{' || p.value === '[')) {
              lx.restoreState({ pos: p.start, line: lineAt(text, p.start), prevSignificant: null });
              declarePattern(lx, text, declare);
            }
          }
        }
        continue;
      }
      if (tok.value === 'class') {
        const n = lx.next();
        if (n.type === 'identifier') declare(n.value);
        continue;
      }
      if (tok.value === 'get' || tok.value === 'set') {
        const n = lx.next();
        if (n.type === 'identifier') declare(n.value);
        continue;
      }
      if (tok.value === 'const' || tok.value === 'let' || tok.value === 'var') {
        for (;;) {
          const id = lx.next();
          if (id.type === 'eof') break;
          if (id.type === 'identifier') {
            const n = lx.next();
            if (n.type === 'punct' && n.value === ':') declarePattern(lx, text, declare);
            else {
              declare(id.value);
              if (n.type !== 'eof') lx.restoreState({ pos: n.start, line: lineAt(text, n.start), prevSignificant: null });
            }
          } else if (id.type === 'punct' && (id.value === '{' || id.value === '[')) {
            lx.restoreState({ pos: id.start, line: lineAt(text, id.start), prevSignificant: null });
            declarePattern(lx, text, declare);
          }
          const sep = lx.next();
          if (sep.type === 'punct' && sep.value === ',') continue;
          if (sep.type !== 'eof') lx.restoreState({ pos: sep.start, line: lineAt(text, sep.start), prevSignificant: null });
          break;
        }
      } else if (tok.value === 'catch') {
        const n = lx.next();
        if (n.type === 'punct' && n.value === '(') {
          const id = lx.next();
          if (id.type === 'identifier') declare(id.value);
        }
        prevTok = tok;
        continue;
      } else {
        prevTok = tok;
        continue;
      }
    }

    if (tok.type === 'template') {
      for (const u of usesInTemplate(tok.value)) {
        if (!isBound(u)) uses.add(u);
      }
      prevTok = tok;
      continue;
    }

    if (tok.type === 'identifier') {
      if (arrowParams && arrowDepth === 1) arrowParams.push(tok.value);
      const n = lx.next();
      if (n.type === 'punct' && n.value === ':') {
        if (!objectKey) declare(tok.value);
        continue;
      }
      if (n.type === 'punct' && n.value === '=>') {
        declare(tok.value);
        continue;
      }
      const inArrowList = arrowParams && arrowDepth === 1;
      if (!inArrowList && !isBound(tok.value)) uses.add(tok.value);
      if (n.type !== 'eof') lx.restoreState({ pos: n.start, line: lineAt(text, n.start), prevSignificant: null });
      objectKey = false;
      prevTok = tok;
      continue;
    }
    prevTok = tok;
  }

  return uses;
}

function parseItemMeta(slice) {
  const lexer = createLexer(slice, 0);
  const names = [];
  let exported = false;
  let kind = 'expression';

  let tok = lexer.next();
  if (tok.type === 'keyword' && tok.value === 'export') {
    exported = true;
    tok = lexer.next();
    if (tok.type === 'keyword' && tok.value === 'default') {
      kind = 'export';
      return { kind, names, exported: true };
    }
    if (tok.type === 'punct' && tok.value === '{') {
      kind = 'export';
      for (;;) {
        const t = lexer.next();
        if (t.type === 'eof') break;
        if (t.type === 'punct' && t.value === '}') break;
        if (t.type === 'identifier') {
          const n = lexer.next();
          if (n.type === 'keyword' && n.value === 'as') {
            const alias = lexer.next();
            if (alias.type === 'identifier') names.push(alias.value);
          } else {
            names.push(t.value);
            if (n.type !== 'eof') lexer.restoreState({ pos: n.start, line: lineAt(slice, n.start), prevSignificant: null });
          }
        }
      }
      return { kind, names, exported: true };
    }
    if (tok.type === 'punct' && tok.value === '*') {
      kind = 'export';
      return { kind, names, exported: true };
    }
  }

  if (tok.type === 'keyword' && tok.value === 'import') {
    kind = 'import';
    for (;;) {
      const t = lexer.next();
      if (t.type === 'eof') break;
      if (t.type === 'keyword' && t.value === 'from') break;
      if (t.type === 'identifier') names.push(t.value);
      if (t.type === 'punct' && t.value === ',') continue;
    }
    return { kind, names, exported: false };
  }

  if (tok.type === 'keyword' && tok.value === 'async') {
    const n = lexer.next();
    if (n.type === 'keyword' && n.value === 'function') {
      kind = 'function';
      const id = lexer.next();
      if (id.type === 'identifier') names.push(id.value);
      return { kind, names, exported };
    }
  }

  if (tok.type === 'keyword' && tok.value === 'function') {
    kind = 'function';
    const star = lexer.next();
    if (star.type === 'punct' && star.value === '*') {
      const id = lexer.next();
      if (id.type === 'identifier') names.push(id.value);
    } else if (star.type === 'identifier') {
      names.push(star.value);
    }
    return { kind, names, exported };
  }

  if (tok.type === 'keyword' && tok.value === 'class') {
    kind = 'class';
    const id = lexer.next();
    if (id.type === 'identifier') names.push(id.value);
    return { kind, names, exported };
  }

  if (tok.type === 'keyword' && ['const', 'let', 'var'].includes(tok.value)) {
    kind = 'declaration';
    const nameSet = new Set();
    for (;;) {
      collectDeclNames(lexer, nameSet, slice);
      const sep = lexer.next();
      if (sep.type === 'punct' && sep.value === ',') continue;
      break;
    }
    names.push(...nameSet);
    return { kind, names, exported };
  }

  return { kind, names, exported };
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
  const spans = splitTopLevel(text);
  const fastUses = text.length > 10_000;
  const allTokens = fastUses ? tokenizeAll(text) : null;
  const items = [];
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    const slice = text.slice(span.start, span.end);
    const meta = parseItemMeta(slice);
    let uses;
    if (fastUses) {
      const [i0, i1] = tokenBoundsForSpan(allTokens, span.start, span.end);
      uses = collectUsesFastFromTokens(allTokens, i0, i1);
    } else {
      uses = collectUses(slice);
    }
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
