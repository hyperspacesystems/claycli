import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyEdits } from '../src/html/edit.js';
import { find } from '../src/html/find.js';
import { outline } from '../src/html/outline.js';
import { range, select } from '../src/html/select.js';
import { located, parse, pathOf } from '../src/html/source.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = fs.readFileSync(path.join(here, 'fixtures', 'board.html'), 'utf8');

function largeDocument() {
  const head = BOARD.slice(BOARD.indexOf('<head>'), BOARD.indexOf('</head>') + '</head>'.length);
  const rows = Array.from(
    { length: 20000 },
    (_, i) =>
      `<li class="row"><span class="label">Item ${i}</span> alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega and a few more words to make this document large enough.</li>`,
  ).join('\n');
  return `<!doctype html>\n<html lang="en">\n${head}\n<body>\n  <main id="board">\n    <h1>Large board</h1>\n    <ul class="rows">\n${rows}\n    </ul>\n  </main>\n</body>\n</html>\n`;
}

const LARGE = largeDocument();

function flatten(entries) {
  const out = [];
  for (const entry of entries) {
    out.push(entry);
    if (entry.children) out.push(...flatten(entry.children));
  }
  return out;
}

test('pathOf round-trips through a cheerio selector', () => {
  const { $ } = parse(BOARD);
  let checked = 0;
  for (const el of $('*').toArray()) {
    if (!located(el)) continue;
    checked += 1;
    const selector = pathOf(el);
    assert.equal($(selector)[0], el, `selector ${selector} did not select its own element`);
  }
  assert.ok(checked > 20);
});

test('select slices the exact source, entities included, and finds table rows', () => {
  const result = select(BOARD, 'article.card');
  assert.equal(result.count, 9);
  assert.equal(result.matches.length, 9);
  for (const match of result.matches) {
    assert.equal(match.html, BOARD.slice(match.start, match.end));
    assert.equal(match.truncated, undefined);
  }
  assert.ok(result.matches[0].html.includes('First &amp; best'));
  assert.ok(!result.matches[0].html.includes('&amp;amp;'));

  const heading = select(BOARD, 'h1');
  assert.ok(heading.matches[0].html.includes('Café'));

  const rows = select(BOARD, 'tr');
  assert.equal(rows.count, 3);
  for (const row of rows.matches) {
    assert.equal(row.html, BOARD.slice(row.start, row.end));
    assert.ok(row.html.startsWith('<tr>'));
    assert.ok(row.path.includes('tbody'));
  }

  const narrow = select(BOARD, 'article.card', { maxChars: 20 });
  assert.equal(narrow.matches[0].html.length, 20);
  assert.equal(narrow.matches[0].truncated, true);
});

test('outline reports api rules and collapses repeated cards', () => {
  const result = outline(BOARD);
  assert.equal(result.hasApiRules, true);
  assert.deepEqual(result.dataKeys, ['columns', 'title']);
  assert.equal(result.size, BOARD.length);

  const entries = flatten(result.outline);
  const section = entries.find((entry) => entry.tag === 'section');
  assert.equal(section.repeated, 3);
  assert.equal(section.lastPath, 'main#board > section.column:nth-of-type(3)');

  const card = section.children.find((entry) => entry.tag === 'article');
  assert.equal(card.repeated, 3);
  assert.equal(card.class, 'card');
  assert.equal(card.lastPath, 'main#board > section.column:nth-of-type(1) > article.card:nth-of-type(3)');

  const scripts = entries.filter((entry) => entry.tag === 'script');
  assert.ok(scripts.length >= 2);
  for (const script of scripts) {
    assert.equal('text' in script, false);
    assert.equal('children' in script, false);
  }
  const api = scripts.find((entry) => entry.type === 'application/json');
  assert.ok(api);

  const style = entries.find((entry) => entry.tag === 'style');
  assert.equal('text' in style, false);
  assert.equal('children' in style, false);
});

