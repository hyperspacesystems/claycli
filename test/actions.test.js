import assert from 'node:assert/strict';
import test from 'node:test';

import { createActions } from '../src/actions.js';
import { ClayError } from '../src/errors.js';
import { createSession } from '../src/session.js';
import { resolveTarget } from '../src/target.js';

const ORIGINAL = `<!doctype html>
<html><head><title>Board</title></head>
<body>
<main id="board">
<h1>Board</h1>
<section class="card"><p>First card</p></section>
<section class="card"><p>Second card</p></section>
</main>
</body></html>
`;

const KEY = `hcak_${'a'.repeat(64)}`;

function nextEtag(prefix, current) {
  return `${prefix}${Number(current.slice(1)) + 1}`;
}

function fakeAdapter({ html = ORIGINAL } = {}) {
  const state = {
    html,
    etag: 'E1',
    data: { title: 'Notes' },
    dataEtag: 'D1',
    lastSaveEtag: null,
  };
  const calls = {
    locate: 0,
    list: 0,
    read: 0,
    notModified: 0,
    readData: 0,
    writeData: 0,
    save: 0,
    versions: 0,
    version: 0,
    restore: 0,
    claimSubdomain: 0,
  };

  const adapter = {
    async locate(target) {
      calls.locate += 1;
      const id = target.id ?? '1';
      return { id, ref: target.ref ?? `hyperclay:${id}` };
    },
    async list({ where, cursor } = {}) {
      calls.list += 1;
      return {
        documents: [
          {
            ref: 'hyperclay:1',
            host: 'hyperclay',
            name: 'index.html',
            url: 'https://hyperclay.com/d/1',
            path: 'index.html',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
        where,
        cursor,
      };
    },
    async read(id, { ifNoneMatch } = {}) {
      calls.read += 1;
      if (ifNoneMatch && ifNoneMatch === state.etag) {
        calls.notModified += 1;
        return { notModified: true, etag: ifNoneMatch };
      }
      return { id, etag: state.etag, html: state.html, size: state.html.length };
    },
    async readData() {
      calls.readData += 1;
      return { data: state.data, etag: state.dataEtag };
    },
    async writeData(id, { data, etag } = {}) {
      calls.writeData += 1;
      if (etag !== state.dataEtag) {
        throw new ClayError('conflict', 'The data changed.', { etag: state.dataEtag });
      }
      state.data = data;
      state.dataEtag = nextEtag('D', state.dataEtag);
      return { data: state.data, etag: state.dataEtag, changed: true };
    },
    async save(id, { html: next, etag } = {}) {
      calls.save += 1;
      state.lastSaveEtag = etag;
      if (etag !== state.etag) {
        throw new ClayError('conflict', 'The document changed.', {
          etag: state.etag,
          hint: 'Read it again and redo the edit.',
        });
      }
      state.html = next;
      state.etag = nextEtag('E', state.etag);
      return { etag: state.etag, changed: true, undoVersionId: 'v2' };
    },
    async versions() {
      calls.versions += 1;
      return { versions: [{ id: 'v1', createdAt: '2024-01-01T00:00:00.000Z', kind: 'edit' }], nextBefore: null };
    },
    async version(id, versionId) {
      calls.version += 1;
      return { id: versionId, createdAt: '2024-01-01T00:00:00.000Z', etag: 'V9', html: '<h1>Old</h1>' };
    },
    async restore(id, versionId, { etag } = {}) {
      calls.restore += 1;
      if (etag !== state.etag) {
        throw new ClayError('conflict', 'The document changed.', { etag: state.etag });
      }
      state.etag = nextEtag('E', state.etag);
      return { etag: state.etag };
    },
    async claimSubdomain(id, subdomain) {
      calls.claimSubdomain += 1;
      state.subdomain = subdomain;
      return { subdomain, url: `https://${subdomain}.hyperclay.com`, changed: true, warnings: [{ code: 'dns-pending' }] };
    },
  };

  return { state, calls, adapter };
}

function actionsFor(fake, options = {}) {
  const resolve = async (document, { host } = {}) => {
    if (document === 'hyperclay:1') return { host: 'hyperclay', id: '1', ref: 'hyperclay:1' };
    return resolveTarget(document, {
      hostOverride: host ?? null,
      discovered: { htmlClay: null, hyperclayLocal: null, clay: null },
    });
  };
  return createActions({ adapters: { hyperclay: fake.adapter }, resolve, ...options });
}

test('save_document before any read refuses read-first', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  await assert.rejects(actions.save_document({ document: 'hyperclay:1', html: '<p>Hi</p>' }), (error) => {
    assert.equal(error.code, 'read-first');
    return true;
  });

  assert.equal(fake.calls.save, 0);
});

test('save_document after a read sends the read etag', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  const read = await actions.read_document({ document: 'hyperclay:1' });
  assert.equal(read.etag, 'E1');

  const saved = await actions.save_document({ document: 'hyperclay:1', html: '<h1>New</h1>' });
  assert.equal(saved.etag, 'E2');
  assert.equal(saved.changed, true);
  assert.equal(fake.calls.save, 1);
  assert.equal(fake.state.lastSaveEtag, 'E1');
  assert.equal(fake.state.html, '<h1>New</h1>');
});

