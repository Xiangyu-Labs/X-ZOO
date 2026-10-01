/**
 * A small lexical scanner for the `tx-pool` check: which functions
 * take a transaction, and where inside them the code reaches for the pool.
 *
 * There is no TypeScript AST to lean on here (`typescript` 7 ships no stable
 * JS API), so this works on the source text in two steps:
 *
 *  1. **Mask.** Comments, string literals, the literal parts of template
 *     strings and regular-expression literals are overwritten with spaces
 *     (newlines kept), so a brace or a `ctx.db` inside prose or a string can
 *     neither unbalance the scan nor produce a finding. Template `${…}`
 *     expressions stay code.
 *  2. **Match.** A function "takes a tx" when its parameter list has a
 *     top-level parameter named `tx`, or one typed exactly `Tx` or `DbOrTx`
 *     (a `db: DbOrTx` helper is handed the transaction on every write path).
 *     Its body is the block after `{` / `=> {`, or the expression after `=>`.
 *
 * `tx ?? ctx.db` is not a finding: it is the pool only when no transaction
 * was passed, which is the idiom for "join the caller's, else read the pool".
 *
 * Lexical on purpose: it sees `ctx.db` written inside the function, not a
 * helper that the function calls with `ctx`. That is the half a reviewer can
 * be asked to keep, and the half this check keeps for them.
 */

export interface TxFunction {
  /** Offset of the parameter list's `(` (or of the bare `tx` of `tx => …`). */
  start: number;
  bodyStart: number;
  bodyEnd: number;
  /** Best-effort name: the declared name, the method or property, or the call it is passed to. */
  name: string;
}

export interface PoolReach {
  /** The construct, as written: `ctx.config.get(`, `ctx.db`, … */
  construct: string;
  offset: number;
  line: number;
  /** The trimmed source line, which the allow-list compares exactly. */
  text: string;
  /** The innermost function taking a tx that contains it. */
  within: string;
}

const TX_TYPES = new Set(['Tx', 'DbOrTx']);

const KEYWORDS_BEFORE_PAREN = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return']);

/** Characters after which a `/` starts a regular expression rather than dividing. */
const REGEX_PRECEDERS = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void']);

