#!/usr/bin/env node
// Publishes @panphora/clay-agent, this package's name through 0.7.0, as a forwarder pinned to the
// current version of this package. npx refreshes a cached package only when the package named on
// the command line has a new version, so people who still run the old name get updates only if the
// old name is published with every release. `npm run deploy` runs this. It does nothing when the
// old name is already current and carries its rename notice, and it fails when it could not get
// the old name there, so the deploy is not recorded as done and the next one tries again.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_NAME = '@panphora/clay-agent';

function npm(args, { cwd } = {}) {
  return execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// `npm view` fails with E404 when the package or the version does not exist. Any other failure
// is not an answer.
function isPublished(run, name, version) {
  try {
    return run(['view', `${name}@${version}`, 'version']).trim() === version;
  } catch (error) {
    if (String(error?.stderr ?? '').includes('E404')) return false;
    throw error;
  }
}

// The notice goes on every version of the old name, never on one. `npx @panphora/clay-agent`
// prefers the newest version without a notice, so a notice on the newest version alone would
// send people back to 0.7.0.
function noticeEveryVersion(run, name) {
  run(['deprecate', OLD_NAME, `Renamed to ${name}. This name keeps working. See https://claycli.com`]);
}

// The forwarder's files name the package they pass commands to. A rename of the root package alone
// would publish a forwarder that depends on one name and imports another, so that is refused.
function checkForwardsTo(stage, name) {
  for (const file of fs.readdirSync(stage, { recursive: true }).map(String)) {
    if (!file.endsWith('.js')) continue;
    const text = fs.readFileSync(path.join(stage, file), 'utf8');
    for (const [, target] of text.matchAll(/from '([^']+)'/g)) {
      if (target !== name && !target.startsWith(`${name}/`)) {
        throw new Error(`legacy/clay-agent/${file} imports ${target}, but this package is ${name}.`);
      }
    }
  }
}

// One step toward the old name being current. npm shows a version a minute or so after its
// publish, and `npm deprecate` marks only the versions npm shows. A notice added straight after
// the publish misses the new version, so it is added on a later step, once npm shows that version.
// `published` and `noticed` say what earlier steps of this run already did, so each happens once.
export function publishOldName({ root = ROOT, run = npm, log = console.log, published = false, noticed = false } = {}) {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (isPublished(run, OLD_NAME, version)) {
    if (run(['view', `${OLD_NAME}@${version}`, 'deprecated']).trim()) {
      log(`${OLD_NAME}@${version} is on npm with its rename notice.`);
      return 'current';
    }
    if (noticed) return 'unnoticed';
    noticeEveryVersion(run, name);
    return 'noticed';
  }
  if (published) return 'hidden';
  if (!isPublished(run, name, version)) {
    log(`${name}@${version} is not on npm yet.`);
    return 'waiting';
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'clay-agent-old-name-'));
  try {
    fs.cpSync(path.join(root, 'legacy', 'clay-agent'), stage, { recursive: true });
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
    checkForwardsTo(stage, name);
    const manifestFile = path.join(stage, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.version = version;
    manifest.dependencies = { [name]: version };
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    run(['publish', '--access', 'public'], { cwd: stage });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  log(`Published ${OLD_NAME}@${version}, which passes every command to ${name}@${version}.`);
  return 'published';
}

// Why the deploy step stopped, by the last step's answer. A second publish of a version npm
// already holds fails, so the middle case says to wait before running the deploy again.
const GAVE_UP = {
  waiting: `${OLD_NAME} was not published, so it is one release behind. Run \`npm run deploy\` again.`,
  hidden: `${OLD_NAME} was published, but npm does not show it yet. Wait a few minutes, then run \`npm run deploy\` again.`,
  unnoticed: `${OLD_NAME} is on npm, but npm does not show its rename notice yet. Run \`npm run deploy\` again.`,
};

// Repeats the step until npm shows the old name at this version with its notice. A step that
// just published or added the notice always gets one more look before the run gives up.
export async function publishOldNameWhenVisible({ waitMs = 5 * 60_000, pauseMs = 15_000, ...options } = {}) {
  const giveUpAt = Date.now() + waitMs;
  const did = { published: false, noticed: false };
  for (;;) {
    const result = publishOldName({ ...options, ...did });
    if (result === 'current') return result;
    if (result in did) did[result] = true;
    else if (Date.now() >= giveUpAt) throw new Error(GAVE_UP[result]);
    await sleep(pauseMs);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  await publishOldNameWhenVisible();
}
