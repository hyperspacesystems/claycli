import { ClayError } from '../errors.js';
import { parseSiteTarget } from '../site-target.js';

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

  const sites = new Map();

  async function requireFeature(name) {
    const offered = await client.features();
    if (!offered.includes(name)) {
      throw new ClayError('not-supported', 'hyperclay.com does not offer this yet.', {
        hint: 'This hyperclay.com server is older than this clay-agent. Use the dashboard for this for now.',
      });
    }
  }

  async function locateSite({ site, account } = {}) {
    const target = parseSiteTarget(site);
    if (target.id) return { id: target.id, ref: `hyperclay:${target.id}` };
    const cacheKey = JSON.stringify([account ?? null, target.path ?? null, target.url ?? null]);
    let found = sites.get(cacheKey);
    if (!found) {
      await requireFeature('sites');
      const listed = await client.listSites({ account, path: target.path, url: target.url });
      const match = listed?.sites?.[0];
      if (!match) {
        throw new ClayError('not-found', 'No site folder there that this key can reach.', {
          hint: 'A site folder holds its own site.json. See them with list_sites.',
        });
      }
      found = { id: String(match.id), ref: `hyperclay:${match.id}` };
      sites.set(cacheKey, found);
    }
    return found;
  }

  async function listSites({ account, cursor } = {}) {
    await requireFeature('sites');
    const result = await client.listSites({ account, cursor });
    return {
      sites: (result?.sites ?? []).map((site) => ({ ...site, id: String(site.id), host: 'hyperclay' })),
      nextCursor: stringId(result?.nextCursor),
    };
  }

  async function listFiles({ account, path, cursor } = {}) {
    await requireFeature('files');
    const result = await client.listFiles({ account, path, cursor });
    return {
      account: result?.account ?? null,
      path: result?.path ?? '',
      files: (result?.files ?? []).map((file) => ({ ...file, id: String(file.id) })),
      nextCursor: stringId(result?.nextCursor),
    };
  }

  return {
    locate,
    list,
    locateSite,
    listSites,
    listFiles,
    async putFile(filePath, bytes, options) {
      await requireFeature('file-writes');
      return client.putFile(filePath, bytes, options);
    },
    // Every entry under a folder, across pages. A folder that does not exist (or is outside the
    // key) lists as empty; the first write then answers why.
    async listAllFiles({ account, path } = {}) {
      await requireFeature('files');
      const files = [];
      let cursor;
      do {
        let page;
        try {
          page = await client.listFiles({ account, path, cursor });
        } catch (error) {
          if (error?.code === 'not-found' && files.length === 0) return [];
          throw error;
        }
        files.push(...(page?.files ?? []));
        cursor = page?.nextCursor ?? undefined;
      } while (cursor !== undefined && cursor !== null);
      return files;
    },
    async claimSiteSubdomain(id, subdomain) {
      await requireFeature('folder-subdomain');
      return client.claimSiteSubdomain(id, subdomain);
    },
    async addDomain(kind, id, input) {
      await requireFeature('custom-domains');
      return client.addDomain(kind, id, input);
    },
    async domainStatus(kind, id) {
      await requireFeature('custom-domains');
      return client.domainStatus(kind, id);
    },
    read(id, { ifNoneMatch } = {}) {
      return client.read(id, { ifNoneMatch });
    },
    readData(id) {
      return client.readData(id);
    },
    writeData(id, { data, etag, operationId } = {}) {
      return client.writeData(id, { data, etag, operationId });
    },
    save(id, { html, etag, operationId } = {}) {
      return client.save(id, { html, etag, operationId });
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
    restore(id, versionId, { etag, operationId } = {}) {
      return client.restore(id, versionId, { etag, operationId });
    },
    claimSubdomain(id, subdomain) {
      return client.claimSubdomain(id, subdomain);
    },
  };
}
