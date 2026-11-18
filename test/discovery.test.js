import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { htmlClay } from '../src/discovery.js';

const ALIVE_PID = 111;

async function setup(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-discovery-')));
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

async function writeLocal(home, { v = 1, pid = ALIVE_PID, roots = [] } = {}) {
  await writeJson(path.join(appSupport(home), 'Hyperclay Local', 'served-roots.json'), { v, pid, roots });
}

async function writeHtmlClayConfig(home, data) {
  await writeJson(path.join(appSupport(home), 'htmlclay', 'config.json'), data);
}

async function writeAgentToken(home, text) {
  const file = path.join(appSupport(home), 'htmlclay', 'agent-token');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

async function makeDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return fs.realpath(dir);
}

test('a folder only HTML Clay serves is found', async (t) => {
  const { home, env, platform } = await setup(t);
  const notes = await makeDir(path.join(home, 'notes'));
  const other = await makeDir(path.join(home, 'other'));
  await writeHtmlClayConfig(home, {
    port: 4321,
    servedFolders: [{ id: 'f1', name: 'notes', path: notes, serving: true }],
  });
  await writeLocal(home, { roots: [{ path: other, port: 5000 }] });

  assert.deepEqual((await htmlClay(env, platform)).servedFolders, [
    { id: 'f1', name: 'notes', path: notes, serving: true },
  ]);
});

test('served folder paths are compared after resolving links', async (t) => {
  const { home, env, platform } = await setup(t);
  const real = await makeDir(path.join(home, 'real'));
  const link = path.join(home, 'link');
  await fs.symlink(real, link, 'dir');
  await writeHtmlClayConfig(home, {
    port: 4321,
    servedFolders: [{ id: 'f1', name: 'link', path: link, serving: true }],
  });

  const found = await htmlClay(env, platform);

  assert.equal(found.servedFolders[0].path, await fs.realpath(real));
});

test('a folder that is not serving is listed with serving false, and bad rows are skipped', async (t) => {
  const { home, env, platform } = await setup(t);
  const notes = await makeDir(path.join(home, 'notes'));
  await writeHtmlClayConfig(home, {
    port: 4321,
    servedFolders: [
      { id: 'f1', name: 'notes', path: notes, serving: false },
      { id: 'f2', name: 'relative', path: 'relative/folder', serving: true },
      { name: 'no-id', path: notes, serving: true },
      { id: 'f4', name: '', path: notes, serving: true },
      'not-a-folder',
    ],
  });

  assert.deepEqual((await htmlClay(env, platform)).servedFolders, [
    { id: 'f1', name: 'notes', path: notes, serving: false },
  ]);
});

test('the agent token is read from agent-token, and absent or malformed means none', async (t) => {
  const { home, env, platform } = await setup(t);
  await writeHtmlClayConfig(home, { port: 4321 });

  assert.equal((await htmlClay(env, platform)).token, null);

  await writeAgentToken(home, 'a'.repeat(64) + '\n');
  assert.equal((await htmlClay(env, platform)).token, 'a'.repeat(64));

  await writeAgentToken(home, 'not-a-token');
  assert.equal((await htmlClay(env, platform)).token, null);

  await writeAgentToken(home, 'A'.repeat(64));
  assert.equal((await htmlClay(env, platform)).token, null);
});
