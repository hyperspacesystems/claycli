import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClayError } from '../src/errors.js';
import { etagOf, planPublish, readLocal, runPublish, walkFolder } from '../src/publish.js';

async function folder(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clay-publish-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relPath, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relPath)), { recursive: true });
    await fs.writeFile(path.join(root, relPath), contents);
  }
  return root;
}

test('walks a site, skips hidden, tooling and linked entries, and plans against the remote listing', async (t) => {
  const root = await folder(t, {
    'index.html': '<html></html>',
    'about.html': '<html>about</html>',
    'css/style.css': 'body{}',
    'img/logo.png': Buffer.from([137, 80, 78, 71]),
    '.env': 'SECRET=1',
    'node_modules/x/index.js': 'x',
  });
  await fs.symlink(path.join(root, 'css'), path.join(root, 'linked'));

  const { files, skipped } = await walkFolder(root);
  const { local, refused } = await readLocal(files, 'demos/maya');
  const remote = [
    { path: 'demos/maya/index.html', kind: 'document', etag: 'PAGE1' },
    { path: 'demos/maya/css/style.css', kind: 'file', etag: etagOf(Buffer.from('body{}')) },
    { path: 'demos/maya/img/logo.png', kind: 'file', etag: 'OLD' },
    { path: 'demos/maya/old.css', kind: 'file', etag: 'X' },
    { path: 'demos/maya/css', kind: 'folder', etag: null },
  ];
  const plan = planPublish({ local, remote, to: 'demos/maya' });

  assert.deepEqual(files.map((file) => file.path), ['about.html', 'css/style.css', 'img/logo.png', 'index.html']);
  assert.deepEqual(skipped.map((entry) => [entry.path, entry.reason]), [['.env', 'hidden'], ['linked', 'symlink'], ['node_modules', 'tooling']]);
  assert.deepEqual(refused, []);
  assert.deepEqual(plan.steps.map((step) => [step.path, step.action]), [
    ['css/style.css', 'unchanged'],
    ['img/logo.png', 'replace'],
    ['about.html', 'create'],
    ['index.html', 'replace'],
    ['site.json', 'create'],
  ]);
  assert.equal(plan.steps.find((step) => step.path === 'index.html').remoteEtag, 'PAGE1');
  assert.deepEqual(plan.remoteOnly, ['old.css']);
});

test('refuses a folder with no top-level index.html', async (t) => {
  const root = await folder(t, { 'about.html': '<html>about</html>' });
  await assert.rejects(() => walkFolder(root), { code: 'no-index' });
});

test('refuses a folder with more than 2000 files', async (t) => {
  const root = await folder(t, { 'index.html': '<html></html>' });
  for (let index = 0; index < 2000; index += 1) {
    await fs.writeFile(path.join(root, `f${index}.css`), '');
  }
  await assert.rejects(() => walkFolder(root), { code: 'too-many-files' });
});

test('refuses a folder where a file holds an agent key', async (t) => {
  const root = await folder(t, {
    'index.html': '<html></html>',
    'app.js': `const key = 'hcak_${'a'.repeat(64)}';`,
  });
  const { files } = await walkFolder(root);
  await assert.rejects(() => readLocal(files, 'demos/maya'), { code: 'secret-in-content' });
});

test('refuses what the server would refuse, and does not plan it', async (t) => {
  const root = await folder(t, {
    'index.html': '<html></html>',
    'About.html': '<html></html>',
    'My Folder/x.css': 'body{}',
    'a/b/c/d/e.css': 'body{}',
    'old.htm': '<html></html>',
  });
  const { files } = await walkFolder(root);
  const { local, refused } = await readLocal(files, 'x/y');
  const plan = planPublish({ local, remote: [], to: 'x/y' });

  assert.deepEqual(refused.map((entry) => [entry.path, entry.reason]), [
    ['a/b/c/d/e.css', 'too-deep'],
    ['About.html', 'page-name'],
    ['My Folder/x.css', 'folder-name'],
    ['old.htm', 'html-like-name'],
  ]);
  assert.deepEqual(local.map((file) => file.path), ['index.html']);
  assert.deepEqual(plan.refused, []);
  assert.deepEqual(plan.steps.map((step) => [step.path, step.action]), [
    ['index.html', 'create'],
    ['site.json', 'create'],
  ]);
});

