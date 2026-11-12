import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ClayError } from './errors.js';

export const MAX_FILES = 2000;
export const MAX_FOLDER_DEPTH = 5;
const TOOLING = new Set(['node_modules', 'bower_components', 'CVS']);
const KEY = /hcak_[0-9a-f]{64}/;
const PAGE = /^[a-z0-9_-]+\.(html|htmlclay)$/;
const FOLDER = /^[a-z0-9_-]+$/;
const HTML_LIKE = /\.(htm|shtml|xht|xhtml)$/i;
const STORE = 'site.json';

export const etagOf = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
export const isPage = (filePath) => /\.(html|htmlclay)$/.test(filePath);

// Every regular file under `root`, by its path relative to `root` with "/" separators. Hidden
// entries, symlinks, tooling folders and anything that is not a regular file are skipped and named.
export async function walkFolder(root) {
  const top = await fs.stat(root).catch(() => null);
  if (!top || !top.isDirectory()) throw new ClayError('not-found', 'That local folder does not exist.');
  const files = [];
  const skipped = [];
  async function visit(dir, rel) {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.')) { skipped.push({ path: relPath, reason: 'hidden' }); continue; }
      if (entry.isSymbolicLink()) { skipped.push({ path: relPath, reason: 'symlink' }); continue; }
      if (entry.isDirectory()) {
        if (TOOLING.has(entry.name)) { skipped.push({ path: relPath, reason: 'tooling' }); continue; }
        await visit(path.join(dir, entry.name), relPath);
        continue;
      }
      if (!entry.isFile()) { skipped.push({ path: relPath, reason: 'not-a-file' }); continue; }
      files.push({ local: path.join(dir, entry.name), path: relPath });
      if (files.length > MAX_FILES) {
        throw new ClayError('too-many-files', `This folder has more than ${MAX_FILES} files.`, {
          hint: 'Publish a smaller folder, or split it into several sites.',
        });
      }
    }
  }
  await visit(root, '');
  if (!files.some((file) => file.path === 'index.html')) {
    throw new ClayError('no-index', 'A site folder needs an index.html at its top level.');
  }
  return { files, skipped };
}

// Why the server would refuse this path, or null.
function refusalFor(to, relPath) {
  const segments = `${to}/${relPath}`.split('/');
  const name = segments[segments.length - 1];
  const folders = segments.slice(0, -1);
  if (folders.length > MAX_FOLDER_DEPTH) return 'too-deep';
  if (folders.some((folder) => !FOLDER.test(folder))) return 'folder-name';
  if (isPage(name) && !PAGE.test(name)) return 'page-name';
  if (HTML_LIKE.test(name)) return 'html-like-name';
  return null;
}

// Reads each file once: its etag, and a refusal of the whole publish if any file holds an agent
// key. The bytes are not kept; C4.3 reads them again and checks the etag just before sending.
export async function readLocal(files, to) {
  const local = [];
  const refused = [];
  for (const file of files) {
    const reason = refusalFor(to, file.path);
    if (reason) { refused.push({ path: file.path, reason }); continue; }
    const bytes = await fs.readFile(file.local);
    if (KEY.test(bytes.toString('latin1'))) {
      throw new ClayError('secret-in-content', `${file.path} contains an agent key. Remove it, then publish again.`);
    }
    local.push({ ...file, etag: etagOf(bytes), size: bytes.length, kind: isPage(file.path) ? 'document' : 'file' });
  }
  return { local, refused };
}

