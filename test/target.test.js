import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discover } from '../src/discovery.js';
import { resolveTarget } from '../src/target.js';

const ALIVE_PID = 111;
const DEAD_PID = 222;
const isAlive = (pid) => pid === ALIVE_PID;

const HTMLCLAY_PORT = 4321;
const LOCAL_PORT = 5000;

async function setup(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-target-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, env: { HOME: home }, platform: 'darwin' };
}

function appSupport(home) {
  return path.join(home, 'Library', 'Application Support');
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
}

async function writeHtmlClay(home, port) {
  await writeJson(path.join(appSupport(home), 'htmlclay', 'config.json'), { port });
}

async function writeLocal(home, { v = 1, pid = ALIVE_PID, roots = [] } = {}) {
  await writeJson(path.join(appSupport(home), 'Hyperclay Local', 'served-roots.json'), { v, pid, roots });
}

async function makeDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return fs.realpath(dir);
}

async function makeFile(dir, name, body = '<!doctype html><h1>hi</h1>') {
  await makeDir(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, body, 'utf8');
  return fs.realpath(file);
}

async function bothApps(home) {
  await writeHtmlClay(home, HTMLCLAY_PORT);
  const root = await makeDir(path.join(home, 'served'));
  await writeLocal(home, { roots: [{ path: root, port: LOCAL_PORT }] });
  return root;
}

test('discover reads both apps from the user config folder', async (t) => {
  const { home, env, platform } = await setup(t);
  const root = await makeDir(path.join(home, 'notes'));
  await writeHtmlClay(home, HTMLCLAY_PORT);
  await writeLocal(home, {
    roots: [
      { path: root, port: LOCAL_PORT },
      { path: 'relative/folder', port: 5001 },
      { path: root, port: 0 },
      { path: root, port: '5002' },
    ],
  });

  const found = await discover(env, platform, { isAlive });

  assert.deepEqual(found.htmlClay, { port: HTMLCLAY_PORT, token: null, servedFolders: [] });
  assert.deepEqual(found.hyperclayLocal, { roots: [{ path: root, port: LOCAL_PORT }] });
});

test('discover returns null for a dead app, a wrong version, bad JSON and missing files', async (t) => {
  const { home, env, platform } = await setup(t);
  const root = await makeDir(path.join(home, 'notes'));

  assert.deepEqual(await discover(env, platform, { isAlive }), { htmlClay: null, hyperclayLocal: null });

  await writeLocal(home, { pid: DEAD_PID, roots: [{ path: root, port: LOCAL_PORT }] });
  assert.equal((await discover(env, platform, { isAlive })).hyperclayLocal, null);

  await writeLocal(home, { v: 2, roots: [{ path: root, port: LOCAL_PORT }] });
  assert.equal((await discover(env, platform, { isAlive })).hyperclayLocal, null);

  await writeJson(path.join(appSupport(home), 'Hyperclay Local', 'served-roots.json'), '{ not json');
  assert.equal((await discover(env, platform, { isAlive })).hyperclayLocal, null);
  assert.equal((await discover(env, platform, { isAlive })).htmlClay, null);

  await writeJson(path.join(appSupport(home), 'htmlclay', 'config.json'), { port: 'nope' });
  assert.equal((await discover(env, platform, { isAlive })).htmlClay, null);

  await fs.rm(path.join(appSupport(home), 'htmlclay', 'config.json'));
  assert.equal((await discover(env, platform, { isAlive })).htmlClay, null);
});

test('hyperclay ids and hyperclay.com URLs resolve to hyperclay', async (t) => {
  const { home, env, platform } = await setup(t);
  const found = { htmlClay: null, hyperclayLocal: null };

  const byId = await resolveTarget('hyperclay:42', { cwd: home, env, platform, discovered: found });
  assert.deepEqual(byId, { host: 'hyperclay', id: '42', ref: 'hyperclay:42' });

  const byUrl = await resolveTarget('https://david.hyperclay.com/notes.html', {
    cwd: home,
    env,
    platform,
    discovered: found,
  });
  assert.equal(byUrl.host, 'hyperclay');
  assert.equal(byUrl.url, 'https://david.hyperclay.com/notes.html');
});

test('loopback URLs go to the app serving that port', async (t) => {
  const { home, env, platform } = await setup(t);
  await bothApps(home);
  const found = await discover(env, platform, { isAlive });

  const local = await resolveTarget('http://127.0.0.1:5000/folder/a%20b.html', {
    cwd: home,
    env,
    platform,
    discovered: found,
  });
  assert.deepEqual(local, {
    host: 'local',
    port: LOCAL_PORT,
    path: 'folder/a b.html',
    ref: 'http://127.0.0.1:5000/folder/a b.html',
  });

  const slugged = await resolveTarget('http://notes.localhost:4321/', { cwd: home, env, platform, discovered: found });
  assert.equal(slugged.host, 'htmlclay');
  assert.equal(slugged.port, HTMLCLAY_PORT);
  assert.equal(slugged.slug, 'notes');

  await assert.rejects(
    resolveTarget('http://127.0.0.1:9999/notes.html', { cwd: home, env, platform, discovered: found }),
    { code: 'host-unavailable' },
  );
});