test('explicitEtag refuses a save without an etag even after a read', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake, { explicitEtag: true });

  await actions.read_document({ document: 'hyperclay:1' });

  await assert.rejects(actions.save_document({ document: 'hyperclay:1', html: '<p>Hi</p>' }), (error) => {
    assert.equal(error.code, 'read-first');
    assert.match(error.hint, /--if-match/);
    return true;
  });

  assert.equal(fake.calls.save, 0);
});

test('edit_document applies one unique edit and saves it', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  await actions.read_document({ document: 'hyperclay:1' });
  const expected = ORIGINAL.replace('First card', 'Edited card');

  const result = await actions.edit_document({
    document: 'hyperclay:1',
    edits: [{ find: 'First card', replace: 'Edited card' }],
  });

  assert.equal(result.changed, true);
  assert.equal(result.etag, 'E2');
  assert.equal(result.chars, expected.length);
  assert.equal(fake.state.html, expected);
  assert.equal(fake.state.lastSaveEtag, 'E1');
});

test('edit_document refuses a conflict before saving when the document moved on', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  await actions.read_data({ document: 'hyperclay:1' });
  fake.state.etag = 'E9';

  await assert.rejects(
    actions.edit_document({ document: 'hyperclay:1', edits: [{ find: 'First card', replace: 'Edited' }] }),
    (error) => {
      assert.equal(error.code, 'conflict');
      assert.equal(error.etag, 'E9');
      return true;
    },
  );

  assert.equal(fake.calls.save, 0);
});

test('three selects on one version transfer the html once', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  const first = await actions.read_document({ document: 'hyperclay:1', select: 'main' });
  const second = await actions.read_document({ document: 'hyperclay:1', select: 'section.card' });
  const third = await actions.read_document({ document: 'hyperclay:1', select: 'h1' });

  assert.equal(first.count, 1);
  assert.equal(second.count, 2);
  assert.equal(third.count, 1);
  assert.equal(third.matches[0].html, '<h1>Board</h1>');
  assert.equal(fake.calls.read, 3);
  assert.equal(fake.calls.notModified, 2);
});

test('a document larger than maxChars comes back as an outline', async () => {
  const big = `<html><body><main id="board"><p>${'x'.repeat(300)}</p></main></body></html>`;
  const fake = fakeAdapter({ html: big });
  const actions = actionsFor(fake);

  const result = await actions.read_document({ document: 'hyperclay:1', maxChars: 50 });

  assert.equal(result.tooLarge, true);
  assert.equal(result.size, big.length);
  assert.ok(Array.isArray(result.outline));
  assert.ok(result.outline.length > 0);
  assert.match(result.hint, /outline_document/);
  assert.equal('html' in result, false);
});

test('read-only mode refuses every write and calls nothing', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake, { readOnly: true });
  const document = 'hyperclay:1';

  const writes = [
    () => actions.write_data({ document, data: { title: 'x' } }),
    () => actions.edit_document({ document, edits: [{ find: 'First card', replace: 'x' }] }),
    () => actions.save_document({ document, html: '<p>x</p>' }),
    () => actions.restore_version({ document, version: 'v1' }),
    () => actions.claim_subdomain({ document, subdomain: 'my-tool' }),
  ];

  for (const write of writes) {
    await assert.rejects(write(), (error) => {
      assert.equal(error.code, 'read-only-mode');
      assert.equal(error.message, 'This server was started read-only.');
      return true;
    });
  }

  for (const [name, count] of Object.entries(fake.calls)) {
    assert.equal(count, 0, `${name} was called`);
  }
});

