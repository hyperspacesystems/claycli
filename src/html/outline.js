import { ClayError } from '../errors.js';
import { isElement, located, parse, pathOf } from './source.js';

const NO_TEXT = new Set(['script', 'style']);
const TEXT_LIMIT = 60;
const MAX_CHILDREN = 40;
const OUTLINE_BUDGET = 8000;
const CAPPED_HINT =
  'Part of the outline is hidden. Outline one part with select (a path from this outline), or use find_in_document.';

function collapseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function directText(el) {
  let text = '';
  for (const child of el.children) {
    if (child.type === 'text') text += child.data;
  }
  return collapseWhitespace(text).slice(0, TEXT_LIMIT);
}

function classOf(el) {
  const value = el.attribs?.class;
  return typeof value === 'string' ? value : null;
}

function runKey(el) {
  const className = classOf(el);
  return `${el.name}\u0000${className === null ? '\u0000' : className}`;
}

function expand(children) {
  const out = [];
  for (const child of children) {
    if (!isElement(child)) continue;
    if (!located(child)) {
      out.push(...expand(child.children));
      continue;
    }
    out.push(child);
  }
  return out;
}

function entryFor(el, level, depth, last, count, state) {
  const loc = located(el);
  const lastLoc = last === el ? loc : located(last);
  const entry = { path: pathOf(el), tag: el.name };
  const id = el.attribs?.id;
  if (id) entry.id = id;
  const className = classOf(el);
  if (className !== null) entry.class = className;
  entry.start = loc.start;
  entry.end = lastLoc.end;
  entry.chars = lastLoc.end - loc.start;
  if (count > 1) {
    entry.repeated = count;
    entry.lastPath = pathOf(last);
  }
  if (NO_TEXT.has(el.name)) {
    const type = el.attribs?.type;
    if (type) entry.type = type;
  } else {
    const text = directText(el);
    if (text) entry.text = text;
    if (level < depth) {
      const children = buildEntries(expand(el.children), level + 1, depth, state);
      if (children.length > 0) entry.children = children;
    }
  }
  return entry;
}

function buildEntries(children, level, depth, state) {
  const runs = [];
  let i = 0;
  while (i < children.length) {
    const el = children[i];
    let j = i;
    while (j + 1 < children.length && runKey(children[j + 1]) === runKey(el)) j += 1;
    runs.push({ el, last: children[j], count: j - i + 1 });
    i = j + 1;
  }
  const shown = runs.slice(0, MAX_CHILDREN);
  const entries = shown.map((run) => entryFor(run.el, level, depth, run.last, run.count, state));
  if (runs.length > shown.length) {
    const hidden = runs.slice(shown.length);
    entries.push({
      more: hidden.length,
      start: located(hidden[0].el).start,
      end: located(hidden[hidden.length - 1].last).end,
    });
    state.capped = true;
  }
  return entries;
}

function readApiRules($) {
  const tag = $('script[data-rules-name~="api"]').first();
  if (tag.length === 0) return { hasApiRules: false, dataKeys: [] };
  let dataKeys = [];
  try {
    const data = JSON.parse(tag.text());
    if (data && typeof data === 'object') dataKeys = Object.keys(data);
  } catch {
    dataKeys = [];
  }
  return { hasApiRules: true, dataKeys };
}

function trimToBudget(entries, maxChars, state) {
  const popped = [];
  while (entries.length > 1 && JSON.stringify(entries).length > maxChars) {
    popped.unshift(entries.pop());
  }
  if (popped.length === 0) return;
  const more = popped.reduce((sum, entry) => sum + (entry.repeated ?? 1) + (entry.more ?? 0), 0);
  entries.push({ more, start: popped[0].start, end: popped[popped.length - 1].end });
  state.capped = true;
}

export function outline(html, { depth = 4, select = null, maxChars = OUTLINE_BUDGET } = {}) {
  const { $ } = parse(html);
  const root = select === null ? $('html').first()[0] : null;
  let start = root;
  if (select !== null) {
    try {
      start = $(select).first()[0] ?? null;
    } catch {
      throw new ClayError('invalid-selector', `That is not a valid CSS selector: ${select}`, {
        hint: 'Pass a selector such as `main#board` or `article.card`.',
      });
    }
  }
  const requested = Number.isInteger(depth) && depth > 0 ? depth : 0;
  const state = { capped: false };
  let used = requested;
  let entries = [];
  if (start && requested > 0) {
    const children = expand(start.children);
    entries = buildEntries(children, 1, used, state);
    while (JSON.stringify(entries).length > maxChars && used > 1) {
      used -= 1;
      state.capped = false;
      entries = buildEntries(children, 1, used, state);
    }
    if (JSON.stringify(entries).length > maxChars) trimToBudget(entries, maxChars, state);
  }
  const truncated = used < requested || state.capped;
  const result = { size: html.length, ...readApiRules($), depth: used, truncated, outline: entries };
  if (truncated) result.hint = CAPPED_HINT;
  return result;
}
