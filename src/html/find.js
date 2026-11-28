import { Worker } from 'node:worker_threads';

import { ClayError } from '../errors.js';
import { located, parse, pathOf } from './source.js';

const SNIPPET_MAX = 80;

function lineStarts(html) {
  const starts = [];
  let index = html.indexOf('\n');
  while (index !== -1) {
    starts.push(index);
    index = html.indexOf('\n', index + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

function elementIndex($) {
  const items = [];
  for (const el of $('*').toArray()) {
    const loc = located(el);
    if (loc) items.push({ ...loc, el });
  }
  return items;
}

function enclosing(items, offset) {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].start <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = found; i >= 0; i -= 1) {
    if (items[i].end > offset) return items[i].el;
  }
  return null;
}

function snippet(html, start, end) {
  const matchLength = end - start;
  if (matchLength >= SNIPPET_MAX) return html.slice(start, start + SNIPPET_MAX);
  const budget = SNIPPET_MAX - matchLength;
  const before = Math.min(Math.floor(budget / 2), start);
  const after = Math.min(budget - before, html.length - end);
  return html.slice(start - before, end + after);
}

function literalMatches(html, text, onMatch) {
  let from = 0;
  for (;;) {
    const start = html.indexOf(text, from);
    if (start === -1) return;
    onMatch(start, start + text.length);
    from = start + text.length;
  }
}

const REGEX_DEADLINE_MS = 2000;
let runningRegexWorkers = 0;

async function regexRanges(html, source, max, workerLimit = Infinity) {
  if (runningRegexWorkers >= workerLimit) {
    throw new ClayError('busy', 'Too many searches are running. Try again in a few seconds.', {
      hint: 'Search with text instead of regex, or retry shortly.',
    });
  }
  runningRegexWorkers += 1;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./regex-worker.js', import.meta.url), {
        workerData: { html, source, max },
      });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(
          new ClayError('find-timeout', 'That regular expression took too long on this file.', {
            hint: 'Use a simpler pattern, or pass `text` for a literal search.',
          }),
        );
      }, REGEX_DEADLINE_MS);
      worker.once('message', (result) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(result);
      });
      worker.once('error', () => {
        clearTimeout(timer);
        reject(new ClayError('internal', 'The regular expression search failed.'));
      });
    });
  } finally {
    runningRegexWorkers -= 1;
  }
}

export async function find(html, { text, regex, limit = 20, parseLimit = Infinity, workerLimit = Infinity } = {}) {
  const hasText = text !== undefined && text !== null;
  const hasRegex = regex !== undefined && regex !== null;
  if (hasText === hasRegex) {
    throw new ClayError('invalid-find', 'Pass exactly one of `text` or `regex`.', {
      hint: 'Give a literal string as `text`, or a regular expression source as `regex`.',
    });
  }
  if (hasText && (typeof text !== 'string' || text.length === 0)) {
    throw new ClayError('invalid-find', '`text` must be a non-empty string.', {
      hint: 'Pass the exact characters to look for.',
    });
  }
  if (hasRegex && typeof regex !== 'string') {
    throw new ClayError('invalid-find', '`regex` must be a string.', {
      hint: 'Pass a JavaScript regular expression source string.',
    });
  }
  const max = Number.isInteger(limit) && limit > 0 ? limit : 0;
  let count = 0;
  let ranges = [];
  if (hasText) {
    const onMatch = (start, end) => {
      count += 1;
      if (ranges.length < max) ranges.push({ start, end });
    };
    literalMatches(html, text, onMatch);
  } else {
    try {
      new RegExp(regex, 'g');
    } catch {
      throw new ClayError('invalid-find', `That is not a valid regular expression: ${regex}`, {
        hint: 'Pass a JavaScript regular expression source string, such as `id="[0-9]+"`.',
      });
    }
    const result = await regexRanges(html, regex, max, workerLimit);
    count = result.count;
    ranges = result.ranges;
  }
  if (hasText && html.length > parseLimit) {
    const starts = lineStarts(html);
    const matches = ranges.map(({ start, end }) => ({
      start,
      end,
      line: lineAt(starts, start),
      path: null,
      snippet: snippet(html, start, end),
    }));
    return { count, matches, elementPaths: false };
  }
  if (count === 0) return { count, matches: [] };
  const { $ } = parse(html);
  const starts = lineStarts(html);
  const items = elementIndex($);
  const matches = ranges.map(({ start, end }) => {
    const el = enclosing(items, start);
    return {
      start,
      end,
      line: lineAt(starts, start),
      path: el ? pathOf(el) : null,
      snippet: snippet(html, start, end),
    };
  });
  return { count, matches };
}