test('files go to Hyperclay Local inside a root, to HTML Clay under home, and nowhere without an app', async (t) => {
  const { home, env, platform } = await setup(t);
  const root = await bothApps(home);
  const found = await discover(env, platform, { isAlive });

  const inside = await makeFile(path.join(root, 'nested'), 'a.html');
  const local = await resolveTarget(inside, { cwd: home, env, platform, discovered: found });
  assert.deepEqual(local, {
    host: 'local',
    port: LOCAL_PORT,
    path: 'nested/a.html',
    ref: `http://127.0.0.1:${LOCAL_PORT}/nested/a.html`,
  });

  const elsewhere = await makeFile(path.join(home, 'docs'), 'b.html');
  const clay = await resolveTarget(elsewhere, { cwd: home, env, platform, discovered: found });
  assert.deepEqual(clay, { host: 'htmlclay', port: HTMLCLAY_PORT, path: 'docs/b.html', ref: elsewhere });

  await assert.rejects(
    resolveTarget(elsewhere, {
      cwd: home,
      env,
      platform,
      discovered: { htmlClay: null, hyperclayLocal: null },
    }),
    { code: 'host-unavailable' },
  );
});

test('a sibling folder that only starts with a root name is not inside that root', async (t) => {
  const { home, env, platform } = await setup(t);
  await writeHtmlClay(home, HTMLCLAY_PORT);
  const root = await makeDir(path.join(home, 'notes'));
  await writeLocal(home, { roots: [{ path: root, port: LOCAL_PORT }] });
  const found = await discover(env, platform, { isAlive });

  const sibling = await makeFile(path.join(home, 'notes-old'), 'x.html');
  const target = await resolveTarget(sibling, { cwd: home, env, platform, discovered: found });

  assert.equal(target.host, 'htmlclay');
  assert.equal(target.path, 'notes-old/x.html');
});

test('~/ and relative paths resolve like the absolute path, and bad paths are refused', async (t) => {
  const { home, env, platform } = await setup(t);
  await writeHtmlClay(home, HTMLCLAY_PORT);
  const found = await discover(env, platform, { isAlive });

  const file = await makeFile(home, 'x.html');
  const expected = { host: 'htmlclay', port: HTMLCLAY_PORT, path: 'x.html', ref: file };

  assert.deepEqual(await resolveTarget(file, { cwd: home, env, platform, discovered: found }), expected);
  assert.deepEqual(await resolveTarget('~/x.html', { cwd: home, env, platform, discovered: found }), expected);
  assert.deepEqual(await resolveTarget('x.html', { cwd: home, env, platform, discovered: found }), expected);

  const notes = await makeDir(path.join(home, 'elsewhere'));
  const text = await makeFile(notes, 'notes.txt');
  await assert.rejects(resolveTarget(text, { cwd: home, env, platform, discovered: found }), {
    code: 'not-a-document',
  });
  await assert.rejects(resolveTarget(path.join(home, 'missing.html'), { cwd: home, env, platform, discovered: found }), {
    code: 'not-found',
  });
});

test('hostOverride picks a host only when that host can serve the reference', async (t) => {
  const { home, env, platform } = await setup(t);
  const root = await bothApps(home);
  const found = await discover(env, platform, { isAlive });

  const inside = await makeFile(root, 'a.html');
  const clay = await resolveTarget(inside, {
    cwd: home,
    env,
    platform,
    discovered: found,
    hostOverride: 'htmlclay',
  });
  assert.equal(clay.host, 'htmlclay');
  assert.equal(clay.path, 'served/a.html');
  assert.equal(clay.ref, inside);

  const outside = await makeFile(path.join(home, 'docs'), 'b.html');
  await assert.rejects(
    resolveTarget(outside, { cwd: home, env, platform, discovered: found, hostOverride: 'local' }),
    { code: 'ambiguous-target' },
  );

  await assert.rejects(
    resolveTarget('hyperclay:42', { cwd: home, env, platform, discovered: found, hostOverride: 'local' }),
    { code: 'ambiguous-target' },
  );
});

test('an empty document is not-found with a hint naming the accepted forms', async (t) => {
  const { home, env, platform } = await setup(t);
  const found = { htmlClay: null, hyperclayLocal: null };

  for (const document of ['', null]) {
    await assert.rejects(resolveTarget(document, { cwd: home, env, platform, discovered: found }), (error) => {
      assert.equal(error.code, 'not-found');
      assert.match(error.hint, /hyperclay:/);
      assert.match(error.hint, /127\.0\.0\.1/);
      return true;
    });
  }
});
