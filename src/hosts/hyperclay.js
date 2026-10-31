import { randomUUID } from 'node:crypto';

import { ClayError, asClayError, redact } from '../errors.js';

const KEY_HINT =
  'Make an agent key in the dashboard (Account, then Agent keys), then run: npx -y @panphora/clay-agent login';

const HINTS = {
  conflict: 'The document changed after you read it. Read it again and redo the change.',
  'precondition-required': 'Read the document first, then send its etag.',
  'read-first': 'Read the document first, then send its etag.',
  unauthorized: KEY_HINT,
  'key-revoked': KEY_HINT,
  'key-expired': KEY_HINT,
};

export function hyperclayClient({ base, getKey, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const root = `${String(base ?? '').replace(/\/+$/, '')}/_/agent/v1`;

  function requireEtag(method, etag) {
    if (!etag) {
      throw new ClayError('read-first', `${method} needs the etag from a read.`, {
        hint: HINTS['read-first'],
      });
    }
    return etag;
  }

  function lostOutcome() {
    return new ClayError('outcome-unknown', 'The change may or may not have been saved.', {
      hint: 'Read the document again before trying anything else.',
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

  async function request(pathname, { method = 'GET', query = null, body, etag, ifNoneMatch } = {}) {
    const key = getKey ? await getKey() : null;
    if (!key) {
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

    const headers = {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (etag) headers['If-Match'] = etag;
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
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
        throw new ClayError('host-error', redact(`hyperclay.com answered ${response.status}.`), {
          status: response.status,
        });
      }
      if (write && typeof parsed.etag !== 'string') throw lostOutcome();
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
      throw new ClayError(detail.code, redact(detail.message || 'hyperclay.com refused this request.'), {
        hint: HINTS[detail.code] ?? null,
        status: response.status,
        etag: detail.etag ?? null,
        retryable,
        details: Object.keys(details).length ? details : null,
      });
    }

    if (write && response.status >= 500) throw lostOutcome();

    if (response.status === 404) {
      throw new ClayError('not-found', 'This host does not have agent keys turned on.', {
        status: response.status,
      });
    }

    throw new ClayError('host-error', redact(`hyperclay.com answered ${response.status}.`), {
      status: response.status,
    });
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

    async save(id, { html, etag } = {}) {
      const match = requireEtag('Saving', etag);
      return request(`/documents/${encodeURIComponent(id)}`, {
        method: 'PUT',
        etag: match,
        body: { html, operationId: randomUUID() },
      });
    },

    async writeData(id, { data, etag } = {}) {
      const match = requireEtag('Writing data', etag);
      return request(`/documents/${encodeURIComponent(id)}/data`, {
        method: 'POST',
        etag: match,
        body: { data, operationId: randomUUID() },
      });
    },

    async restore(id, versionId, { etag } = {}) {
      const match = requireEtag('Restoring', etag);
      return request(
        `/documents/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
        { method: 'POST', etag: match, body: { operationId: randomUUID() } },
      );
    },
  };
}
