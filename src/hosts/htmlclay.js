import path from 'node:path';

import { ClayError } from '../errors.js';
import { HINTS, hyperclayClient } from './hyperclay.js';

const LANE_HINTS = {
  ...HINTS,
  'not-reachable': 'Open the document in HTML Clay, or serve or trust its folder, then try again.',
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

function writesLater() {
  return new ClayError('not-supported', 'This clay-agent reads HTML Clay documents but cannot change them yet.', {
    hint: 'Update clay-agent to change HTML Clay documents.',
  });
}

export function htmlClayAdapter(client) {
  const byUrl = new Map();

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
    async save() {
      throw writesLater();
    },
    async writeData() {
      throw writesLater();
    },
    async restore() {
      throw writesLater();
    },
  };
}