test('claim_subdomain returns the subdomain, url, changed and warnings', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  const result = await actions.claim_subdomain({ document: 'hyperclay:1', subdomain: 'my-tool' });

  assert.deepEqual(result, {
    ref: 'hyperclay:1',
    host: 'hyperclay',
    subdomain: 'my-tool',
    url: 'https://my-tool.hyperclay.com',
    changed: true,
    warnings: [{ code: 'dns-pending' }],
  });
  assert.equal(fake.calls.claimSubdomain, 1);
  assert.equal(fake.state.subdomain, 'my-tool');
  assert.equal(fake.state.etag, 'E1');
  assert.equal(result.etag, undefined);
});

test('save_document refuses html that contains an agent key', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  await assert.rejects(
    actions.save_document({ document: 'hyperclay:1', html: `<p>${KEY}</p>` }),
    (error) => {
      assert.equal(error.code, 'secret-in-content');
      return true;
    },
  );

  assert.equal(fake.calls.save, 0);
});

test('read_data then write_data without an etag uses the data read etag', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  const read = await actions.read_data({ document: 'hyperclay:1' });
  assert.equal(read.etag, 'D1');
  assert.deepEqual(read.data, { title: 'Notes' });

  const written = await actions.write_data({ document: 'hyperclay:1', data: { title: 'Updated' } });

  assert.equal(written.etag, 'D2');
  assert.equal(written.changed, true);
  assert.deepEqual(written.data, { title: 'Updated' });
  assert.equal(fake.calls.writeData, 1);
});

test('edit_document refuses a find that occurs twice', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  await actions.read_document({ document: 'hyperclay:1' });

  await assert.rejects(
    actions.edit_document({
      document: 'hyperclay:1',
      edits: [{ find: '<section class="card">', replace: '<section>' }],
    }),
    (error) => {
      assert.equal(error.code, 'edit-not-unique');
      return true;
    },
  );

  assert.equal(fake.calls.save, 0);
});

test('read_version returns the version html and does not touch the session etag', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  await actions.read_document({ document: 'hyperclay:1' });

  const version = await actions.read_version({ document: 'hyperclay:1', version: 'v1' });
  assert.equal(version.version, 'v1');
  assert.equal(version.html, '<h1>Old</h1>');

  const saved = await actions.save_document({ document: 'hyperclay:1', html: '<p>From the read</p>' });
  assert.equal(saved.etag, 'E2');
  assert.equal(fake.state.lastSaveEtag, 'E1');
});

test('session keeps only the most recently read html under maxBytes', () => {
  const session = createSession({ maxBytes: 100 });
  const first = 'a'.repeat(60);
  const second = 'b'.repeat(60);
  const third = 'c'.repeat(60);

  session.remember('hyperclay:1', { etag: 'E1', html: first });
  session.remember('hyperclay:2', { etag: 'E2', html: second });
  session.remember('hyperclay:3', { etag: 'E3', html: third });

  assert.equal(session.htmlFor('hyperclay:1', 'E1'), null);
  assert.equal(session.htmlFor('hyperclay:2', 'E2'), null);
  assert.equal(session.htmlFor('hyperclay:3', 'E3'), third);
  assert.deepEqual(session.latest('hyperclay:3'), { etag: 'E3', html: third });
  assert.equal(session.latest('hyperclay:1'), null);
});

test('a read_data etag never authorizes a write over a change the agent did not see', async () => {
  const fake = fakeAdapter();
  fake.state.dataEtag = 'E1';
  const actions = actionsFor(fake);

  await actions.read_data({ document: 'hyperclay:1' });

  const changed = ORIGINAL.replace('First card', 'DAVID ADDED THIS');
  fake.state.etag = 'E2';
  fake.state.html = changed;

  await assert.rejects(
    actions.edit_document({ document: 'hyperclay:1', edits: [{ find: 'Second card', replace: 'TWO' }] }),
    (error) => {
      assert.equal(error.code, 'conflict');
      assert.equal(error.etag, 'E2');
      return true;
    },
  );

  await assert.rejects(
    actions.save_document({ document: 'hyperclay:1', html: '<html><body><p>TWO</p></body></html>' }),
    (error) => {
      assert.equal(error.code, 'read-first');
      assert.match(error.hint, /whole document/);
      return true;
    },
  );

  assert.equal(fake.calls.save, 0);
  assert.equal(fake.state.html, changed);
});

