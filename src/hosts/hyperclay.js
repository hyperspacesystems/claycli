import { randomUUID } from 'node:crypto';

import { ClayError, asClayError, redact } from '../errors.js';

const KEY_HINT =
  'Make an agent key in the dashboard (Account, then Agent keys), then run: npx -y @panphora/claycli login';

export const HINTS = {
  conflict: 'The file changed after you read it. Read it again and redo the change.',
  'precondition-required': 'Read the file first, then send its etag.',
  'read-first': 'Read the file first, then send its etag.',
  unauthorized: KEY_HINT,
  'key-revoked': KEY_HINT,
  'key-expired': KEY_HINT,
  'invalid-subdomain': 'Use letters, numbers and single dashes, and avoid reserved words.',
  'name-in-use': 'Choose another name.',
  'subdomain-already-set': 'Change a subdomain in the dashboard.',
  'subdomain-limit-reached': 'Your subdomain limit grows each month.',
  'not-a-site-folder': 'A site folder holds its own site.json file. Add one to the folder, then try again.',
  'not-supported': 'This hyperclay.com server is older than this version of claycli. Use the dashboard for this for now.',
  'wildcard-not-allowed': 'Add a wildcard domain in the dashboard.',
  'domain-already-added': 'This domain is on another of your HTML files or sites. Remove it there in the dashboard first.',
  'domain-in-use': 'Another account uses this domain, or a name that overlaps it.',
  'already-exists': 'Something is already at that path. List the folder and replace it with its etag.',
  'secret-in-content': 'Remove the agent key from the file, then try again.',
  managed: 'This place belongs to a collection or to one HTML file. Write somewhere else.',
  'path-conflict': 'A file and a folder cannot share one name. Rename one of them.',
  'recovery-unavailable': 'Nothing was written. Send the same change again in a moment.',
  'operation-reused': 'Send each new change with a new operation id.',
  'save-already-applied': 'This change was already saved. Read the file again to see what it holds.',
};