// The publish plan against the remote listing of `to`. Pages are always sent as conditional
// replacements, because the server stores formatted HTML and answers changed: false when nothing
// changed. Other files are compared by etag. Remote-only files are reported and never touched.
export function planPublish({ local, remote, to }) {
  const prefix = `${to}/`;
  const remoteFiles = new Map(remote
    .filter((entry) => entry.path.startsWith(prefix) && entry.kind !== 'folder')
    .map((entry) => [entry.path.slice(prefix.length), entry]));
  const steps = [];
  const refused = [];
  for (const file of local) {
    const there = remoteFiles.get(file.path);
    if (!there) { steps.push({ ...file, action: 'create' }); continue; }
    if (there.kind !== file.kind) { refused.push({ path: file.path, reason: 'path-conflict' }); continue; }
    if (file.kind === 'file' && there.etag === file.etag) { steps.push({ ...file, action: 'unchanged' }); continue; }
    steps.push({ ...file, action: 'replace', remoteEtag: there.etag });
  }
  if (!local.some((file) => file.path === STORE) && !remoteFiles.has(STORE)) {
    const bytes = Buffer.from('{}\n');
    steps.push({ path: STORE, local: null, bytes, etag: etagOf(bytes), size: bytes.length, kind: 'file', action: 'create' });
  }
  // The site's own site.json is what makes the folder a site, so a publish keeps it whether or not
  // the local folder has one, and it is never reported as left alone.
  const localPaths = new Set(local.map((file) => file.path));
  const remoteOnly = [...remoteFiles.keys()].filter((relPath) => relPath !== STORE && !localPaths.has(relPath)).sort();
  const order = (step) => (step.path === STORE ? 2 : step.kind === 'document' ? 1 : 0);
  steps.sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path));
  return { steps, refused, remoteOnly };
}

const MAX_RETRIES = 3;
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function withRetries(send, wait) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      const seconds = error?.details?.retryAfter;
      if (!error?.retryable || attempt >= MAX_RETRIES) throw error;
      await wait(Math.min(Number.isFinite(seconds) ? seconds : 5, 60));
    }
  }
}

// `remote` is { putFile(path, bytes, { create, etag }), listAllFiles(path), claimSubdomain(sitePath, name) }.
// File bytes never appear in the answer: only paths, counts and codes.
export async function runPublish({ plan, to, remote, subdomain = null, refused = [], wait = sleep }) {
  const result = { created: [], replaced: [], unchanged: [], failed: [], pending: [], subdomain: null };
  for (const step of plan.steps) {
    if (step.action === 'unchanged') { result.unchanged.push(step.path); continue; }
    const bytes = step.bytes ?? await fs.readFile(step.local).catch(() => null);
    if (!bytes || etagOf(bytes) !== step.etag) {
      result.failed.push({ path: step.path, code: 'changed-locally', message: 'The file changed on this computer while publishing. Publish again.' });
      continue;
    }
    try {
      const answer = await withRetries(() => remote.putFile(`${to}/${step.path}`, bytes, {
        create: step.action === 'create', etag: step.remoteEtag,
      }), wait);
      if (step.action === 'create') result.created.push(step.path);
      else if (answer?.changed === false) result.unchanged.push(step.path);
      else result.replaced.push(step.path);
    } catch (error) {
      if (error?.code === 'outcome-unknown') result.pending.push(step);
      else result.failed.push({ path: step.path, code: error?.code ?? 'error', message: error?.message ?? String(error) });
    }
  }
  // Only a file proves it landed: its etag is in the listing. A page whose answer was lost stays
  // pending, since a later publish replaces it conditionally and the server answers changed: false
  // when the content is the same.
  if (result.pending.length) {
    const listed = new Map((await remote.listAllFiles(to)).map((entry) => [entry.path, entry]));
    const still = [];
    for (const step of result.pending) {
      const there = listed.get(`${to}/${step.path}`);
      const landed = step.kind === 'file' && there?.kind === 'file' && there.etag === step.etag;
      if (landed) (step.action === 'create' ? result.created : result.replaced).push(step.path);
      else still.push(step.path);
    }
    result.pending = still;
  } else {
    result.pending = [];
  }
  if (subdomain) {
    if (result.failed.length || result.pending.length || refused.length) {
      result.subdomain = { claimed: false, reason: 'Some files were refused or did not land, so the address was not claimed. Fix them and publish again.' };
    } else {
      try {
        const claimed = await withRetries(() => remote.claimSubdomain(to, subdomain), wait);
        result.subdomain = { claimed: true, subdomain: claimed.subdomain, url: claimed.url, changed: claimed.changed, warnings: claimed.warnings ?? [] };
      } catch (error) {
        result.subdomain = { claimed: false, code: error?.code ?? 'error', message: error?.message ?? String(error) };
      }
    }
  }
  return result;
}
