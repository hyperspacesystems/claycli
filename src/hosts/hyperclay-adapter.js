import { ClayError } from '../errors.js';

const PLAIN_USERNAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function stringId(value) {
  return value === undefined || value === null ? null : String(value);
}

function sameUrl(left, right) {
  const normalize = (url) => String(url ?? '').replace(/\/$/, '').replace(/\.html$/, '');
  return normalize(left) === normalize(right);
}

export function hyperclayAdapter(client) {
  const byUrl = new Map();

  async function locate(target) {
    if (target.url) {
      let found = byUrl.get(target.url);
      if (!found) {
        const listed = await client.list({ url: target.url });
        const match = (listed?.documents ?? []).find((doc) => sameUrl(doc.url, target.url));
        if (!match) {
          throw new ClayError('not-found', 'No document at that URL that this key can reach.');
        }
        found = { id: match.id, ref: `hyperclay:${match.id}` };
        byUrl.set(target.url, found);
      }
      return { id: found.id, ref: found.ref };
    }
    return { id: target.id, ref: target.ref };
  }

  async function list({ where, cursor } = {}) {
    const query = { cursor };
    if (where !== undefined && where !== null && where !== '') {
      if (String(where).includes('hcak_')) {
        throw new ClayError('invalid-argument', 'Do not put an agent key in a document search.');
      }
      if (PLAIN_USERNAME.test(where)) query.account = where;
      else query.url = where;
    }
    const result = await client.list(query);
    const documents = (result?.documents ?? []).map((doc) => ({
      ref: `hyperclay:${doc.id}`,
      host: 'hyperclay',
      name: doc.name,
      url: doc.url,
      path: doc.path,
      updatedAt: doc.updatedAt,
    }));
    return { documents, nextCursor: stringId(result?.nextCursor) };
  }

  return {
    locate,
    list,
    read(id, { ifNoneMatch } = {}) {
      return client.read(id, { ifNoneMatch });
    },
    readData(id) {
      return client.readData(id);
    },
    writeData(id, { data, etag } = {}) {
      return client.writeData(id, { data, etag });
    },
    save(id, { html, etag } = {}) {
      return client.save(id, { html, etag });
    },
    async versions(id, { before } = {}) {
      const result = await client.versions(id, { before });
      return {
        ...result,
        versions: (result?.versions ?? []).map((version) => ({ ...version, id: stringId(version?.id) })),
        nextBefore: stringId(result?.nextBefore),
      };
    },
    version(id, versionId) {
      return client.version(id, versionId);
    },
    restore(id, versionId, { etag } = {}) {
      return client.restore(id, versionId, { etag });
    },
  };
}