/** Same length as `source`, with everything that is not code blanked out. */
export function maskSource(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  // A stack of open template literals: for each, the brace depth of its
  // current `${…}` expression.
  const templates: number[] = [];
  let i = 0;
  const n = source.length;

  const previousSignificant = (at: number): { char: string; word: string } => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(out[j]!)) j -= 1;
    if (j < 0) return { char: '', word: '' };
    const char = out[j]!;
    let k = j;
    while (k >= 0 && /[\w$]/.test(out[k]!)) k -= 1;
    return { char, word: out.slice(k + 1, j + 1).join('') };
  };

  const scanTemplateText = (from: number): number => {
    // from points just after the opening backtick or the closing `}` of `${`.
    let j = from;
    while (j < n) {
      const c = source[j]!;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') {
        blank(from, j);
        templates.pop();
        return j + 1;
      }
      if (c === '$' && source[j + 1] === '{') {
        blank(from, j);
        templates[templates.length - 1] = 0;
        return j + 2;
      }
      j += 1;
    }
    blank(from, n);
    return n;
  };

  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(j, n));
      i = j + 1;
      continue;
    }
    if (c === '`') {
      templates.push(0);
      i = scanTemplateText(i + 1);
      continue;
    }
    if (templates.length > 0) {
      const top = templates.length - 1;
      if (c === '{') templates[top] = templates[top]! + 1;
      else if (c === '}') {
        if (templates[top] === 0) {
          i = scanTemplateText(i + 1);
          continue;
        }
        templates[top] = templates[top]! - 1;
      }
    }
    if (c === '/') {
      const { char, word } = previousSignificant(i);
      const isRegex =
        char === '' ||
        REGEX_PRECEDERS.has(char) ||
        (word !== '' && /^[A-Za-z]+$/.test(word) && REGEX_KEYWORDS.has(word));
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < n && source[j] !== '\n') {
          const d = source[j]!;
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          j += 1;
        }
        blank(i + 1, j);
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return out.join('');
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Offset of the bracket matching the one at `at`, in masked text; -1 if unbalanced. */
export function matching(masked: string, at: number): number {
  const open = masked[at]!;
  const close = OPEN[open];
  if (close === undefined) return -1;
  let depth = 0;
  for (let i = at; i < masked.length; i += 1) {
    const c = masked[i]!;
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits at top-level commas (outside (), [], {}, <>). */
function topLevelParts(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if ('([{<'.includes(c)) depth += 1;
    else if (')]}>'.includes(c) && !(c === '>' && text[i - 1] === '=')) depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

function takesTx(params: string): boolean {
  return topLevelParts(params).some((raw) => {
    const param = raw
      .trim()
      .replace(/^\.\.\./, '')
      .replace(/^(public|private|protected|readonly)\s+/, '');
    const match = /^([\w$]+)\s*\??\s*(?::([^=]*))?/.exec(param);
    if (!match) return false;
    return match[1] === 'tx' || TX_TYPES.has(match[2]?.trim() ?? '');
  });
}

const skipSpace = (masked: string, at: number): number => {
  let i = at;
  while (i < masked.length && /\s/.test(masked[i]!)) i += 1;
  return i;
};

/**
 * After a parameter list's `)`, skip an optional return type and report where
 * the body begins: `{` of a block, or the first character after `=>`.
 */
function bodyAfterParams(
  masked: string,
  close: number,
): { kind: 'block' | 'expr'; at: number } | null {
  let i = skipSpace(masked, close + 1);
  if (masked[i] === ':') {
    // A return type. Nesting in <>, (), [] and {} is skipped; the type ends at
    // a `{` or `=>` with nothing open. An object-literal return type written
    // inline (`): { a: B } {`) ends early and is scanned as the body, which
    // can miss a finding but never invent one.
    let depth = 0;
    i += 1;
    let seenType = false;
    while (i < masked.length) {
      const c = masked[i]!;
      if (c === '=' && masked[i + 1] === '>') {
        if (depth === 0) break;
        i += 2;
        continue;
      }
      if (c === '{' && depth === 0 && seenType) break;
      if ('<([{'.includes(c)) depth += 1;
      else if ('>)]}'.includes(c)) depth -= 1;
      else if (c === ';' || (c === ',' && depth === 0)) return null;
      if (!/\s/.test(c)) seenType = true;
      i += 1;
    }
  }
  if (masked[i] === '{') return { kind: 'block', at: i };
  if (masked[i] === '=' && masked[i + 1] === '>') {
    const start = skipSpace(masked, i + 2);
    return masked[start] === '{' ? { kind: 'block', at: start } : { kind: 'expr', at: start };
  }
  return null;
}

/** End of an arrow's expression body: the first unmatched closer, or `,` / `;` at depth 0. */
function expressionEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    const c = masked[i]!;
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if ((c === ',' || c === ';') && depth === 0) return i;
  }
  return masked.length;
}

/** The identifier ending right before `at` (skipping spaces and a `function`/`async` keyword). */
function nameBefore(masked: string, at: number): string {
  let j = at - 1;
  while (j >= 0 && /\s/.test(masked[j]!)) j -= 1;
  // `name = async (`, `name: (`, `name(` (method), `function name(`, `call((`
  const end = j + 1;
  while (j >= 0 && /[\w$]/.test(masked[j]!)) j -= 1;
  const word = masked.slice(j + 1, end);
  if (word === 'async' || word === 'function') return nameBefore(masked, j + 1);
  if (word !== '') return word;
  const c = masked[end - 1];
  if (c === '=' || c === ':') return nameBefore(masked, end - 1);
  if (c === '(' || c === ',') {
    // A callback: name it after the call it is passed to.
    let depth = 0;
    for (let k = end - 1; k >= 0; k -= 1) {
      const d = masked[k]!;
      if (d === ')') depth += 1;
      else if (d === '(') {
        if (depth === 0) return `${nameBefore(masked, k)}(callback)`;
        depth -= 1;
      }
    }
  }
  return '<anonymous>';
}

export function findTxFunctions(masked: string): TxFunction[] {
  const found: TxFunction[] = [];
  for (let open = masked.indexOf('('); open !== -1; open = masked.indexOf('(', open + 1)) {
    const close = matching(masked, open);
    if (close === -1) continue;
    if (!takesTx(masked.slice(open + 1, close))) continue;
    const before = /([\w$]+)\s*$/.exec(masked.slice(Math.max(0, open - 40), open));
    if (before && KEYWORDS_BEFORE_PAREN.has(before[1]!)) continue;
    const body = bodyAfterParams(masked, close);
    if (body === null) continue;
    const bodyEnd =
      body.kind === 'block' ? matching(masked, body.at) : expressionEnd(masked, body.at);
    if (bodyEnd === -1) continue;
    found.push({ start: open, bodyStart: body.at, bodyEnd, name: nameBefore(masked, open) });
  }
  // `tx => …` and `async tx => …`
  for (const match of masked.matchAll(/(^|[^\w$.])tx\s*=>/g)) {
    const start = match.index + match[1]!.length;
    const arrow = masked.indexOf('=>', start);
    const bodyStart = skipSpace(masked, arrow + 2);
    const bodyEnd =
      masked[bodyStart] === '{' ? matching(masked, bodyStart) : expressionEnd(masked, bodyStart);
    if (bodyEnd === -1) continue;
    found.push({ start, bodyStart, bodyEnd, name: nameBefore(masked, start) });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** What inside a tx-function reaches the pool instead of the transaction. */
const POOL_REACH = /(^|[^\w$.])(ctx\.config\.get(?:Raw)?\s*\(|ctx\.db(?![\w$])|ctx\.withTx\s*\()/g;

export function findPoolReaches(source: string): PoolReach[] {
  const masked = maskSource(source);
  const functions = findTxFunctions(masked);
  const lines = source.split('\n');
  const reaches: PoolReach[] = [];
  for (const match of masked.matchAll(POOL_REACH)) {
    const offset = match.index + match[1]!.length;
    let innermost: TxFunction | undefined;
    for (const fn of functions) {
      if (fn.bodyStart <= offset && offset < fn.bodyEnd) {
        if (innermost === undefined || fn.bodyStart >= innermost.bodyStart) innermost = fn;
      }
    }
    if (innermost === undefined) continue;
    if (match[2]!.startsWith('ctx.db') && /\btx\s*\?\?\s*$/.test(masked.slice(0, offset))) continue;
    let line = 1;
    for (let i = 0; i < offset; i += 1) if (source[i] === '\n') line += 1;
    reaches.push({
      construct: match[2]!.replace(/\s+/g, ''),
      offset,
      line,
      text: lines[line - 1]!.trim(),
      within: innermost.name,
    });
  }
  return reaches;
}