test('plans a local site.json like any other file and adds no empty one', async (t) => {
  const root = await folder(t, {
    'index.html': '<html></html>',
    'site.json': '{"title":"Maya"}\n',
  });
  const { files } = await walkFolder(root);
  const { local } = await readLocal(files, 'demos/maya');
  const plan = planPublish({ local, remote: [], to: 'demos/maya' });

  assert.deepEqual(plan.steps.map((step) => [step.path, step.action]), [
    ['index.html', 'create'],
    ['site.json', 'create'],
  ]);
  assert.equal(plan.steps.find((step) => step.path === 'site.json').size, Buffer.byteLength('{"title":"Maya"}\n'));
});

test('keeps a remote-only site.json without listing it, and adds nothing', async (t) => {
  const root = await folder(t, { 'index.html': '<html></html>' });
  const { files } = await walkFolder(root);
  const { local } = await readLocal(files, 'demos/maya');
  const remote = [{ path: 'demos/maya/site.json', kind: 'file', etag: 'X' }];
  const plan = planPublish({ local, remote, to: 'demos/maya' });

  assert.deepEqual(plan.steps.map((step) => [step.path, step.action]), [['index.html', 'create']]);
  assert.deepEqual(plan.remoteOnly, []);
});

test('refuses a path where a local file meets a remote document', async (t) => {
  const root = await folder(t, {
    'index.html': '<html></html>',
    'css/style.css': 'body{}',
  });
  const { files } = await walkFolder(root);
  const { local } = await readLocal(files, 'demos/maya');
  const remote = [{ path: 'demos/maya/css/style.css', kind: 'document', etag: 'PAGE' }];
  const plan = planPublish({ local, remote, to: 'demos/maya' });

  assert.deepEqual(plan.refused, [{ path: 'css/style.css', reason: 'path-conflict' }]);
  assert.deepEqual(plan.steps.map((step) => [step.path, step.action]), [
    ['index.html', 'create'],
    ['site.json', 'create'],
  ]);
});

function fakeRemote({ fail = {}, listing = [] } = {}) {
  const calls = [];
  return {
    calls,
    async putFile(filePath, bytes, options) {
      calls.push(['put', filePath, options.create ? 'create' : `replace:${options.etag}`]);
      if (fail[filePath]) throw fail[filePath]();
      return { path: filePath, etag: etagOf(bytes), changed: true, created: options.create };
    },
    async listAllFiles() { calls.push(['list']); return listing; },
    async claimSubdomain(sitePath, name) { calls.push(['claim', sitePath, name]); return { subdomain: name, url: `https://${name}.hyperclay.com`, changed: true, warnings: [] }; },
  };
}

test('sends files, then pages, then site.json, then claims the address', async (t) => {
  const root = await folder(t, { 'index.html': '<html></html>', 'style.css': 'p{}' });
  const { files } = await walkFolder(root);
  const { local } = await readLocal(files, 'demos/maya');
  const plan = planPublish({ local, remote: [], to: 'demos/maya' });
  const remote = fakeRemote();

  const result = await runPublish({ plan, to: 'demos/maya', remote, subdomain: 'maya', wait: async () => {} });

  assert.deepEqual(remote.calls, [
    ['put', 'demos/maya/style.css', 'create'],
    ['put', 'demos/maya/index.html', 'create'],
    ['put', 'demos/maya/site.json', 'create'],
    ['claim', 'demos/maya', 'maya'],
  ]);
  assert.deepEqual(result.created, ['style.css', 'index.html', 'site.json']);
  assert.equal(result.subdomain.url, 'https://maya.hyperclay.com');
});