test('a partial read after a change does not authorize a whole save', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  const read = await actions.read_document({ document: 'hyperclay:1' });
  assert.equal(read.etag, 'E1');

  const changed = ORIGINAL.replace('First card', 'DAVID ADDED THIS');
  fake.state.etag = 'E2';
  fake.state.html = changed;

  const found = await actions.find_in_document({ document: 'hyperclay:1', text: 'DAVID ADDED THIS' });
  assert.equal(found.etag, 'E2');
  assert.equal(found.count, 1);

  await assert.rejects(
    actions.save_document({ document: 'hyperclay:1', html: '<html><body><p>TWO</p></body></html>' }),
    (error) => {
      assert.equal(error.code, 'conflict');
      assert.equal(error.etag, 'E2');
      return true;
    },
  );

  assert.equal(fake.state.lastSaveEtag, 'E1');
  assert.equal(fake.state.html, changed);
});

test('a failed read_document does not authorize an edit', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  await assert.rejects(
    actions.read_document({ document: 'hyperclay:1', select: '>>>bad' }),
    (error) => {
      assert.equal(error.code, 'invalid-selector');
      return true;
    },
  );

  await assert.rejects(
    actions.edit_document({ document: 'hyperclay:1', edits: [{ find: 'First card', replace: 'X' }] }),
    (error) => {
      assert.equal(error.code, 'read-first');
      return true;
    },
  );

  assert.equal(fake.calls.save, 0);
});

test('after a save the next read downloads fresh instead of answering 304', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  await actions.read_document({ document: 'hyperclay:1' });
  const saved = await actions.save_document({ document: 'hyperclay:1', html: '<html><body><p>New</p></body></html>' });
  assert.equal(saved.etag, 'E2');

  const read = await actions.read_document({ document: 'hyperclay:1' });
  assert.equal(read.etag, 'E2');
  assert.equal(read.html, '<html><body><p>New</p></body></html>');
  assert.equal(fake.calls.read, 2);
  assert.equal(fake.calls.notModified, 0);
});

test('write_data refuses an agent key in a nested value or a property name', async () => {
  const fake = fakeAdapter();
  const actions = actionsFor(fake);

  await assert.rejects(
    actions.write_data({ document: 'hyperclay:1', data: { note: { text: `setup ${KEY}` } } }),
    (error) => {
      assert.equal(error.code, 'secret-in-content');
      return true;
    },
  );

  await assert.rejects(
    actions.write_data({ document: 'hyperclay:1', data: { [KEY]: 'value' } }),
    (error) => {
      assert.equal(error.code, 'secret-in-content');
      return true;
    },
  );

  assert.equal(fake.calls.writeData, 0);
});

test('a range longer than maxChars comes back cut, with the hint', async () => {
  const body = `${'<p>alpha beta gamma delta epsilon</p>'.repeat(3000)}`;
  const html = `<!doctype html><html><body><main>${body}</main></body></html>`;
  assert.ok(html.length > 100_000, `page was ${html.length} characters`);
  const fake = fakeAdapter({ html });
  const actions = actionsFor(fake);

  const result = await actions.read_document({
    document: 'hyperclay:1',
    range: { start: 0, length: 10_000_000 },
    maxChars: 40000,
  });
  assert.equal(result.html.length, 40000);
  assert.equal(result.start, 0);
  assert.equal(result.end, 40000);
  assert.equal(result.truncated, true);
  assert.equal(
    result.hint,
    'The answer was cut to stay within maxChars. Read the rest with range, starting at the end offset shown.',
  );
});

test('a catastrophic regex times out in the worker and the session still answers', async () => {
  const fake = fakeAdapter({ html: `<p>${'a'.repeat(40)}!</p>` });
  const actions = actionsFor(fake);

  const started = performance.now();
  await assert.rejects(
    actions.find_in_document({ document: 'hyperclay:1', regex: '(a+)+$' }),
    (error) => {
      assert.equal(error.code, 'find-timeout');
      return true;
    },
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 3000, `the timeout took ${elapsed}ms`);

  const found = await actions.find_in_document({ document: 'hyperclay:1', text: 'aaaa!' });
  assert.equal(found.count, 1);
  assert.equal(found.matches.length, 1);
});
