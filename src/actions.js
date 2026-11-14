import path from 'node:path';

import { ClayError } from './errors.js';
import { applyEdits } from './html/edit.js';
import { find } from './html/find.js';
import { outline } from './html/outline.js';
import { range as sliceRange, select as selectMatches } from './html/select.js';
import { planPublish, readLocal, runPublish, walkFolder } from './publish.js';
import { createSession } from './session.js';

const KEY_PATTERN = /hcak_[0-9a-f]{64}/;
const TOO_LARGE_HINT =
  'Use outline_document to see its structure, find_in_document to locate text, or read_document with select or range to read part of it.';

const TOO_LARGE_TO_OUTLINE_HINT =
  'Too large to outline here. Use find_in_document with text to locate what you need, read_document with range to read part of it, and edit_document to change exact text.';

const CUT_HINT =
  'The answer was cut to stay within maxChars. Read the rest with range, starting at the end offset shown.';

const WHOLE_READ_FIRST_HINT =
  'Read the whole document with read_document first; save_document replaces all of it.';

function readFirstHint(explicitEtag) {
  return explicitEtag
    ? 'Pass --if-match with the etag from a read.'
    : 'Read the document first (read_document, outline_document, find_in_document or read_data), then write.';
}

function refuseParse(size) {
  throw new ClayError('too-large-to-parse', `This document is ${size} characters, too large to search or outline here.`, {
    hint: 'Read it in parts with range (start and length), and change it with edit_document, which finds exact text without parsing.',
  });
}

function shapeRead({ ref, host, etag, html, maxChars, parseLimit = Infinity, input }) {
  if (input.select !== undefined && input.select !== null) {
    if (input.range !== undefined && input.range !== null) {
      throw new ClayError('invalid-read', 'Pass either `select` or `range`, not both.', {
        hint: 'Use `select` for elements by CSS selector, or `range` for a start and length.',
      });
    }
    if (html.length > parseLimit) refuseParse(html.length);
    const { count, matches } = selectMatches(html, input.select, { maxChars });
    const answer = { ref, host, etag, size: html.length, count, matches };
    if (matches.some((match) => match.truncated)) answer.hint = CUT_HINT;
    return answer;
  }
  if (input.range !== undefined && input.range !== null) {
    const start = input.range.start;
    const length = input.range.length;
    const { start: from, end, html: slice, truncated } = sliceRange(html, start, length, { maxChars });
    const answer = { ref, host, etag, size: html.length, start: from, end, html: slice };
    if (truncated) {
      answer.truncated = true;
      answer.hint = CUT_HINT;
    }
    return answer;
  }
  if (html.length <= maxChars) {
    return { ref, host, etag, size: html.length, html };
  }
  const answer = { ref, host, etag, size: html.length, tooLarge: true };
  if (html.length <= parseLimit) answer.outline = outline(html, { depth: 3 }).outline;
  answer.hint = html.length > parseLimit ? TOO_LARGE_TO_OUTLINE_HINT : TOO_LARGE_HINT;
  return answer;
}