test('continues past a refused file and claims nothing', async (t) => {
  const root = await folder(t, {
    'index.html': '<html></html>',
    'style.css': 'p{}',
    'app.js': 'x',
  });
  const { files } = await walkFolder(root);
  const { local } = await readLocal(files, 'demos/maya');
  const plan = planPublish({ local, remote: [], to: 'demos/maya' });
  const remote = fakeRemote({ fail: { 'demos/maya/style.css': () => new ClayError('managed', 'That file is managed.') } });

  const result = await runPublish({ plan, to: 'demos/maya', remote, subdomain: 'maya', wait: async () => {} });

  assert.deepEqual(result.failed.map((entry) => [entry.path, entry.code]), [['style.css', 'managed']]);
  assert.deepEqual(result.created, ['app.js', 'index.html', 'site.json']);
  assert.equal(result.subdomain.claimed, false);
  assert.deepEqual(remote.calls.filter((call) => call[0] === 'claim'), []);
});

test('waits out a rate limit and sends the file again', async (t) => {
  const root = await folder(t, { 'index.html': '<html></html>' });
  const { files } = await walkFolder(root);
  const { local } = await readLocal(files, 'demos/maya');
  const plan = planPublish({ local, remote: [], to: 'demos/maya' });
  const waits = [];
  let attempts = 0;
  const remote = fakeRemote();
  const put = remote.putFile;
  remote.putFile = async (filePath, bytes, options) => {
    if (filePath.endsWith('/index.html')) {
      attempts += 1;
      if (attempts === 1) {
        throw new ClayError('rate-limited', 'Slow down.', { retryable: true, details: { retryAfter: 2 } });
      }
    }
    return put(filePath, bytes, options);
  };

  const result = await runPublish({ plan, to: 'demos/maya', remote, wait: async (seconds) => { waits.push(seconds); } });

  assert.deepEqual(waits, [2]);
  assert.equal(attempts, 2);
  assert.deepEqual(result.created, ['index.html', 'site.json']);
});

test('settles a lost answer from one listing, and leaves what is not there pending', async (t) => {
  const root = await folder(t, {
    'index.html': '<html></html>',
    'a.css': 'a{}',
    'b.css': 'b{}',
  });
  const { files } = await walkFolder(root);
  const { local } = await readLocal(files, 'demos/maya');
  const plan = planPublish({ local, remote: [], to: 'demos/maya' });
  const lost = () => new ClayError('outcome-unknown', 'The change may or may not have been saved.');
  const remote = fakeRemote({
    fail: { 'demos/maya/a.css': lost, 'demos/maya/b.css': lost },
    listing: [{ path: 'demos/maya/a.css', kind: 'file', etag: etagOf(Buffer.from('a{}')) }],
  });

  const result = await runPublish({ plan, to: 'demos/maya', remote, subdomain: 'maya', wait: async () => {} });

  assert.deepEqual(result.created, ['index.html', 'site.json', 'a.css']);
  assert.deepEqual(result.pending, ['b.css']);
  assert.equal(result.subdomain.claimed, false);
  assert.deepEqual(remote.calls.filter((call) => call[0] === 'claim'), []);
});

test('re-reads each file and refuses one that changed on this computer', async (t) => {
  const root = await folder(t, { 'index.html': '<html></html>' });
  const { files } = await walkFolder(root);
  const { local } = await readLocal(files, 'demos/maya');
  const plan = planPublish({ local, remote: [], to: 'demos/maya' });
  await fs.writeFile(path.join(root, 'index.html'), '<html>newer</html>');
  const remote = fakeRemote();

  const result = await runPublish({ plan, to: 'demos/maya', remote, wait: async () => {} });

  assert.deepEqual(result.failed.map((entry) => [entry.path, entry.code]), [['index.html', 'changed-locally']]);
  assert.deepEqual(remote.calls, [['put', 'demos/maya/site.json', 'create']]);
});