test('a rules script named "cms api" with any type is found', () => {
  for (const type of ['application/json', 'application/rules+json', null]) {
    const attribute = type === null ? '' : ` type="${type}"`;
    const html = `<!doctype html><html><head><script${attribute} data-rules-name="cms api">{"a":1}</script></head><body><h1>Hi</h1></body></html>`;
    const result = outline(html);
    assert.equal(result.hasApiRules, true, String(type));
    assert.deepEqual(result.dataKeys, ['a'], String(type));
  }

  const broken = outline(
    '<!doctype html><html><head><script data-rules-name="api">{ not json</script></head><body></body></html>',
  );
  assert.equal(broken.hasApiRules, true);
  assert.deepEqual(broken.dataKeys, []);
});

test('the depth-4 outline of the 5 MB page stays small and collapses 20,000 rows', () => {
  assert.ok(LARGE.length > 4_500_000);
  const result = outline(LARGE, { depth: 4 });
  const json = JSON.stringify(result.outline);
  assert.ok(json.length < 8000, `outline JSON was ${json.length} characters`);
  const row = flatten(result.outline).find((entry) => entry.tag === 'li');
  assert.equal(row.repeated, 20000);
  assert.equal(row.lastPath, 'main#board > ul.rows > li.row:nth-of-type(20000)');
  assert.ok(row.chars > 4_000_000);
});

test('find reports line, enclosing path and snippet, and an empty regex terminates', async () => {
  const result = await find(BOARD, { text: 'Write notes.' });
  assert.equal(result.count, 1);
  const offset = BOARD.indexOf('Write notes.');
  assert.equal(result.matches[0].line, BOARD.slice(0, offset).split('\n').length);
  assert.match(result.matches[0].path, /article\.card:nth-of-type\(2\)/);
  assert.ok(result.matches[0].snippet.includes('Write notes.'));
  assert.ok(result.matches[0].snippet.includes('\n'));

  const anchored = await find(BOARD, { regex: '^', limit: 5 });
  assert.ok(anchored.count >= 1);
  assert.ok(anchored.matches.length <= 5);

  const many = await find(BOARD, { text: 'card', limit: 2 });
  assert.ok(many.count > 2);
  assert.equal(many.matches.length, 2);

  await assert.rejects(() => find(BOARD, {}), { code: 'invalid-find' });
  await assert.rejects(() => find(BOARD, { text: 'a', regex: 'a' }), { code: 'invalid-find' });
});

test('applyEdits applies unique edits and refuses missing, repeated and overlapping ones', () => {
  const unique = applyEdits(BOARD, [{ find: 'Write notes.', replace: 'Write more notes.' }]);
  assert.equal(unique.applied, 1);
  assert.ok(unique.html.includes('Write more notes.'));
  assert.equal(unique.html.split('Write notes.').length, 1);

  assert.throws(() => applyEdits(BOARD, [{ find: 'no such text here', replace: 'x' }]), (error) => {
    assert.equal(error.code, 'edit-not-found');
    assert.deepEqual(error.details, { index: 0 });
    return true;
  });

  assert.throws(() => applyEdits(BOARD, [{ find: 'article class="card"', replace: 'x' }]), (error) => {
    assert.equal(error.code, 'edit-not-unique');
    assert.equal(error.details.index, 0);
    assert.equal(error.details.count, 9);
    assert.equal(error.details.offsets.length, 5);
    assert.equal(error.details.offsets[0], BOARD.indexOf('article class="card"'));
    return true;
  });

  const second = applyEdits(BOARD, [{ find: 'Doing', replace: 'Working', occurrence: 2 }]);
  assert.ok(second.html.includes('Working two'));
  assert.ok(second.html.includes('Doing one'));
  assert.ok(second.html.includes('Doing three'));

  assert.throws(() => applyEdits(BOARD, [{ find: 'Doing', replace: 'x', occurrence: 4 }]), {
    code: 'edit-not-found',
  });

  const before = BOARD;
  assert.throws(
    () =>
      applyEdits(BOARD, [
        { find: '<h2>First &amp; best</h2>', replace: 'X' },
        { find: 'First &amp; best', replace: 'Y' },
      ]),
    (error) => {
      assert.equal(error.code, 'edits-overlap');
      assert.deepEqual(error.details.indexes, [0, 1]);
      return true;
    },
  );
  assert.equal(BOARD, before);

  const edits = [
    { find: 'Plan the day.', replace: 'Plan the week.' },
    { find: 'Write notes.', replace: 'Take notes.' },
    { find: 'Ship it.', replace: 'Ship it today.' },
  ];
  const together = applyEdits(BOARD, edits);
  assert.equal(together.applied, 3);
  const stepByStep = edits.reduce((html, edit) => applyEdits(html, [edit]).html, BOARD);
  assert.equal(together.html, stepByStep);

  assert.throws(() => applyEdits(BOARD, []), { code: 'invalid-edits' });
  assert.throws(() => applyEdits(BOARD, [{ find: '', replace: 'x' }]), { code: 'invalid-edits' });
});