export function createActions({ adapters, resolve, session = createSession(), readOnly = false, explicitEtag = false, cwd = process.cwd(), parseLimit = Infinity, editScanLimit = false, regexWorkers = Infinity }) {
  function refuseReadOnly() {
    if (readOnly) throw new ClayError('read-only-mode', 'This server was started read-only.');
  }

  function adapterFor(host) {
    const adapter = adapters[host];
    if (!adapter) {
      throw new ClayError('host-unavailable', `No adapter is available for ${host}.`, {
        hint: 'This build talks to hyperclay.com; other hosts are not connected yet.',
      });
    }
    return adapter;
  }

  async function targetFor(input) {
    const target = await resolve(input.document, { host: input.host });
    const adapter = adapterFor(target.host);
    const { id, ref } = await adapter.locate(target);
    return { host: target.host, adapter, id, ref };
  }

  function given(value) {
    return value !== undefined && value !== null && value !== '';
  }

  // A document, or a site folder: a folder in a hyperclay.com account that holds its own site.json.
  async function nodeFor(input) {
    if (given(input.document) === given(input.site)) {
      throw new ClayError('invalid-argument', 'Pass either `document` or `site`, not both.', {
        hint: 'Use `site` for a folder such as demos/maya, and `document` for one page.',
      });
    }
    if (given(input.document)) return { ...(await targetFor(input)), kind: 'documents' };
    const host = input.host ?? 'hyperclay';
    const adapter = adapterFor(host);
    if (!adapter.locateSite) {
      throw new ClayError('host-unavailable', 'Sites live on hyperclay.com only.');
    }
    const { id, ref } = await adapter.locateSite({ site: input.site, account: input.account });
    return { host, adapter, id, ref, kind: 'sites' };
  }

  function hyperclayAdapterFor(input, method) {
    const host = input.host ?? 'hyperclay';
    const adapter = adapterFor(host);
    if (!adapter[method]) throw new ClayError('host-unavailable', 'This lives on hyperclay.com only.');
    return { host, adapter };
  }

  async function load(input) {
    const { host, adapter, id, ref } = await targetFor(input);
    const stored = session.latest(ref);
    const ifNoneMatch = stored && stored.html !== undefined ? stored.etag : undefined;
    const result = await adapter.read(id, { ifNoneMatch });
    if (result.notModified) {
      return { ref, host, id, etag: stored.etag, html: stored.html, size: stored.html.length };
    }
    session.remember(ref, { etag: result.etag, html: result.html });
    return {
      ref,
      host,
      id,
      etag: result.etag,
      html: result.html,
      size: result.size ?? result.html.length,
    };
  }

  function etagFor(input, ref, { whole = false } = {}) {
    if (input.etag) return input.etag;
    if (explicitEtag) {
      throw new ClayError('read-first', 'This write needs the etag from a read.', {
        hint: readFirstHint(true),
      });
    }
    const known = whole ? session.wholeEtag(ref) : session.seenEtag(ref);
    if (!known) {
      throw new ClayError('read-first', 'This write needs the etag from a read.', {
        hint: whole ? WHOLE_READ_FIRST_HINT : readFirstHint(false),
      });
    }
    return known;
  }

  function afterWrite(ref, etag) {
    session.remember(ref, { etag });
    session.markSeen(ref, etag);
  }

  function refuseSecret(html) {
    if (typeof html === 'string' && KEY_PATTERN.test(html)) {
      throw new ClayError('secret-in-content', 'The document would contain an agent key. Remove it before saving.');
    }
  }

  return {
    list_documents(input = {}) {
      const host = input.host ?? 'hyperclay';
      return adapterFor(host).list({ where: input.where, cursor: input.cursor });
    },

    async read_document(input = {}) {
      const maxChars = input.maxChars ?? 40000;
      const loaded = await load(input);
      const shaped = shapeRead({
        ref: loaded.ref,
        host: loaded.host,
        etag: loaded.etag,
        html: loaded.html,
        maxChars,
        parseLimit,
        input,
      });
      session.markSeen(loaded.ref, loaded.etag);
      if (!input.select && !input.range && !shaped.tooLarge) {
        session.markWhole(loaded.ref, loaded.etag);
      }
      return shaped;
    },

    async outline_document(input = {}) {
      const loaded = await load(input);
      if (loaded.html.length > parseLimit) refuseParse(loaded.html.length);
      const result = outline(loaded.html, { depth: input.depth ?? 4, select: input.select ?? null });
      session.markSeen(loaded.ref, loaded.etag);
      const answer = {
        ref: loaded.ref,
        host: loaded.host,
        etag: loaded.etag,
        size: result.size,
        hasApiRules: result.hasApiRules,
        dataKeys: result.dataKeys,
        depth: result.depth,
        truncated: result.truncated,
        outline: result.outline,
      };
      if (result.truncated) answer.hint = result.hint;
      return answer;
    },

    async find_in_document(input = {}) {
      const loaded = await load(input);
      const hasRegex = input.regex !== undefined && input.regex !== null;
      if (loaded.html.length > parseLimit && hasRegex) refuseParse(loaded.html.length);
      const { count, matches, elementPaths } = await find(loaded.html, {
        text: input.text,
        regex: input.regex,
        limit: input.limit ?? 20,
        parseLimit,
        workerLimit: regexWorkers,
      });
      session.markSeen(loaded.ref, loaded.etag);
      const answer = { ref: loaded.ref, host: loaded.host, etag: loaded.etag, count, matches };
      if (elementPaths === false) answer.elementPaths = false;
      return answer;
    },

    async read_data(input = {}) {
      const { host, adapter, id, ref } = await targetFor(input);
      const result = await adapter.readData(id);
      const stored = session.latest(ref);
      const keep =
        stored && stored.etag === result.etag && stored.html !== undefined ? { html: stored.html } : {};
      session.remember(ref, { etag: result.etag, ...keep });
      session.markSeen(ref, result.etag);
      return { ref, host, etag: result.etag, data: result.data };
    },

    async write_data(input = {}) {
      refuseReadOnly();
      const { host, adapter, id, ref } = await targetFor(input);
      refuseSecret(JSON.stringify(input.data));
      const etag = etagFor(input, ref);
      const result = await adapter.writeData(id, { data: input.data, etag });
      afterWrite(ref, result.etag);
      return { ref, host, etag: result.etag, changed: result.changed, data: result.data ?? input.data };
    },

    async edit_document(input = {}) {
      refuseReadOnly();
      const { host, adapter, id, ref } = await targetFor(input);
      const etag = etagFor(input, ref);
      let base = session.htmlFor(ref, etag);
      if (base === null) {
        const loaded = await load(input);
        if (loaded.etag !== etag) {
          throw new ClayError('conflict', 'The document changed after you read it.', {
            etag: loaded.etag,
            hint: 'Read it again and redo the edit.',
          });
        }
        base = loaded.html;
      }
      const { html } = applyEdits(base, input.edits, { scanLimit: editScanLimit });
      refuseSecret(html);
      const result = await adapter.save(id, { html, etag });
      afterWrite(ref, result.etag);
      if (session.wholeEtag(ref) === etag) session.markWhole(ref, result.etag);
      else session.clearWhole(ref);
      return {
        ref,
        host,
        etag: result.etag,
        changed: result.changed,
        chars: html.length,
        undoVersionId: result.undoVersionId,
      };
    },

    async save_document(input = {}) {
      refuseReadOnly();
      const { host, adapter, id, ref } = await targetFor(input);
      refuseSecret(input.html);
      const etag = etagFor(input, ref, { whole: true });
      const result = await adapter.save(id, { html: input.html, etag });
      afterWrite(ref, result.etag);
      session.markWhole(ref, result.etag);
      return {
        ref,
        host,
        etag: result.etag,
        changed: result.changed,
        undoVersionId: result.undoVersionId,
      };
    },

    async list_versions(input = {}) {
      const { host, adapter, id, ref } = await targetFor(input);
      const result = await adapter.versions(id, { before: input.before });
      return { ref, host, versions: result.versions, nextBefore: result.nextBefore };
    },

    async read_version(input = {}) {
      const { host, adapter, id, ref } = await targetFor(input);
      const version = await adapter.version(id, input.version);
      const maxChars = input.maxChars ?? 40000;
      const shaped = shapeRead({
        ref,
        host,
        etag: version.etag,
        html: version.html,
        maxChars,
        parseLimit,
        input: { select: input.select, range: input.range },
      });
      const { ref: shapedRef, host: shapedHost, etag: shapedEtag, ...rest } = shaped;
      const result = { ref: shapedRef, host: shapedHost };
      if (shapedEtag !== undefined) result.etag = shapedEtag;
      result.version = input.version;
      return Object.assign(result, rest);
    },

    async restore_version(input = {}) {
      refuseReadOnly();
      const { host, adapter, id, ref } = await targetFor(input);
      const etag = etagFor(input, ref);
      const result = await adapter.restore(id, input.version, { etag });
      afterWrite(ref, result.etag);
      return { ref, host, etag: result.etag };
    },

    async claim_subdomain(input = {}) {
      refuseReadOnly();
      const { host, adapter, id, ref, kind } = await nodeFor(input);
      const result = kind === 'sites'
        ? await adapter.claimSiteSubdomain(id, input.subdomain)
        : await adapter.claimSubdomain(id, input.subdomain);
      return { ref, host, subdomain: result.subdomain, url: result.url, changed: result.changed, warnings: result.warnings ?? [] };
    },

    async list_sites(input = {}) {
      const { adapter } = hyperclayAdapterFor(input, 'listSites');
      return adapter.listSites({ account: input.account, cursor: input.cursor });
    },

    async list_files(input = {}) {
      const { adapter } = hyperclayAdapterFor(input, 'listFiles');
      return adapter.listFiles({ account: input.account, path: input.path ?? '', cursor: input.cursor });
    },

    async add_domain(input = {}) {
      refuseReadOnly();
      const { host, adapter, id, ref, kind } = await nodeFor(input);
      const result = await adapter.addDomain(kind, id, { domain: input.domain, alsoWww: input.alsoWww === true });
      return { ref, host, domain: result.domain, changed: result.changed, warnings: result.warnings ?? [] };
    },

    async domain_status(input = {}) {
      const { host, adapter, id, ref, kind } = await nodeFor(input);
      const result = await adapter.domainStatus(kind, id);
      return { ref, host, domains: result.domains ?? [] };
    },
    async create_document(input) {
      refuseReadOnly();
      const filePath = String(input.path ?? '').trim();
      if (!/\.(html|htmlclay)$/.test(filePath)) {
        throw new ClayError('invalid-argument', 'A new document needs a path ending in .html, such as notes/plan.html.');
      }
      const { host, adapter } = hyperclayAdapterFor(input, 'putFile');
      const written = await adapter.putFile(filePath, Buffer.from(String(input.html ?? ''), 'utf8'), { create: true, account: input.account });
      return { host, ref: `hyperclay:${written.id}`, id: written.id, path: written.path, etag: written.etag, size: written.size, folders: written.folders ?? [] };
    },

    async publish_site(input = {}) {
      refuseReadOnly();
      const { host, adapter } = hyperclayAdapterFor(input, 'putFile');
      const to = String(input.to ?? '').replace(/^\/+|\/+$/g, '');
      if (!to || to.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new ClayError('invalid-argument', 'Name the folder in your account to publish to, such as demos/maya.');
      }
      const root = path.resolve(cwd, String(input.folder ?? ''));
      const { files, skipped } = await walkFolder(root);
      const { local, refused: refusedLocally } = await readLocal(files, to);
      const remoteFiles = await adapter.listAllFiles({ account: input.account, path: to });
      const plan = planPublish({ local, remote: remoteFiles, to });
      const refused = [...refusedLocally, ...plan.refused];
      const summary = {
        host,
        to,
        dryRun: input.dryRun === true,
        create: plan.steps.filter((step) => step.action === 'create').map((step) => step.path),
        replace: plan.steps.filter((step) => step.action === 'replace').map((step) => step.path),
        unchanged: plan.steps.filter((step) => step.action === 'unchanged').map((step) => step.path),
        remoteOnly: plan.remoteOnly,
        skipped,
        refused,
      };
      if (input.dryRun === true) return summary;
      const result = await runPublish({
        plan,
        to,
        subdomain: input.subdomain ?? null,
        refused,
        remote: {
          putFile: (filePath, bytes, options) => adapter.putFile(filePath, bytes, { ...options, account: input.account }),
          listAllFiles: (folderPath) => adapter.listAllFiles({ account: input.account, path: folderPath }),
          claimSubdomain: async (sitePath, name) => {
            const { id } = await adapter.locateSite({ site: sitePath, account: input.account });
            return adapter.claimSiteSubdomain(id, name);
          },
        },
      });
      return {
        host,
        to,
        dryRun: false,
        created: result.created,
        replaced: result.replaced,
        unchanged: result.unchanged,
        failed: result.failed,
        pending: result.pending,
        remoteOnly: plan.remoteOnly,
        skipped,
        refused,
        subdomain: result.subdomain,
      };
    },
  };
}