test('reports a page replacement the server did not need to change as unchanged', async (t) => {
  const root = await folder(t, { 'index.html': '<html></html>' });
  const { files } = await walkFolder(root);
  const { local } = await readLocal(files, 'demos/maya');
  const remote = [{ path: 'demos/maya/index.html', kind: 'document', etag: 'PAGE1' }];
  const plan = planPublish({ local, remote, to: 'demos/maya' });
  const fake = fakeRemote();
  const put = fake.putFile;
  fake.putFile = async (filePath, bytes, options) => ({ ...(await put(filePath, bytes, options)), changed: false });

  const result = await runPublish({ plan, to: 'demos/maya', remote: fake, wait: async () => {} });

  assert.deepEqual(fake.calls, [
    ['put', 'demos/maya/index.html', 'replace:PAGE1'],
    ['put', 'demos/maya/site.json', 'create'],
  ]);
  assert.deepEqual(result.unchanged, ['index.html']);
  assert.deepEqual(result.replaced, []);
});

test('a refused file stops the address claim', async (t) => {
  const root = await folder(t, {
    'index.html': '<html></html>',
    'About.html': '<html></html>',
  });
  const { files } = await walkFolder(root);
  const { local, refused } = await readLocal(files, 'demos/maya');
  const plan = planPublish({ local, remote: [], to: 'demos/maya' });
  const remote = fakeRemote();

  const result = await runPublish({ plan, to: 'demos/maya', remote, refused, subdomain: 'maya', wait: async () => {} });

  assert.deepEqual(refused.map((entry) => [entry.path, entry.reason]), [['About.html', 'page-name']]);
  assert.deepEqual(result.created, ['index.html', 'site.json']);
  assert.deepEqual(result.failed, []);
  assert.equal(result.subdomain.claimed, false);
  assert.equal(result.subdomain.reason, 'Some files were refused or did not land, so the address was not claimed. Fix them and publish again.');
  assert.deepEqual(remote.calls.filter((call) => call[0] === 'claim'), []);
});

test('a claim that fails keeps the file results and reports the code', async (t) => {
  const root = await folder(t, { 'index.html': '<html></html>' });
  const { files } = await walkFolder(root);
  const { local } = await readLocal(files, 'demos/maya');
  const plan = planPublish({ local, remote: [], to: 'demos/maya' });
  const remote = fakeRemote();
  remote.claimSubdomain = async () => {
    throw new ClayError('name-in-use', 'That name is taken.');
  };

  const result = await runPublish({ plan, to: 'demos/maya', remote, subdomain: 'maya', wait: async () => {} });

  assert.deepEqual(result.created, ['index.html', 'site.json']);
  assert.equal(result.subdomain.claimed, false);
  assert.equal(result.subdomain.code, 'name-in-use');
  assert.equal(result.subdomain.message, 'That name is taken.');
});

test('keeps a page create pending even when something sits at its path', async (t) => {
  const root = await folder(t, { 'index.html': '<html></html>' });
  const { files } = await walkFolder(root);
  const { local } = await readLocal(files, 'demos/maya');
  const plan = planPublish({ local, remote: [], to: 'demos/maya' });
  const lost = () => new ClayError('outcome-unknown', 'The change may or may not have been saved.');
  const remote = fakeRemote({
    fail: { 'demos/maya/index.html': lost },
    listing: [{ path: 'demos/maya/index.html', kind: 'document', etag: 'SOMEONE-ELSE' }],
  });

  const result = await runPublish({ plan, to: 'demos/maya', remote, subdomain: 'maya', wait: async () => {} });

  assert.deepEqual(result.created, ['site.json']);
  assert.deepEqual(result.pending, ['index.html']);
  assert.equal(result.subdomain.claimed, false);
  assert.deepEqual(remote.calls.filter((call) => call[0] === 'claim'), []);
});
