import { ClayError } from '../errors.js';
import { located, parse, pathOf } from './source.js';

export function select(html, css, { limit = 20, maxChars = 40000 } = {}) {
  const { $ } = parse(html);
  let found;
  try {
    if (typeof css !== 'string' || !css.trim()) throw new Error('empty selector');
    found = $(css).toArray();
  } catch {
    throw new ClayError('invalid-selector', `That is not a valid CSS selector: ${css}`, {
      hint: 'Pass a selector such as `article.card` or `main#board > section`.',
    });
  }
  const locatedMatches = [];
  for (const el of found) {
    const loc = located(el);
    if (!loc) continue;
    locatedMatches.push({ el, ...loc });
  }
  let remaining = maxChars;
  const matches = locatedMatches.slice(0, Math.max(0, limit)).map(({ el, start, end }) => {
    const match = { path: pathOf(el), start, end };
    if (remaining <= 0) {
      match.truncated = true;
      return match;
    }
    const take = Math.min(end - start, remaining);
    match.html = html.slice(start, start + take);
    if (take < end - start) match.truncated = true;
    remaining -= take;
    return match;
  });
  return { count: locatedMatches.length, matches };
}

export function range(html, start, length, { maxChars = Infinity } = {}) {
  if (!Number.isInteger(start) || start < 0) {
    throw new ClayError('invalid-range', 'The range start must be a non-negative whole number.', {
      hint: 'Pass a start offset from a read, such as 0.',
    });
  }
  if (!Number.isInteger(length) || length < 0) {
    throw new ClayError('invalid-range', 'The range length must be a non-negative whole number.', {
      hint: 'Pass the number of characters to read.',
    });
  }
  const from = Math.min(start, html.length);
  const full = Math.min(from + length, html.length);
  const to = Math.min(from + length, html.length, from + maxChars);
  const result = { start: from, end: to, html: html.slice(from, to) };
  if (to < full) result.truncated = true;
  return result;
}
