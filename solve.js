// Fast drop-in for makefun-site 1.0.0 — written from scratch for this entry.
//
// Same answers as makefun-site 1.0.0's build(), byte for byte, but structured for
// speed: front matter is parsed while scanning lines (no split/join of the body),
// Markdown is rendered in one pass over the body (no token array, HTML is emitted
// as the lines are scanned), inline markup copies plain runs in bulk and escapes
// each run with a single regex pass, slugs and reading times are cached per source,
// and templates render into one shared string array instead of concatenating
// strings at every node.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
/** `s` with the five HTML characters escaped. */
function esc(s) {
  return s.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MARK_RE = /\p{M}/gu;
const slugCache = new Map();
/** The slug of `text` (NFKD, marks dropped, runs of other characters one "-"). */
function slugOf(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let k = 0;
    if (c >= 65 && c <= 90) k = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k = c;
    if (k === 0) {
      if (out !== '') gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(k);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `base` made unique against `taken` (and recorded there). */
function uniqSlug(base, taken) {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  const out = `${base}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(d) {
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}

/** Whether the code unit `c` is JavaScript whitespace. */
function wsCode(c) {
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of `t`: its runs of non-whitespace characters. */
function wordCount(t) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < t.length; i++) {
    if (wsCode(t.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** Spaces/tabs at either end of `line` dropped. */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether `line` holds only spaces and tabs (or nothing). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ---------------------------------------------------------------- front matter

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const KNOWN_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A quoted or bare string value: { v } or { e }. */
function strVal(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { e: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) {
          return { e: "a quoted string holds an escape other than \\\" or \\\\" };
        }
        out += nx;
        i++;
      } else if (c === '"') return { e: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { v: out };
  }
  if (raw.charCodeAt(0) === 91) return { e: 'a bare string opens on [' };
  return { v: raw };
}

/** One key's value: { v } or { e }. */
function keyVal(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const r = strVal(raw);
      return r.e !== undefined ? { e: `key "${key}": ${r.e}` } : r;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
        return { e: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { v: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { e: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { v: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { e: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { v: tags };
    }
    case 'draft':
      return raw === 'true' ? { v: true } : raw === 'false' ? { v: false } : { e: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { v: raw } : { e: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { v: raw } : { e: 'key "slug": not a slug' };
    default:
      return { e: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { err } with the first
 * reason it is refused. `text` already has "\n" line ends.
 */
function parseFm(text) {
  const n = text.length;
  let pos = 0;
  const take = () => {
    if (pos >= n) return null;
    const e = text.indexOf('\n', pos);
    if (e === -1) {
      const l = text.slice(pos);
      pos = n + 1;
      return l;
    }
    const l = text.slice(pos, e);
    pos = e + 1;
    return l;
  };
  if (take() !== '---') return { err: 'no front matter' };
  const fm = [];
  let closed = false;
  let ln;
  while ((ln = take()) !== null) {
    if (ln === '---') {
      closed = true;
      break;
    }
    fm.push(ln);
  }
  if (!closed) return { err: 'the front matter is not closed' };
  const body = text.slice(pos);
  const data = {};
  for (let k = 0; k < fm.length; k++) {
    const line = fm[k];
    if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (m === null) return { err: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KNOWN_KEYS.includes(key)) return { err: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { err: `key "${key}" is given twice` };
    if (raw === '') return { err: `key "${key}" has no value` };
    const v = keyVal(key, raw);
    if (v.e !== undefined) return { err: v.e };
    data[key] = v.v;
  }
  if (!Object.hasOwn(data, 'title')) return { err: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = '\\`*_[]()#+-.!>';
const isLangChar = (c) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  let j = 3;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length;
}

/** A heading line's depth and text, or null. */
function headingInfo(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let a = h;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b <= a) return null;
  return { depth: h, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  let j = 3;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length;
}

/** A bullet item's rest, or null. */
function bulletRest(line) {
  if (line.length < 2) return null;
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and rest, or null. */
function orderedInfo(line) {
  let j = 0;
  while (j < line.length && j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j >= line.length) return null;
  if (line.charCodeAt(j) !== 46) return null;
  if (line.charCodeAt(j + 1) !== 32) return null;
  return { num: line.slice(0, j), rest: line.slice(j + 2) };
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !wsCode(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph. */
function endsPara(line) {
  return isBlank(line) || fenceLang(line) !== null || headingInfo(line) !== null || isHr(line);
}

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape,
 * or -1. An occurrence is escaped exactly when an odd run of backslashes stands
 * immediately before it (the scan pairs backslashes left to right).
 */
function findUnescaped(s, what, from) {
  let p = s.indexOf(what, from);
  while (p !== -1) {
    let b = 0;
    let q = p - 1;
    while (q >= 0 && s.charCodeAt(q) === 92) {
      b++;
      q--;
    }
    if (b % 2 === 0) return p;
    p = s.indexOf(what, p + 1);
  }
  return -1;
}

/** The first single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from) {
  let p = s.indexOf('*', from);
  while (p !== -1) {
    let b = 0;
    let q = p - 1;
    while (q >= 0 && s.charCodeAt(q) === 92) {
      b++;
      q--;
    }
    if (b % 2 === 1) {
      p = s.indexOf('*', p + 1);
      continue;
    }
    if (s[p + 1] === '*') {
      p = s.indexOf('*', p + 2);
      continue;
    }
    return p;
  }
  return -1;
}

/** `s` rendered inline, appended to `out`; `link(target)` is a link's href. */
function inlineInto(s, link, out) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    // The next markup character, if any; everything before it is plain text.
    let j = n;
    const b = s.indexOf('\\', i);
    if (b !== -1 && b < j) j = b;
    const c = s.indexOf('`', i);
    if (c !== -1 && c < j) j = c;
    const st = s.indexOf('*', i);
    if (st !== -1 && st < j) j = st;
    const br = s.indexOf('[', i);
    if (br !== -1 && br < j) j = br;
    if (j > i) out.push(esc(s.slice(i, j)));
    if (j >= n) break;
    const ch = s[j];
    if (ch === '\\') {
      const nx = s[j + 1];
      if (nx !== undefined && ESCAPABLE.indexOf(nx) !== -1) {
        out.push(nx); // no escapable character needs HTML escaping
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (ch === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (ch === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          inlineInto(s.slice(j + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>');
          inlineInto(s.slice(j + 1, k), link, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', j + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out.push('<a href="', esc(link(target)), '">');
      inlineInto(s.slice(j + 1, k), link, out);
      out.push('</a>');
      i = m + 1;
    } else {
      out.push('[');
      i = j + 1;
    }
  }
}

/** `s` rendered inline, as one string. */
function inlineStr(s, link) {
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
}

/** `body` rendered: its HTML, table of contents and excerpt. */
function renderBody(body, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = body.length;
  let pos = 0;
  const take = () => {
    if (pos >= n) return null;
    const e = body.indexOf('\n', pos);
    if (e === -1) {
      const l = body.slice(pos);
      pos = n + 1;
      return l;
    }
    const l = body.slice(pos, e);
    pos = e + 1;
    return l;
  };
  let cur = take();
  while (cur !== null) {
    const line = cur;
    if (isBlank(line)) {
      cur = take();
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const parts = [`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>`];
      cur = take();
      while (cur !== null && !isFenceClose(cur)) {
        parts.push(esc(cur), '\n');
        cur = take();
      }
      if (cur !== null) cur = take();
      parts.push('</code></pre>');
      blocks.push(`${parts.join('')}\n`);
      continue;
    }
    const hd = headingInfo(line);
    if (hd !== null) {
      const id = uniqSlug(slugOf(hd.text), ids);
      const html = inlineStr(hd.text, link);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      cur = take();
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>\n');
      cur = take();
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const q = [];
      while (cur !== null && cur.charCodeAt(0) === 62) {
        let t = cur.slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        const tr = trimST(t);
        if (tr !== '') q.push(tr);
        cur = take();
      }
      blocks.push(q.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineStr(q.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const br = bulletRest(line);
    const od = br === null ? orderedInfo(line) : null;
    if (br !== null || od !== null) {
      const ordered = od !== null;
      const items = [[trimST(ordered ? od.rest : br)]];
      const startNum = ordered ? Number(od.num) : 1;
      cur = take();
      while (cur !== null) {
        if (ordered) {
          const o2 = orderedInfo(cur);
          if (o2 !== null) {
            items.push([trimST(o2.rest)]);
            cur = take();
            continue;
          }
        } else {
          const b2 = bulletRest(cur);
          if (b2 !== null) {
            items.push([trimST(b2)]);
            cur = take();
            continue;
          }
        }
        if (isContinued(cur)) {
          items[items.length - 1].push(trimST(cur));
          cur = take();
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (const it of items) parts.push(`<li>${inlineStr(it.join('\n'), link)}</li>\n`);
      parts.push(`</${tag}>`);
      blocks.push(`${parts.join('')}\n`);
      continue;
    }
    const parts = [trimST(line)];
    cur = take();
    while (cur !== null && !endsPara(cur)) {
      parts.push(trimST(cur));
      cur = take();
    }
    const html = inlineStr(parts.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathParts(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` holds only spaces and tabs. */
function onlySpaces(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}/{{{ }}} values and {% %} tags. */
function tokenize(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') toks.push({ k: 't', s: text });
      text = '';
      toks.push({ k: raw ? 'r' : 'v', p: pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const ls = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const le = nl === -1 ? n : nl;
    const solo = onlySpaces(src.slice(ls, open)) && onlySpaces(src.slice(end, le));
    if (solo) text = text.slice(0, text.length - (open - ls));
    if (text !== '') toks.push({ k: 't', s: text });
    text = '';
    toks.push({ k: 'g', s: src.slice(open + 2, close).trim() });
    i = solo ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') toks.push({ k: 't', s: text });
  return toks;
}

/** `src` compiled into its node tree (a TemplateError when it does not parse). */
function compileTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.k === 't') {
      body.push({ kind: 'text', text: tok.s });
      continue;
    }
    if (tok.k === 'v' || tok.k === 'r') {
      body.push({ kind: tok.k, path: tok.p });
      continue;
    }
    const tag = tok.s;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathParts(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathParts(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const par = stack[stack.length - 1];
      body = par.kind === 'root' ? par.body : par.kind === 'for' ? par.body : par.els ?? par.then;
    } else if ((m = INC_RE.exec(tag)) !== null) body.push({ kind: 'inc', name: m[1] });
    else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: strings itself, numbers in JS digits, booleans, arrays joined by ", ". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope`, appended to `out`. */
function renderInto(nodes, scope, ctx, depth, out) {
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'text':
        out.push(nd.text);
        break;
      case 'v':
        out.push(esc(textOf(lookup(scope, nd.path))));
        break;
      case 'r':
        out.push(textOf(lookup(scope, nd.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, nd.path));
        const br = v !== nd.not ? nd.then : nd.els;
        if (br !== null) renderInto(br, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, nd.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[nd.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderInto(nd.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'inc': {
        const t = ctx.templates.get(nd.name);
        if (t !== undefined && depth < 8) renderInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const ordered = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of ordered) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFm(s.text);
    if (fm.err !== undefined) {
      report.push(`refused ${s.path}: ${fm.err}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let ownDir = null;
    if (s.path.startsWith('tags/')) ownDir = 'tags';
    else if (s.path.startsWith('page/')) ownDir = 'page';
    if (ownDir !== null) {
      report.push(`refused ${s.path}: ${ownDir}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    const slug = uniqSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const h = target.indexOf('#');
      const rel = h === -1 ? target : target.slice(0, h);
      const frag = h === -1 ? '' : target.slice(h);
      const path = rel === '' ? null : resolveRel(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderBody(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort(
    (x, y) =>
      (y.data.date < x.data.date ? -1 : y.data.date > x.data.date ? 1 : 0) ||
      (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0),
  );
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugOf(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const sl = slugOf(name);
      let t = bySlug.get(sl);
      if (t === undefined) {
        t = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, t);
      }
      t.posts.push(p);
      p.tagRefs.push(t);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTagNames(s).map((name) => {
        const sl = slugOf(name);
        return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0),
  );

  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const cardOf = (s) => {
    if (s._card !== undefined) return s._card;
    if (s._readMin === undefined) s._readMin = Math.max(1, Math.ceil(wordCount(s.body) / 200));
    const c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s._readMin,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s._card = c;
    return c;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderInto(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const totalPages = Math.max(1, Math.ceil(posts.length / per));
  const idxUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= totalPages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: {
        number: k,
        total: totalPages,
        url: idxUrl(k),
        newer_url: k === 1 ? '' : idxUrl(k - 1),
        older_url: k === totalPages ? '' : idxUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort();
  lines.push(`built ${kept.filter((s) => !s.post).length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