test('a slice copied from select is found once by applyEdits', () => {
  const [first] = select(BOARD, 'article.card', { limit: 1 }).matches;
  assert.ok(first.html.includes('&amp;'));
  const result = applyEdits(BOARD, [
    { find: first.html, replace: '<article class="card"><p>Replaced.</p></article>' },
  ]);
  assert.equal(result.applied, 1);
  assert.equal(result.html.split('Replaced.').length, 2);
  assert.ok(result.html.includes('First &amp; best') === false);
  assert.equal(result.html.length, BOARD.length - first.html.length + '<article class="card"><p>Replaced.</p></article>'.length);
});

test('outline, select and find each stay under 3 seconds on the 5 MB page', async (t) => {
  const startedOutline = performance.now();
  outline(LARGE, { depth: 4 });
  const outlineMs = performance.now() - startedOutline;

  const startedSelect = performance.now();
  select(LARGE, 'li.row', { limit: 5 });
  const selectMs = performance.now() - startedSelect;

  const startedFind = performance.now();
  await find(LARGE, { text: 'Item 19999', limit: 5 });
  const findMs = performance.now() - startedFind;

  t.diagnostic(`outline ${outlineMs.toFixed(0)}ms, select ${selectMs.toFixed(0)}ms, find ${findMs.toFixed(0)}ms`);
  assert.ok(outlineMs < 3000, `outline took ${outlineMs}ms`);
  assert.ok(selectMs < 3000, `select took ${selectMs}ms`);
  assert.ok(findMs < 3000, `find took ${findMs}ms`);
});

test('range clamps to the document and rejects bad input', () => {
  const slice = range(BOARD, 0, 20);
  assert.equal(slice.html, BOARD.slice(0, 20));
  assert.equal(slice.start, 0);
  assert.equal(slice.end, 20);
  const tail = range(BOARD, BOARD.length - 5, 100);
  assert.equal(tail.end, BOARD.length);
  assert.equal(tail.html, BOARD.slice(BOARD.length - 5));
  assert.throws(() => range(BOARD, -1, 2), { code: 'invalid-range' });
  assert.throws(() => range(BOARD, 1.5, 2), { code: 'invalid-range' });
  assert.throws(() => range(BOARD, 0, -2), { code: 'invalid-range' });
});

test('paths count same-name siblings per parent without repeating the scan', () => {
  const html = '<html><body><ul><li>a</li><li>b</li><li>c</li></ul><div><p>one</p><p>two</p></div></body></html>';
  const { $ } = parse(html);
  const items = $('li').toArray().map(pathOf);
  assert.deepEqual(items, [
    'html > body > ul > li:nth-of-type(1)',
    'html > body > ul > li:nth-of-type(2)',
    'html > body > ul > li:nth-of-type(3)',
  ]);
  assert.deepEqual($('p').toArray().map(pathOf), [
    'html > body > div > p:nth-of-type(1)',
    'html > body > div > p:nth-of-type(2)',
  ]);
  for (const el of $('*').toArray()) {
    if (!located(el)) continue;
    assert.equal($(pathOf(el))[0], el);
  }
});

function sectionPage(count) {
  const sections = Array.from(
    { length: count },
    (_, i) =>
      `  <section class="panel-${i}"><h2>Title number ${i}</h2><p>Some body text for section ${i}.</p><ul><li>alpha</li><li>beta</li></ul><p class="muted">Footnote ${i}</p></section>`,
  ).join('\n');
  return `<!doctype html>\n<html lang="en">\n<head><title>Budget</title></head>\n<body>\n<main id="board">\n${sections}\n</main>\n</body>\n</html>\n`;
}

