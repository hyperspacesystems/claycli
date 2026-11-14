import fs from 'node:fs/promises';
import path from 'node:path';

import { homeDir } from './credentials.js';
import { discover } from './discovery.js';
import { ClayError } from './errors.js';
import { htmlClayDocumentId } from './hosts/htmlclay.js';

const DOCUMENT_EXTENSIONS = new Set(['.html', '.htm', '.htmlclay']);
const HYPERCLAY_REFERENCE = /^hyperclay:(\d+)$/;
const URL_PATTERN = /^https?:\/\//i;

const DOCUMENT_FORMS =
  'Give a document as a hyperclay:<id> reference or a hyperclay.com URL, a local URL like http://127.0.0.1:4321/notes.html, or a file path.';

const OPEN_AN_APP = 'Open HTML Clay, or put the file in a folder Hyperclay Local serves.';

function ambiguousTarget(document, hostOverride) {
  const hints = {
    hyperclay: 'hyperclay.com serves hyperclay:<id> references and hyperclay.com URLs, not this.',
    htmlclay: 'HTML Clay serves files inside your home folder.',
    local: 'Hyperclay Local serves files inside the folders it has open.',
  };
  return new ClayError('ambiguous-target', `clay-agent cannot send ${document} to ${hostOverride}.`, {
    hint: hints[hostOverride],
  });
}

function hostUnavailable(port) {
  return new ClayError('host-unavailable', `Nothing is serving port ${port}.`, {
    hint: `Neither HTML Clay nor Hyperclay Local is serving port ${port}. Open the app, then try again.`,
  });
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
}

function slugOf(hostname) {
  const suffix = '.localhost';
  const host = hostname.toLowerCase();
  return host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
}

