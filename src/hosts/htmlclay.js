import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { ClayError } from '../errors.js';
import { HINTS, hyperclayClient } from './hyperclay.js';

const LANE_HINTS = {
  ...HINTS,
  'not-reachable': 'Open the document in HTML Clay, or serve or trust its folder, then try again.',
  'read-required': 'This change removes items you have not read. Read the data again, then send the change.',
  unauthorized: "HTML Clay's agent token changed. Restart this program so it reads the new token.",
};

// htmlClayDocumentId is the id HTML Clay's agent lane gives a document: p_ and the
// base64url of its real absolute path.
export function htmlClayDocumentId(file) {
  return `p_${Buffer.from(file, 'utf8').toString('base64url')}`;
}

// htmlClayClient is the hosted client pointed at HTML Clay's loopback lane. The
// token is sent when HTML Clay wrote one; a lane that predates it needs none.
export function htmlClayClient({ port, token = null, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  return hyperclayClient({
    base: `http://127.0.0.1:${port}`,
    getKey: async () => token,
    fetchImpl,
    timeoutMs,
    label: 'HTML Clay',
    requireKey: false,
    hints: LANE_HINTS,
    noLane: 'This HTML Clay has no agent lane. Update HTML Clay, then try again.',
  });
}

function sameUrl(left, right) {
  const normalize = (url) => String(url ?? '').replace(/\/$/, '').replace(/\.html$/, '');
  return normalize(left) === normalize(right);
}

function fingerprint(parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}:${part}`);
  return hash.digest('hex');
}

// isOwnSave is a 412 naming this save's own operation id: the lane wrote it, and
// the answer that said so was lost.
function isOwnSave(error, operationId) {
  return error?.code === 'conflict' && error.details?.saveId === operationId && typeof error.etag === 'string';
}

export function htmlClayAdapter(client) {
  const byUrl = new Map();
  const pending = new Map();

  // write sends one logical change. Its operation id is kept while the outcome is
  // unknown, so sending the same change again replays rather than writes twice.
  // Nothing here retries on its own.
  async function write(parts, send) {
    const key = fingerprint(parts);
    const operationId = pending.get(key) ?? randomUUID();
    pending.set(key, operationId);
    try {
      const answer = await send(operationId);
      pending.delete(key);
      return answer;
    } catch (error) {
      if (error?.code === 'outcome-unknown') throw error;
      pending.delete(key);
      if (isOwnSave(error, operationId)) {
        return { etag: error.etag, changed: true, operationId, undoVersionId: null };
      }
      throw error;
    }
  }

  // locate answers the lane's id. A file or a served folder's address already
  // carries it; a loose file's own address is found in the lane's list.
  async function locate(target) {
    if (target.id) return { id: target.id, ref: target.ref };
    let found = byUrl.get(target.ref);
    if (!found) {
      const listed = await client.list();
      const match = (listed?.documents ?? []).find((doc) => sameUrl(doc.url, target.ref));
      if (!match) {
        throw new ClayError('not-found', 'HTML Clay has no open document at that address.', {
          hint: LANE_HINTS['not-reachable'],
        });
      }
      found = { id: match.id, ref: match.path };
      byUrl.set(target.ref, found);
    }
    return found;
  }

  async function list() {
    const result = await client.list();
    const documents = (result?.documents ?? []).map((doc) => ({
      ref: doc.path,
      host: 'htmlclay',
      name: path.basename(doc.path),
      url: doc.url,
      path: doc.path,
      folder: doc.folder,
      kind: doc.kind,
      open: doc.open === true,
    }));
    return { documents, nextCursor: null, truncated: result?.truncated === true };
  }

  return {
    locate,
    list,
    read: (id, options) => client.read(id, options),
    readData: (id) => client.readData(id),
    async versions(id, { before } = {}) {
      const result = await client.versions(id, { before });
      return { versions: result?.versions ?? [], nextBefore: result?.nextBefore ?? null };
    },
    version: (id, versionId) => client.version(id, versionId),
    save(id, { html, etag } = {}) {
      return write(['save', id, String(etag ?? ''), String(html ?? '')], (operationId) =>
        client.save(id, { html, etag, operationId }));
    },
    writeData(id, { data, etag } = {}) {
      return write(['data', id, String(etag ?? ''), JSON.stringify(data ?? null)], (operationId) =>
        client.writeData(id, { data, etag, operationId }));
    },
    restore(id, versionId, { etag } = {}) {
      return write(['restore', id, String(etag ?? ''), String(versionId)], (operationId) =>
        client.restore(id, versionId, { etag, operationId }));
    },
  };
}
