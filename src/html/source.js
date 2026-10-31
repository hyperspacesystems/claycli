import { load } from 'cheerio';

const ELEMENT_TYPES = new Set(['tag', 'script', 'style']);

export function isElement(node) {
  return Boolean(node && ELEMENT_TYPES.has(node.type) && node.name);
}

export function parse(html) {
  const $ = load(html, { sourceCodeLocationInfo: true });
  return { html, $ };
}

export function located(el) {
  const loc = el?.sourceCodeLocation;
  if (!loc || typeof loc.startOffset !== 'number' || typeof loc.endOffset !== 'number') return null;
  return { start: loc.startOffset, end: loc.endOffset };
}

function escapeIdent(value) {
  return String(value).replace(/([^\w-])/g, '\\$1');
}

const typePositions = new WeakMap();

function positionsUnder(parent) {
  let entry = typePositions.get(parent);
  if (!entry) {
    const position = new Map();
    const total = new Map();
    for (const child of parent.children) {
      if (!isElement(child)) continue;
      const n = (total.get(child.name) ?? 0) + 1;
      total.set(child.name, n);
      position.set(child, n);
    }
    entry = { position, total };
    typePositions.set(parent, entry);
  }
  return entry;
}

function stepFor(el) {
  const id = el.attribs?.id;
  if (id) return `${el.name}#${escapeIdent(id)}`;
  let step = el.name;
  const className = firstClass(el);
  if (className) step += `.${escapeIdent(className)}`;
  const parent = el.parent;
  if (isElement(parent)) {
    const { position, total } = positionsUnder(parent);
    if (total.get(el.name) > 1) step += `:nth-of-type(${position.get(el)})`;
  }
  return step;
}

function firstClass(el) {
  const value = el.attribs?.class;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/)[0] : null;
}

export function pathOf(el) {
  const chain = [];
  let node = el;
  while (isElement(node)) {
    chain.unshift(node);
    if (node.attribs?.id || node.name === 'html') break;
    node = node.parent;
  }
  return chain.map(stepFor).join(' > ');
}