export function hyperclayClient({
  base,
  getKey,
  fetchImpl = fetch,
  timeoutMs = 30000,
  label = 'hyperclay.com',
  requireKey = true,
  hints = HINTS,
  noLane = 'This host does not have agent keys turned on.',
} = {}) {
  const root = `${String(base ?? '').replace(/\/+$/, '')}/_/agent/v1`;

  function requireEtag(method, etag) {
    if (!etag) {
      throw new ClayError('read-first', `${method} needs the etag from a read.`, {
        hint: hints['read-first'],
      });
    }
    return etag;
  }

  function lostOutcome() {
    return new ClayError('outcome-unknown', 'The change may or may not have been saved.', {
      hint: 'Read the file again before trying anything else.',
    });
  }

  function isTimeout(error) {
    return error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError';
  }

  function tookTooLong() {
    return new ClayError('host-unavailable', 'The host did not answer in time.', {
      hint: 'Check your connection, then try again.',
      retryable: true,
    });
  }

  function notSent(error) {
    const code = error?.code;
    return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENETUNREACH';
  }

  async function request(pathname, { method = 'GET', query = null, body, raw, headers: extra = {}, etag, ifNoneMatch, noEtag = false } = {}) {
    const key = getKey ? await getKey() : null;
    if (!key && requireKey) {
      throw new ClayError('key-missing', 'Not signed in to hyperclay.com.', { hint: KEY_HINT });
    }

    const write = method !== 'GET';
    const url = new URL(`${root}${pathname}`);

    if (query) {
      for (const [name, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(name, String(value));
      }
    }

    const headers = { Accept: 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (raw !== undefined) headers['Content-Type'] = 'application/octet-stream';
    if (etag) headers['If-Match'] = etag;
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    Object.assign(headers, extra);

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        if (write) throw lostOutcome();
        throw tookTooLong();
      }
      const cause = error?.cause ?? error;
      if (write && !notSent(cause)) throw lostOutcome();
      throw asClayError(cause);
    }

    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (write) throw lostOutcome();
      if (isTimeout(error)) throw tookTooLong();
      throw asClayError(error?.cause ?? error);
    }

    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    const detail = parsed?.error;

    if (response.status === 304) {
      return { notModified: true, etag: ifNoneMatch ?? null };
    }

    if (response.ok) {
      if (parsed === null) {
        if (write) throw lostOutcome();
        throw new ClayError('host-error', redact(`${label} answered ${response.status}.`), {
          status: response.status,
        });
      }
      if (write && !noEtag && typeof parsed.etag !== 'string') throw lostOutcome();
      return parsed;
    }

    if (detail?.code) {
      const details = {};
      for (const [name, value] of Object.entries(detail)) {
        if (name === 'code' || name === 'message' || name === 'etag') continue;
        details[name] = value;
      }
      const retryable = response.status === 429 || response.status === 503;
      if (retryable) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = Number(retryAfter);
        if (retryAfter !== null && Number.isFinite(seconds)) details.retryAfter = seconds;
      }
      throw new ClayError(detail.code, redact(detail.message || `${label} refused this request.`), {
        hint: hints[detail.code] ?? null,
        status: response.status,
        etag: detail.etag ?? null,
        retryable,
        details: Object.keys(details).length ? details : null,
      });
    }

    if (write && response.status >= 500) throw lostOutcome();

    if (response.status === 404) {
      throw new ClayError('not-found', noLane, {
        status: response.status,
      });
    }

    throw new ClayError('host-error', redact(`${label} answered ${response.status}.`), {
      status: response.status,
    });
  }

  let offered = null;
  async function features() {
    offered ??= request('/whoami').then((answer) => (Array.isArray(answer?.features) ? answer.features : []));
    try {
      return await offered;
    } catch (error) {
      offered = null;
      throw error;
    }
  }

  async function etagFreeWrite(pathname, body, check) {
    const answer = await request(pathname, { method: 'POST', body, noEtag: true });
    if (!check(answer)) throw lostOutcome();
    return answer;
  }

  return {
    list({ account, url, cursor, limit } = {}) {
      return request('/documents', { query: { account, url, cursor, limit } });
    },

    read(id, { ifNoneMatch } = {}) {
      return request(`/documents/${encodeURIComponent(id)}`, { ifNoneMatch });
    },

    readData(id) {
      return request(`/documents/${encodeURIComponent(id)}/data`);
    },

    versions(id, { before } = {}) {
      return request(`/documents/${encodeURIComponent(id)}/versions`, { query: { before } });
    },

    version(id, versionId) {
      return request(`/documents/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`);
    },

    async save(id, { html, etag, operationId = randomUUID() } = {}) {
      const match = requireEtag('Saving', etag);
      return request(`/documents/${encodeURIComponent(id)}`, {
        method: 'PUT',
        etag: match,
        body: { html, operationId },
      });
    },

    async writeData(id, { data, etag, operationId = randomUUID() } = {}) {
      const match = requireEtag('Writing data', etag);
      return request(`/documents/${encodeURIComponent(id)}/data`, {
        method: 'POST',
        etag: match,
        body: { data, operationId },
      });
    },

    async restore(id, versionId, { etag, operationId = randomUUID() } = {}) {
      const match = requireEtag('Restoring', etag);
      return request(
        `/documents/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
        { method: 'POST', etag: match, body: { operationId } },
      );
    },

    claimSubdomain(id, subdomain) {
      return etagFreeWrite(`/documents/${encodeURIComponent(id)}/subdomain`, { subdomain },
        (answer) => typeof answer?.subdomain === 'string');
    },

    features,

    listSites({ account, path, url, cursor } = {}) {
      return request('/sites', { query: { account, path, url, cursor } });
    },

    claimSiteSubdomain(id, subdomain) {
      return etagFreeWrite(`/sites/${encodeURIComponent(id)}/subdomain`, { subdomain },
        (answer) => typeof answer?.subdomain === 'string');
    },

    listFiles({ account, path, cursor } = {}) {
      return request('/files', { query: { account, path, cursor } });
    },

    async putFile(filePath, bytes, { account, create = false, etag } = {}) {
      if (!create) requireEtag('Replacing a file', etag);
      return request('/files', {
        method: 'PUT',
        query: { account, path: filePath },
        raw: bytes,
        headers: { 'X-Operation-Id': randomUUID() },
        etag: create ? undefined : etag,
        ifNoneMatch: create ? '*' : undefined,
      });
    },

    addDomain(kind, id, { domain, alsoWww = false } = {}) {
      return etagFreeWrite(`/${kind}/${encodeURIComponent(id)}/domains`, { domain, alsoWww },
        (answer) => typeof answer?.domain?.domain === 'string');
    },

    domainStatus(kind, id) {
      return request(`/${kind}/${encodeURIComponent(id)}/domains`);
    },
  };
}