test('the outline of a 40 KB page stays within 8000 characters and says it was cut', () => {
  const html = sectionPage(250);
  assert.ok(html.length > 40_000, `page was ${html.length} characters`);
  const result = outline(html);
  const json = JSON.stringify(result.outline);
  assert.ok(json.length <= 8000, `outline JSON was ${json.length} characters`);
  assert.equal(result.truncated, true);
  assert.ok(result.depth < 4, `depth was ${result.depth}`);
  assert.equal(result.hint, 'Part of the outline is hidden. Outline one part with select (a path from this outline), or use find_in_document.');
});

test('the outline of 12,000 siblings is fast, bounded and ends with a more entry', () => {
  const divs = Array.from(
    { length: 12000 },
    (_, i) => `<div class="${i % 2 === 0 ? 'a' : 'b'}">Item ${i}</div>`,
  ).join('\n');
  const html = `<!doctype html>\n<html>\n<head><title>Many</title></head>\n<body>\n<main>\n${divs}\n</main>\n</body>\n</html>\n`;
  const started = performance.now();
  const result = outline(html, { depth: 4 });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `outline took ${elapsed}ms`);
  assert.ok(JSON.stringify(result.outline).length <= 8000);
  assert.equal(result.truncated, true);
  const main = flatten(result.outline).find((entry) => entry.tag === 'main');
  const hidden = main.children.at(-1);
  assert.equal(hidden.more, 11960);
  assert.equal(hidden.start, html.indexOf('<div class="a">Item 40</div>'));
  assert.equal(hidden.end, html.lastIndexOf('Item 11999') + 'Item 11999</div>'.length);
  assert.equal(hidden.path, undefined);
});

test('a small page outline keeps its shape, with chars, depth and truncated', () => {
  const result = outline(BOARD);
  assert.equal(result.depth, 4);
  assert.equal(result.truncated, false);
  assert.equal('hint' in result, false);
  const entries = flatten(result.outline);
  const section = entries.find((entry) => entry.tag === 'section');
  assert.equal(section.bytes, undefined);
  assert.equal(section.chars, section.end - section.start);
});

test('select shares one maxChars budget across every match', () => {
  let inner = '';
  for (let i = 0; i < 20; i += 1) inner = `<div class="d${i}"><span>${'x'.repeat(2500)}</span>${inner}</div>`;
  const html = `<!doctype html><html><body><main>${inner}</main></body></html>`;
  assert.ok(html.length > 50_000, `page was ${html.length} characters`);
  const result = select(html, 'div', { limit: 20, maxChars: 40000 });
  assert.equal(result.matches.length, 20);
  const total = result.matches.reduce((sum, match) => sum + (match.html?.length ?? 0), 0);
  assert.ok(total <= 40000, `select returned ${total} characters`);
  assert.equal(result.matches[0].truncated, true);
  const later = result.matches.slice(1);
  for (const match of later) {
    assert.equal(match.truncated, true);
    assert.equal('html' in match, false);
    assert.equal(typeof match.start, 'number');
    assert.equal(typeof match.end, 'number');
  }
});

test('a find snippet keeps the real newline so it can be pasted into an edit', async () => {
  const html = '<html><body><p>first line\nsecond line</p></body></html>';
  const result = await find(html, { text: 'first line\nsecond line' });
  assert.equal(result.count, 1);
  assert.ok(result.matches[0].snippet.includes('first line\nsecond line'));
  assert.equal(result.matches[0].snippet.includes('\\n'), false);
});

test('an overlapping edit is ambiguous, and occurrence picks one of the overlaps', () => {
  assert.throws(() => applyEdits('<p>banana</p>', [{ find: 'ana', replace: 'X' }]), (error) => {
    assert.equal(error.code, 'edit-not-unique');
    assert.equal(error.details.count, 2);
    assert.deepEqual(error.details.offsets, [4, 6]);
    return true;
  });
  const second = applyEdits('<p>banana</p>', [{ find: 'ana', replace: 'X', occurrence: 2 }]);
  assert.equal(second.html, '<p>banX</p>');
});
