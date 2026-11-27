import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { publishOldName, publishOldNameWhenVisible } from '../scripts/publish-old-name.mjs';

const OLD = '@panphora/clay-agent';
const NEW = '@panphora/claycli';
const REPO = path.resolve(import.meta.dirname, '..');

function fixture(t, version = '1.2.3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-old-name-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: NEW, version }));
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT');
  const legacy = path.join(root, 'legacy', 'clay-agent');
  fs.mkdirSync(path.join(legacy, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'bin', 'clay-agent.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(
    path.join(legacy, 'package.json'),
    JSON.stringify({ name: OLD, version: '0.0.0', bin: { 'clay-agent': 'bin/clay-agent.js' }, dependencies: { [NEW]: '0.0.0' } }),
  );
  return root;
}

// A stand-in for npm. `onNpm` maps each package to its versions and their notices, and answers
// the way npm 11 does: E404 for a missing package or version, an empty line for no notice. Like
// npm, it shows a published version only later (after `showsAfter` more lookups), puts a notice
// only on the versions it shows at that moment, shows the notice later too (`noticeShowsAfter`),
// and refuses a second publish of the same version.
function registry(onNpm, { showsAfter = 0, noticeShowsAfter = 0 } = {}) {
  const staged = [];
  const notices = [];
  const texts = [];
  let accepted = [];
  const run = (args, { cwd } = {}) => {
    const [command, spec, field] = args;
    if (command === 'view') {
      accepted = accepted.filter((change) => change.lookups-- !== 0 || change.show());
      const [, name, version] = spec.match(/^(@[^@]+)@(.+)$/);
      const notice = onNpm[name]?.[version];
      if (notice === undefined) throw Object.assign(new Error('not found'), { stderr: 'npm error code E404' });
      return field === 'version' ? `${version}\n` : `${notice}\n`;
    }
    if (command === 'publish') {
      const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      if (staged.some((earlier) => earlier.manifest.version === manifest.version)) {
        throw Object.assign(new Error('published twice'), { stderr: 'npm error code E403' });
      }
      staged.push({ manifest, files: fs.readdirSync(cwd, { recursive: true }).map(String).sort() });
      accepted.push({ lookups: showsAfter, show: () => void ((onNpm[manifest.name] ??= {})[manifest.version] = '') });
    }
    if (command === 'deprecate') {
      notices.push(spec);
      texts.push(field);
      const shown = Object.keys(onNpm[spec] ?? {});
      accepted.push({ lookups: noticeShowsAfter, show: () => void shown.forEach((version) => (onNpm[spec][version] = field)) });
    }
    return '';
  };
  return { run, staged, notices, texts };
}

test('the old name is published pinned to the exact current version', (t) => {
  const root = fixture(t);
  const npm = registry({ [OLD]: { '0.7.0': '' }, [NEW]: { '1.2.3': '' } });
  assert.equal(publishOldName({ root, run: npm.run, log: () => {} }), 'published');
  assert.equal(npm.staged.length, 1);
  assert.equal(npm.staged[0].manifest.name, OLD);
  assert.equal(npm.staged[0].manifest.version, '1.2.3');
  assert.deepEqual(npm.staged[0].manifest.dependencies, { [NEW]: '1.2.3' });
  assert.ok(npm.staged[0].files.includes('LICENSE'));
  assert.ok(npm.staged[0].files.includes(path.join('bin', 'clay-agent.js')));
});

test('the rename notice goes on every version of the old name, never on one', (t) => {
  const root = fixture(t);
  const npm = registry({ [OLD]: { '0.7.0': 'Renamed', '1.2.3': '' }, [NEW]: { '1.2.3': '' } });
  assert.equal(publishOldName({ root, run: npm.run, log: () => {} }), 'noticed');
  assert.deepEqual(npm.notices, [OLD]);
  assert.ok(npm.texts[0].includes(NEW));
  assert.equal(npm.staged.length, 0);
});

test('nothing is published or changed when the old name is current and carries its notice', (t) => {
  const root = fixture(t);
  const npm = registry({ [OLD]: { '0.7.0': 'Renamed', '1.2.3': 'Renamed' }, [NEW]: { '1.2.3': '' } });
  assert.equal(publishOldName({ root, run: npm.run, log: () => {} }), 'current');
  assert.equal(npm.staged.length, 0);
  assert.deepEqual(npm.notices, []);
});

test('the old name waits while this version of the new name is not on npm', (t) => {
  const root = fixture(t);
  for (const onNpm of [{ [OLD]: { '0.7.0': '' } }, { [OLD]: { '0.7.0': '' }, [NEW]: { '1.2.2': '' } }]) {
    const npm = registry(onNpm);
    assert.equal(publishOldName({ root, run: npm.run, log: () => {} }), 'waiting');
    assert.equal(npm.staged.length, 0);
    assert.deepEqual(npm.notices, []);
  }
});

test('the deploy step fails and says why when npm does not catch up in time, so the next deploy tries again', async (t) => {
  const root = fixture(t);
  const never = { showsAfter: 1000, noticeShowsAfter: 1000 };
  const cases = [
    { onNpm: { [OLD]: { '0.7.0': '' } }, says: /was not published/, staged: 0, notices: 0 },
    { onNpm: { [OLD]: { '0.7.0': '' }, [NEW]: { '1.2.3': '' } }, says: /does not show it yet\. Wait/, staged: 1, notices: 0 },
    { onNpm: { [OLD]: { '0.7.0': '', '1.2.3': '' }, [NEW]: { '1.2.3': '' } }, says: /does not show its rename notice yet/, staged: 0, notices: 1 },
  ];
  for (const { onNpm, says, staged, notices } of cases) {
    const npm = registry(onNpm, never);
    await assert.rejects(publishOldNameWhenVisible({ root, run: npm.run, log: () => {}, waitMs: 0, pauseMs: 0 }), says);
    assert.equal(npm.staged.length, staged);
    assert.equal(npm.notices.length, notices);
  }
});

test('the deploy step publishes once npm shows the new version', async (t) => {
  const root = fixture(t);
  const onNpm = { [OLD]: { '0.7.0': '' } };
  const npm = registry(onNpm);
  let asked = 0;
  const run = (args, options) => {
    if (args[0] === 'view' && args[1].startsWith(`${NEW}@`) && ++asked === 3) onNpm[NEW] = { '1.2.3': '' };
    return npm.run(args, options);
  };
  assert.equal(await publishOldNameWhenVisible({ root, run, log: () => {}, waitMs: 60_000, pauseMs: 0 }), 'current');
  assert.equal(npm.staged.length, 1);
});

test('the deploy step adds the notice once npm shows the version it published, so that version carries it too', async (t) => {
  const root = fixture(t);
  const onNpm = { [OLD]: { '0.7.0': '' }, [NEW]: { '1.2.3': '' } };
  const npm = registry(onNpm, { showsAfter: 4, noticeShowsAfter: 3 });
  assert.equal(await publishOldNameWhenVisible({ root, run: npm.run, log: () => {}, waitMs: 60_000, pauseMs: 0 }), 'current');
  assert.equal(npm.staged.length, 1);
  assert.deepEqual(npm.notices, [OLD]);
  assert.match(onNpm[OLD]['1.2.3'], /Renamed to/);
  assert.match(onNpm[OLD]['0.7.0'], /Renamed to/);
});

test('the forwarder in this repo passes commands to this package, by its current name', () => {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const npm = registry({ [OLD]: { '0.7.0': '' }, [name]: { [version]: '' } });
  assert.equal(publishOldName({ root: REPO, run: npm.run, log: () => {} }), 'published');
  assert.deepEqual(npm.staged[0].manifest.dependencies, { [name]: version });
  assert.deepEqual(npm.staged[0].manifest.bin, { 'clay-agent': 'bin/clay-agent.js' });
});

test('a forwarder that imports another package is not published', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'legacy', 'clay-agent', 'bin', 'clay-agent.js'), "import { main } from '@panphora/other';\n");
  const npm = registry({ [OLD]: { '0.7.0': '' }, [NEW]: { '1.2.3': '' } });
  assert.throws(() => publishOldName({ root, run: npm.run, log: () => {} }), /imports @panphora\/other/);
  assert.equal(npm.staged.length, 0);
});

test('a registry failure that is not "no such package" stops the run', (t) => {
  const root = fixture(t);
  const run = () => {
    throw Object.assign(new Error('offline'), { stderr: 'npm error code ENOTFOUND' });
  };
  assert.throws(() => publishOldName({ root, run, log: () => {} }), /offline/);
});