function portOf(url) {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function relativePathname(pathname) {
  const withoutLeading = pathname.replace(/^\/+/, '');
  try {
    return decodeURIComponent(withoutLeading);
  } catch {
    return withoutLeading;
  }
}

function isInside(folder, file) {
  return file === folder || file.startsWith(folder + path.sep);
}

function slashPath(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function expandHome(document, env) {
  if (document === '~') return homeDir(env);
  if (document.startsWith(`~${path.sep}`) || document.startsWith('~/')) return path.join(homeDir(env), document.slice(2));
  return document;
}

async function realPathOrResolved(candidate) {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function realRoots(found) {
  const roots = [];
  for (const root of found.hyperclayLocal?.roots || []) {
    roots.push({ path: await realPathOrResolved(root.path), port: root.port });
  }
  return roots;
}

function matchingRoot(roots, file) {
  let best = null;
  for (const root of roots) {
    if (!isInside(root.path, file)) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  return best;
}

function localTarget(root, file) {
  const relative = slashPath(root.path, file);
  return { host: 'local', port: root.port, path: relative, ref: `http://127.0.0.1:${root.port}/${relative}` };
}

function htmlClayFileTarget(port, home, file) {
  return { host: 'htmlclay', port, id: htmlClayDocumentId(file), path: slashPath(home, file), ref: file };
}

function localFromUrl(url, roots) {
  const port = portOf(url);
  const root = roots.find((entry) => entry.port === port);
  const relative = relativePathname(url.pathname);
  return { host: 'local', port, path: relative, ref: `http://127.0.0.1:${port}/${relative}` };
}

const SERVED_SUFFIX = '.htmlclay.localhost';

// servedTarget is a served folder's address as the file it names, through the
// folder list HTML Clay's config held when this process started.
function servedTarget(url, found, port) {
  const name = url.hostname.toLowerCase().slice(0, -SERVED_SUFFIX.length);
  const folder = (found.htmlClay?.servedFolders ?? []).find((entry) => entry.name.toLowerCase() === name);
  if (!folder) {
    throw new ClayError('not-found', `HTML Clay serves no folder named ${name}.`, { hint: OPEN_AN_APP });
  }
  const relative = relativePathname(url.pathname);
  const file = path.resolve(folder.path, relative);
  if (!isInside(folder.path, file)) {
    throw new ClayError('not-found', 'That address points outside the served folder.');
  }
  return { host: 'htmlclay', port, id: htmlClayDocumentId(file), path: relative, ref: file };
}

function htmlClayFromUrl(url, port, env, found) {
  if (url.hostname.toLowerCase().endsWith(SERVED_SUFFIX)) return servedTarget(url, found, port);
  const slug = slugOf(url.hostname);
  if (slug) {
    return { host: 'htmlclay', port, slug, ref: `http://${slug}.localhost:${port}/${relativePathname(url.pathname)}` };
  }
  const relative = relativePathname(url.pathname);
  const ref = path.join(homeDir(env), relative);
  return { host: 'htmlclay', port, id: htmlClayDocumentId(ref), path: relative, ref };
}

function loopbackTarget(url, found, roots, hostOverride, env) {
  const port = portOf(url);
  const root = roots.find((entry) => entry.port === port) || null;
  const clayServes = Boolean(found.htmlClay) && found.htmlClay.port === port;

  if (hostOverride === 'local') {
    if (!root) throw ambiguousTarget(url.href, hostOverride);
    return localFromUrl(url, roots);
  }
  if (hostOverride === 'htmlclay') {
    if (!clayServes) throw ambiguousTarget(url.href, hostOverride);
    return htmlClayFromUrl(url, port, env, found);
  }
  if (root) return localFromUrl(url, roots);
  if (clayServes) return htmlClayFromUrl(url, port, env, found);
  throw hostUnavailable(port);
}

export async function resolveTarget(
  document,
  { cwd = process.cwd(), env = process.env, platform = process.platform, discovered, hostOverride = null } = {},
) {
  if (typeof document !== 'string' || document.trim() === '') {
    throw new ClayError('not-found', 'No document was given.', { hint: DOCUMENT_FORMS });
  }

  const reference = document.trim();
  const found = discovered ?? (await discover(env, platform));
  const roots = await realRoots(found);

  const byId = HYPERCLAY_REFERENCE.exec(reference);
  if (byId) {
    if (hostOverride && hostOverride !== 'hyperclay') throw ambiguousTarget(reference, hostOverride);
    const id = byId[1];
    return { host: 'hyperclay', id, ref: `hyperclay:${id}` };
  }

  if (URL_PATTERN.test(reference)) {
    let url;
    try {
      url = new URL(reference);
    } catch {
      url = null;
    }
    if (url) {
      if (!isLoopback(url.hostname)) {
        if (hostOverride && hostOverride !== 'hyperclay') throw ambiguousTarget(reference, hostOverride);
        return { host: 'hyperclay', url: reference };
      }
      return loopbackTarget(url, found, roots, hostOverride, env);
    }
  }

  const absolute = path.resolve(cwd, expandHome(reference, env));
  let file;
  try {
    file = await fs.realpath(absolute);
  } catch {
    throw new ClayError('not-found', `There is no file at ${absolute}.`, { hint: DOCUMENT_FORMS });
  }

  if (!DOCUMENT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    throw new ClayError('not-a-document', `That is not an HTML document: ${file}.`, {
      hint: 'clay-agent works on .html, .htm and .htmlclay files.',
    });
  }

  const root = matchingRoot(roots, file);
  const home = await realPathOrResolved(homeDir(env));
  const clayServes = Boolean(found.htmlClay) && isInside(home, file);

  if (hostOverride === 'local') {
    if (!root) throw ambiguousTarget(file, hostOverride);
    return localTarget(root, file);
  }
  if (hostOverride === 'htmlclay') {
    if (!clayServes) throw ambiguousTarget(file, hostOverride);
    return htmlClayFileTarget(found.htmlClay.port, home, file);
  }
  if (hostOverride) throw ambiguousTarget(file, hostOverride);

  if (root) return localTarget(root, file);
  if (clayServes) return htmlClayFileTarget(found.htmlClay.port, home, file);

  throw new ClayError('host-unavailable', 'No app on this machine can serve that file.', { hint: OPEN_AN_APP });
}
