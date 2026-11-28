import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ClayError } from '../src/errors.js';
import { hyperclayAdapter } from '../src/hosts/hyperclay-adapter.js';
import { hyperclayClient } from '../src/hosts/hyperclay.js';

const KEY = `hcak_${'c'.repeat(64)}`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function document() {
  return {
    id: 'doc_1',
    name: 'index.html',
    path: 'index.html',
    url: 'https://hyperclay.com/d/doc_1',
    etag: 'E1',
    size: 11,
    hasApiRules: false,
    html: '<h1>Hi</h1>',
  };
}

async function startServer() {
  const state = {
    requests: [],
    next: null,
    document: document(),
    replays: new Map(),
    data: { visits: 1 },
    dataEtag: 'D1',
    versions: [
      { id: 'v1', createdAt: '2024-01-01T00:00:00.000Z', recordedBy: { name: 'Ann' }, kind: 'edit' },
    ],
    features: ['sites', 'folder-subdomain', 'custom-domains', 'files'],
    sites: [
      { id: 42, ref: 'hyperclay:42', account: 'acct_1', path: 'demos/maya', url: 'https://acct_1.hyperclay.com/demos/maya/', subdomain: null, address: 'https://acct_1.hyperclay.com/demos/maya/', home: null, pages: 1 },
    ],
    filePages: [
      [{ id: 1, path: 'demos/maya/a.html', kind: 'file', etag: 'F1', size: 3, updatedAt: '2024-01-01T00:00:00.000Z' }],
      [{ id: 2, path: 'demos/maya/b.css', kind: 'file', etag: 'F2', size: 4, updatedAt: '2024-01-01T00:00:00.000Z' }],
    ],
  };

  function json(response, status, body, headers = {}) {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  }

  function refusal(response, status, code, message, extra = {}, headers = {}) {
    json(response, status, { error: { code, message, ...extra } }, headers);
  }

  function fingerprint(kind, value) {
    return `${kind}:${JSON.stringify(value)}`;
  }

  function repeat(kind, operationId, value) {
    if (typeof operationId !== 'string') return null;
    const seen = state.replays.get(operationId);
    if (!seen) return null;
    return seen.fingerprint === fingerprint(kind, value) ? seen.answer : 'reused';
  }

  function keep(kind, operationId, value, answer) {
    if (typeof operationId === 'string') {
      state.replays.set(operationId, { fingerprint: fingerprint(kind, value), answer });
    }
    return answer;
  }

  function route(request, response, body) {
    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const tail = parts.slice(3);
    const doc = state.document;

    if (request.method === 'GET' && tail.length === 1 && tail[0] === 'documents') {
      return json(response, 200, {
        documents: [
          {
            id: doc.id,
            account: 'acct_1',
            path: doc.path,
            name: doc.name,
            url: doc.url,
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      });
    }

    if (request.method === 'GET' && tail.length === 2 && tail[0] === 'documents') {
      if (request.headers['if-none-match'] === doc.etag) {
        response.writeHead(304, { etag: doc.etag });
        return response.end();
      }
      return json(response, 200, doc);
    }

    if (request.method === 'PUT' && tail.length === 2 && tail[0] === 'documents') {
      const parsed = JSON.parse(body || '{}');
      const seen = repeat('save', parsed.operationId, parsed.html);
      if (seen === 'reused') {
        return refusal(response, 400, 'operation-reused', 'That operation id was used for another change.');
      }
      if (seen) return json(response, 200, seen);
      if (request.headers['if-match'] !== doc.etag) {
        return refusal(response, 412, 'conflict', 'The document changed.', {
          etag: doc.etag,
          changedBy: { name: 'Ann' },
        });
      }
      doc.html = parsed.html;
      doc.etag = 'E2';
      return json(response, 200, keep('save', parsed.operationId, parsed.html, {
        etag: doc.etag,
        changed: true,
        operationId: parsed.operationId,
        undoVersionId: 'v2',
      }));
    }

    if (request.method === 'GET' && tail.length === 3 && tail[0] === 'documents' && tail[2] === 'data') {
      return json(response, 200, { data: state.data, etag: state.dataEtag });
    }

    if (request.method === 'POST' && tail.length === 3 && tail[0] === 'documents' && tail[2] === 'data') {
      const parsed = JSON.parse(body || '{}');
      const seen = repeat('data', parsed.operationId, parsed.data);
      if (seen === 'reused') {
        return refusal(response, 400, 'operation-reused', 'That operation id was used for another change.');
      }
      if (seen) return json(response, 200, seen);
      if (request.headers['if-match'] !== state.dataEtag) {
        return refusal(response, 412, 'conflict', 'The data changed.', { etag: state.dataEtag });
      }
      state.data = parsed.data;
      state.dataEtag = 'D2';
      return json(response, 200, keep('data', parsed.operationId, parsed.data, {
        etag: state.dataEtag,
        changed: true,
        operationId: parsed.operationId,
        undoVersionId: 'v2',
      }));
    }

    if (request.method === 'GET' && tail.length === 3 && tail[0] === 'documents' && tail[2] === 'versions') {
      return json(response, 200, { versions: state.versions, nextBefore: null });
    }

    if (request.method === 'GET' && tail.length === 4 && tail[0] === 'documents' && tail[2] === 'versions') {
      return json(response, 200, {
        id: tail[3],
        createdAt: '2024-01-01T00:00:00.000Z',
        html: '<h1>Old</h1>',
      });
    }

    if (
      request.method === 'POST' &&
      tail.length === 5 &&
      tail[0] === 'documents' &&
      tail[2] === 'versions' &&
      tail[4] === 'restore'
    ) {
      doc.etag = 'E3';
      return json(response, 200, { etag: doc.etag });
    }

    if (request.method === 'GET' && tail.length === 1 && tail[0] === 'whoami') {
      return json(response, 200, { person: { username: 'acct_1' }, key: {}, features: state.features });
    }

    if (request.method === 'GET' && tail.length === 1 && tail[0] === 'sites') {
      const wanted = url.searchParams.get('path');
      const sites = wanted ? state.sites.filter((site) => site.path === wanted) : state.sites;
      return json(response, 200, { sites, nextCursor: null });
    }

    if (request.method === 'GET' && tail.length === 1 && tail[0] === 'files') {
      const wanted = url.searchParams.get('path');
      if (wanted === 'demos/missing') {
        return refusal(response, 404, 'not-found', 'No folder there.');
      }
      const cursor = url.searchParams.get('cursor');
      const files = cursor ? state.filePages[1] : state.filePages[0];
      return json(response, 200, { account: 'acct_1', path: wanted, files, nextCursor: cursor ? null : 'p2' });
    }

    if (request.method === 'POST' && tail.length === 3 && tail[0] === 'sites' && tail[2] === 'subdomain') {
      const parsed = JSON.parse(body || '{}');
      return json(response, 200, { subdomain: parsed.subdomain, url: `https://${parsed.subdomain}.hyperclay.com`, changed: true, warnings: [] });
    }

    return refusal(response, 404, 'not-found', 'No route.');
  }

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const raw = Buffer.concat(chunks);
      state.requests.push({ method: request.method, url: request.url, headers: request.headers, body, raw });
      const next = state.next;
      state.next = null;
      if (next?.destroy) {
        request.socket.destroy();
        return;
      }
      if (next) {
        response.writeHead(next.status, {
          'content-type': next.contentType ?? 'application/json',
          ...(next.headers ?? {}),
        });
        response.end(next.body ?? '');
        return;
      }
      route(request, response, body);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    base: `http://127.0.0.1:${port}`,
    state,
    answer(status, body, options = {}) {
      state.next = { status, body: typeof body === 'string' ? body : JSON.stringify(body), ...options };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withServer(fn) {
  const server = await startServer();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function client(server) {
  return hyperclayClient({ base: server.base, getKey: async () => KEY });
}

test('every call sends the bearer header and no cookie, and the key stays out of the URL', async () => {
  await withServer(async (server) => {
    const api = client(server);

    await api.list({ account: 'acct_1' });
    await api.read('doc_1');
    await api.readData('doc_1');
    await api.versions('doc_1');
    await api.version('doc_1', 'v1');
    await api.save('doc_1', { html: '<h1>Hi</h1>', etag: 'E1' });
    await api.writeData('doc_1', { data: { visits: 2 }, etag: 'D1' });
    await api.restore('doc_1', 'v1', { etag: 'E2' });

    assert.equal(server.state.requests.length, 8);
    for (const seen of server.state.requests) {
      assert.equal(seen.headers.authorization, `Bearer ${KEY}`);
      assert.equal(seen.headers.cookie, undefined);
      assert.ok(!seen.url.includes(KEY));
      assert.ok(!seen.url.includes('hcak_'));
    }
  });
});

test('read returns the document, and 304 when the etag is unchanged', async () => {
  await withServer(async (server) => {
    const api = client(server);

    const doc = await api.read('doc_1');
    assert.equal(doc.id, 'doc_1');
    assert.equal(doc.html, '<h1>Hi</h1>');
    assert.equal(doc.etag, 'E1');

    const unchanged = await api.read('doc_1', { ifNoneMatch: 'E1' });
    assert.equal(unchanged.notModified, true);
    assert.equal(unchanged.etag, 'E1');
    assert.equal(server.state.requests[1].headers['if-none-match'], 'E1');
  });
});

test('save sends If-Match and a fresh operationId each time', async () => {
  await withServer(async (server) => {
    const api = client(server);

    const first = await api.save('doc_1', { html: '<h1>One</h1>', etag: 'E1' });
    assert.equal(first.etag, 'E2');

    const [one, two] = server.state.requests;
    assert.equal(one.method, 'PUT');
    assert.equal(one.headers['if-match'], 'E1');
    assert.equal(one.headers['content-type'], 'application/json');
    const firstBody = JSON.parse(one.body);
    assert.equal(firstBody.html, '<h1>One</h1>');
    assert.match(firstBody.operationId, UUID_PATTERN);

    await api.save('doc_1', { html: '<h1>Two</h1>', etag: 'E2' });
    const secondBody = JSON.parse(server.state.requests[1].body);
    assert.match(secondBody.operationId, UUID_PATTERN);
    assert.notEqual(secondBody.operationId, firstBody.operationId);
  });
});

test('a 503 recovery-unavailable is retryable and carries its hint', async () => {
  await withServer(async (server) => {
    server.answer(503, {
      error: { code: 'recovery-unavailable', message: 'The current version could not be stored, so nothing was written.' },
    });

    await assert.rejects(client(server).save('doc_1', { html: '<h1>X</h1>', etag: 'E1' }), (error) => {
      assert.ok(error instanceof ClayError);
      assert.equal(error.code, 'recovery-unavailable');
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      assert.equal(error.hint, 'Nothing was written. Send the same change again in a moment.');
      return true;
    });
  });
});

test('a 400 operation-reused is not retryable and carries its hint', async () => {
  await withServer(async (server) => {
    server.answer(400, {
      error: { code: 'operation-reused', message: 'That operation id was used for another change.' },
    });

    await assert.rejects(client(server).save('doc_1', { html: '<h1>X</h1>', etag: 'E1' }), (error) => {
      assert.ok(error instanceof ClayError);
      assert.equal(error.code, 'operation-reused');
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      assert.equal(error.hint, 'Send each new change with a new operation id.');
      return true;
    });
  });
});

test('save, writeData and restore send the operationId they are given', async () => {
  await withServer(async (server) => {
    const api = client(server);
    await api.save('doc_1', {
      html: '<h1>One</h1>', etag: 'E1', operationId: '11111111-1111-4111-8111-111111111111',
    });
    await api.writeData('doc_1', {
      data: { visits: 2 }, etag: 'D1', operationId: '22222222-2222-4222-8222-222222222222',
    });
    await api.restore('doc_1', 'v1', { etag: 'E2', operationId: '33333333-3333-4333-8333-333333333333' });

    assert.deepEqual(server.state.requests.map((seen) => JSON.parse(seen.body).operationId), [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]);

    server.state.requests.length = 0;
    await api.save('doc_1', { html: '<h1>Two</h1>', etag: 'E3' });
    await api.writeData('doc_1', { data: { visits: 3 }, etag: 'D2' });
    await api.restore('doc_1', 'v1', { etag: 'E3' });

    const fresh = server.state.requests.map((seen) => JSON.parse(seen.body).operationId);
    for (const id of fresh) assert.match(id, UUID_PATTERN);
    assert.equal(new Set(fresh).size, 3);
  });
});

test('one operation id answers the first save again and refuses other html', async () => {
  await withServer(async (server) => {
    const api = client(server);
    const operationId = '44444444-4444-4444-8444-444444444444';

    const first = await api.save('doc_1', { html: '<h1>One</h1>', etag: 'E1', operationId });
    const second = await api.save('doc_1', { html: '<h1>One</h1>', etag: 'E1', operationId });

    assert.deepEqual(first, { etag: 'E2', changed: true, operationId, undoVersionId: 'v2' });
    assert.deepEqual(second, first);
    assert.equal(server.state.requests.length, 2);
    assert.equal(server.state.document.html, '<h1>One</h1>');
    assert.equal(server.state.document.etag, 'E2');

    await assert.rejects(api.save('doc_1', { html: '<h1>Two</h1>', etag: 'E2', operationId }), (error) => {
      assert.equal(error.code, 'operation-reused');
      assert.equal(error.status, 400);
      return true;
    });
    assert.equal(server.state.document.html, '<h1>One</h1>');

    server.state.requests.length = 0;
    const dataId = '55555555-5555-4555-8555-555555555555';
    const written = await api.writeData('doc_1', { data: { visits: 5 }, etag: 'D1', operationId: dataId });
    const repeated = await api.writeData('doc_1', { data: { visits: 5 }, etag: 'D1', operationId: dataId });

    assert.deepEqual(written, { etag: 'D2', changed: true, operationId: dataId, undoVersionId: 'v2' });
    assert.deepEqual(repeated, written);
    assert.equal(server.state.requests.length, 2);
    assert.deepEqual(server.state.data, { visits: 5 });
  });
});

test('save without an etag throws read-first and sends nothing', async () => {
  await withServer(async (server) => {
    const api = client(server);

    await assert.rejects(api.save('doc_1', { html: '<h1>Hi</h1>' }), (error) => {
      assert.ok(error instanceof ClayError);
      assert.equal(error.code, 'read-first');
      return true;
    });
    assert.equal(server.state.requests.length, 0);
  });
});

test('a 412 conflict becomes a ClayError with the etag, changedBy and the conflict hint', async () => {
  await withServer(async (server) => {
    server.answer(412, {
      error: { code: 'conflict', message: 'The document changed after you read it.', etag: 'E2', changedBy: { name: 'Ann' } },
    });

    await assert.rejects(client(server).save('doc_1', { html: '<h1>X</h1>', etag: 'E1' }), (error) => {
      assert.ok(error instanceof ClayError);
      assert.equal(error.code, 'conflict');
      assert.equal(error.status, 412);
      assert.equal(error.etag, 'E2');
      assert.deepEqual(error.details.changedBy, { name: 'Ann' });
      assert.equal(error.hint, 'The file changed after you read it. Read it again and redo the change.');
      return true;
    });
  });
});

test('a 429 carries retryAfter from the Retry-After header and is retryable', async () => {
  await withServer(async (server) => {
    server.answer(429, { error: { code: 'rate-limited', message: 'Slow down.' } }, { headers: { 'retry-after': '7' } });

    await assert.rejects(client(server).list({ account: 'acct_1' }), (error) => {
      assert.equal(error.code, 'rate-limited');
      assert.equal(error.retryable, true);
      assert.equal(error.details.retryAfter, 7);
      return true;
    });
  });
});

test('a 404 with an HTML body becomes not-found', async () => {
  await withServer(async (server) => {
    server.answer(404, '<!doctype html><h1>Not found</h1>', { contentType: 'text/html' });

    await assert.rejects(client(server).list({}), (error) => {
      assert.equal(error.code, 'not-found');
      assert.equal(error.message, 'This host does not have agent keys turned on.');
      return true;
    });
  });
});

test('a write whose connection dies after the body is outcome-unknown, and a closed port is host-unavailable', async () => {
  await withServer(async (server) => {
    server.state.next = { destroy: true };

    await assert.rejects(client(server).save('doc_1', { html: '<h1>X</h1>', etag: 'E1' }), (error) => {
      assert.equal(error.code, 'outcome-unknown');
      assert.equal(error.message, 'The change may or may not have been saved.');
      return true;
    });
    assert.equal(server.state.requests.length, 1);
  });

  const dead = await startServer();
  const base = dead.base;
  await dead.close();

  await assert.rejects(hyperclayClient({ base, getKey: async () => KEY }).read('doc_1'), (error) => {
    assert.equal(error.code, 'host-unavailable');
    return true;
  });
});

test('a server message containing a key comes back redacted', async () => {
  await withServer(async (server) => {
    server.answer(500, { error: { code: 'internal', message: `Server blew up for ${KEY} just now.` } });

    await assert.rejects(client(server).list({}), (error) => {
      assert.ok(!error.message.includes(KEY));
      assert.ok(!error.hint?.includes(KEY));
      assert.ok(error.message.includes(KEY.slice(0, 13)));
      return true;
    });
  });
});

test('list sends url as a query parameter, encoded', async () => {
  await withServer(async (server) => {
    const wanted = 'https://hyperclay.com/d/doc 1?x=<y>';

    const result = await client(server).list({ url: wanted });
    assert.equal(result.documents.length, 1);

    const seen = server.state.requests[0];
    assert.ok(!seen.url.includes(wanted));
    assert.equal(new URL(seen.url, 'http://localhost').searchParams.get('url'), wanted);
  });
});

test('no key is key-missing per request and sends nothing', async () => {
  await withServer(async (server) => {
    const api = hyperclayClient({ base: server.base });

    await assert.rejects(api.read('doc_1'), (error) => {
      assert.equal(error.code, 'key-missing');
      assert.equal(error.message, 'Not signed in to hyperclay.com.');
      assert.match(error.hint, /Agent keys/);
      return true;
    });
    assert.equal(server.state.requests.length, 0);
  });
});

test('a write answered 200 with an unreadable body is outcome-unknown, a read is host-error', async () => {
  await withServer(async (server) => {
    server.answer(200, 'not json', { contentType: 'text/plain' });
    await assert.rejects(client(server).save('1', { html: '<html></html>', etag: 'E1' }), (error) => {
      assert.equal(error.code, 'outcome-unknown');
      return true;
    });

    server.answer(200, 'not json', { contentType: 'text/plain' });
    await assert.rejects(client(server).read('1'), (error) => {
      assert.equal(error.code, 'host-error');
      return true;
    });
  });
});

test('a write answered by an HTML 502 or by a JSON body without an etag is outcome-unknown', async () => {
  await withServer(async (server) => {
    server.answer(502, '<!doctype html><h1>Bad gateway</h1>', { contentType: 'text/html' });
    await assert.rejects(client(server).save('doc_1', { html: '<h1>X</h1>', etag: 'E1' }), (error) => {
      assert.equal(error.code, 'outcome-unknown');
      return true;
    });

    server.answer(200, {});
    await assert.rejects(client(server).save('doc_1', { html: '<h1>X</h1>', etag: 'E1' }), (error) => {
      assert.equal(error.code, 'outcome-unknown');
      return true;
    });
  });
});

test('claimSubdomain returns a 200 answer with no etag as is and sends no If-Match', async () => {
  await withServer(async (server) => {
    server.answer(200, {
      subdomain: 'my-tool',
      url: 'https://my-tool.hyperclay.com',
      changed: true,
      warnings: [],
    });

    const result = await client(server).claimSubdomain('doc_1', 'my-tool');

    assert.deepEqual(result, {
      subdomain: 'my-tool',
      url: 'https://my-tool.hyperclay.com',
      changed: true,
      warnings: [],
    });
    const seen = server.state.requests.at(-1);
    assert.equal(seen.method, 'POST');
    assert.equal(new URL(seen.url, 'http://localhost').pathname, '/_/agent/v1/documents/doc_1/subdomain');
    assert.deepEqual(JSON.parse(seen.body), { subdomain: 'my-tool' });
    assert.equal(seen.headers['if-match'], undefined);
  });
});

test('claimSiteSubdomain posts to the site route with no If-Match and treats an answer without a subdomain as unknown', async () => {
  await withServer(async (server) => {
    server.answer(200, { subdomain: 'maya', url: 'https://maya.hyperclay.com', changed: true, warnings: [] });
    const result = await client(server).claimSiteSubdomain('42', 'maya');
    assert.equal(result.subdomain, 'maya');
    const seen = server.state.requests.at(-1);
    assert.equal(seen.method, 'POST');
    assert.equal(new URL(seen.url, 'http://localhost').pathname, '/_/agent/v1/sites/42/subdomain');
    assert.deepEqual(JSON.parse(seen.body), { subdomain: 'maya' });
    assert.equal(seen.headers['if-match'], undefined);

    server.answer(200, { changed: true });
    await assert.rejects(client(server).claimSiteSubdomain('42', 'maya'), (error) => error.code === 'outcome-unknown');
  });
});

test('features asks whoami once per client and answers an empty list when the server sends none', async () => {
  await withServer(async (server) => {
    server.answer(200, { account: { id: 'acct_1' } });
    const api = client(server);

    const first = await api.features();
    const second = await api.features();

    assert.deepEqual(first, []);
    assert.deepEqual(second, []);
    assert.equal(server.state.requests.length, 1);
    assert.equal(new URL(server.state.requests[0].url, 'http://localhost').pathname, '/_/agent/v1/whoami');
  });
});

test('listSites sends path and no account when only a path is given', async () => {
  await withServer(async (server) => {
    server.answer(200, { sites: [], nextCursor: null });

    const result = await client(server).listSites({ path: 'demos/maya' });
    assert.deepEqual(result, { sites: [], nextCursor: null });

    const seen = server.state.requests.at(-1);
    assert.equal(seen.method, 'GET');
    const url = new URL(seen.url, 'http://localhost');
    assert.equal(url.pathname, '/_/agent/v1/sites');
    assert.equal(url.searchParams.get('path'), 'demos/maya');
    assert.ok(url.search.includes('path=demos%2Fmaya'));
    assert.equal(url.searchParams.get('account'), null);
  });
});

test('listFiles sends both path and cursor', async () => {
  await withServer(async (server) => {
    server.answer(200, { files: [], nextCursor: null });

    await client(server).listFiles({ path: 'demos/maya', cursor: '9' });

    const seen = server.state.requests.at(-1);
    const url = new URL(seen.url, 'http://localhost');
    assert.equal(url.pathname, '/_/agent/v1/files');
    assert.equal(url.searchParams.get('path'), 'demos/maya');
    assert.equal(url.searchParams.get('cursor'), '9');
    assert.ok(url.search.includes('path=demos%2Fmaya'));
    assert.ok(url.search.includes('cursor=9'));
  });
});

test('putFile sends raw bytes with If-None-Match: * to create and If-Match to replace', async () => {
  await withServer(async (server) => {
    const bytes = Buffer.from([0, 255, 1, 254]);
    server.answer(201, { id: 9, path: 'demos/maya/a.bin', kind: 'file', etag: 'E1', changed: true, created: true, folders: [] });
    await client(server).putFile('demos/maya/a.bin', bytes, { create: true });
    let seen = server.state.requests.at(-1);
    assert.equal(seen.method, 'PUT');
    const url = new URL(seen.url, 'http://localhost');
    assert.equal(url.pathname, '/_/agent/v1/files');
    assert.equal(url.searchParams.get('path'), 'demos/maya/a.bin');
    assert.equal(seen.headers['if-none-match'], '*');
    assert.equal(seen.headers['if-match'], undefined);
    assert.equal(seen.headers['content-type'], 'application/octet-stream');
    assert.match(seen.headers['x-operation-id'], UUID_PATTERN);
    assert.equal(Buffer.compare(seen.raw, bytes), 0);

    server.answer(200, { id: 9, path: 'demos/maya/a.bin', kind: 'file', etag: 'E2', changed: true, created: false, folders: [] });
    await client(server).putFile('demos/maya/a.bin', bytes, { etag: 'E1' });
    seen = server.state.requests.at(-1);
    assert.equal(seen.headers['if-match'], 'E1');
    assert.equal(seen.headers['if-none-match'], undefined);

    await assert.rejects(client(server).putFile('demos/maya/a.bin', bytes, {}), (error) => error.code === 'read-first');
  });
});

test('listAllFiles follows nextCursor across pages and answers [] for a missing folder', async () => {
  await withServer(async (server) => {
    const adapter = hyperclayAdapter(client(server));

    const files = await adapter.listAllFiles({ path: 'demos/maya' });
    assert.deepEqual(files.map((file) => file.id), [1, 2]);
    const seen = server.state.requests.map((request) => {
      const url = new URL(request.url, 'http://localhost');
      return `${url.pathname} ${url.searchParams.get('cursor')}`;
    });
    assert.deepEqual(seen, [
      '/_/agent/v1/whoami null',
      '/_/agent/v1/files null',
      '/_/agent/v1/files p2',
    ]);

    server.state.requests.length = 0;
    assert.deepEqual(await adapter.listAllFiles({ path: 'demos/missing' }), []);
    assert.equal(new URL(server.state.requests.at(-1).url, 'http://localhost').pathname, '/_/agent/v1/files');
  });
});

test('addDomain posts domain and alsoWww to the site route, and an answer without domain.domain is unknown', async () => {
  await withServer(async (server) => {
    server.answer(200, { domain: { domain: 'maya.example' }, changed: true, warnings: [] });
    const result = await client(server).addDomain('sites', '42', { domain: 'maya.example' });
    assert.equal(result.domain.domain, 'maya.example');

    const seen = server.state.requests.at(-1);
    assert.equal(seen.method, 'POST');
    assert.equal(new URL(seen.url, 'http://localhost').pathname, '/_/agent/v1/sites/42/domains');
    assert.deepEqual(JSON.parse(seen.body), { domain: 'maya.example', alsoWww: false });
    assert.equal(seen.headers['if-match'], undefined);

    server.answer(200, { changed: true });
    await assert.rejects(client(server).addDomain('sites', '42', { domain: 'maya.example' }),
      (error) => error.code === 'outcome-unknown');
  });
});

test('domainStatus reads the domains route of a document', async () => {
  await withServer(async (server) => {
    server.answer(200, { domains: [] });

    const result = await client(server).domainStatus('documents', '7');
    assert.deepEqual(result, { domains: [] });

    const seen = server.state.requests.at(-1);
    assert.equal(seen.method, 'GET');
    assert.equal(new URL(seen.url, 'http://localhost').pathname, '/_/agent/v1/documents/7/domains');
  });
});

test('a refused not-a-site-folder becomes its code with the new hint', async () => {
  await withServer(async (server) => {
    server.answer(409, { error: { code: 'not-a-site-folder', message: 'This folder has no site.json.' } });

    await assert.rejects(client(server).claimSiteSubdomain('42', 'maya'), (error) => {
      assert.ok(error instanceof ClayError);
      assert.equal(error.code, 'not-a-site-folder');
      assert.equal(error.hint, 'A site folder holds its own site.json file. Add one to the folder, then try again.');
      assert.equal(error.status, 409);
      return true;
    });
  });
});

test('a refused subdomain becomes its code with a hint', async () => {
  await withServer(async (server) => {
    server.answer(409, { error: { code: 'subdomain-already-set', message: 'This document already has a subdomain.' } });

    await assert.rejects(client(server).claimSubdomain('doc_1', 'my-tool'), (error) => {
      assert.ok(error instanceof ClayError);
      assert.equal(error.code, 'subdomain-already-set');
      assert.equal(error.hint, 'Change a subdomain in the dashboard.');
      assert.equal(error.status, 409);
      return true;
    });
  });
});

test('locate takes only the document whose URL matches', async () => {
  const listed = [
    { id: '7', url: 'https://hyperclay.com/d/budget.html' },
    { id: '9', url: 'https://hyperclay.com/d/notes' },
  ];
  const adapter = hyperclayAdapter({
    async list() {
      return { documents: listed, nextCursor: null };
    },
  });

  const exact = await adapter.locate({ url: 'https://hyperclay.com/d/notes' });
  assert.equal(exact.id, '9');
  assert.equal(exact.ref, 'hyperclay:9');

  const withHtml = await adapter.locate({ url: 'https://hyperclay.com/d/budget' });
  assert.equal(withHtml.id, '7');

  const withSlash = await adapter.locate({ url: 'https://hyperclay.com/d/notes/' });
  assert.equal(withSlash.id, '9');

  await assert.rejects(adapter.locate({ url: 'https://hyperclay.com/d/missing.html' }), (error) => {
    assert.equal(error.code, 'not-found');
    return true;
  });
});

test('a host that never answers is host-unavailable on a read and outcome-unknown on a write', async () => {
  const silent = http.createServer(() => {});
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${silent.address().port}`;
  const api = hyperclayClient({ base, getKey: async () => KEY, timeoutMs: 100 });

  try {
    await assert.rejects(api.read('doc_1'), (error) => {
      assert.ok(error instanceof ClayError);
      assert.equal(error.code, 'host-unavailable');
      return true;
    });

    await assert.rejects(api.save('doc_1', { html: '<h1>X</h1>', etag: 'E1' }), (error) => {
      assert.equal(error.code, 'outcome-unknown');
      return true;
    });

    await assert.rejects(api.claimSubdomain('doc_1', 'my-tool'), (error) => {
      assert.equal(error.code, 'outcome-unknown');
      return true;
    });
  } finally {
    silent.closeAllConnections();
    await new Promise((resolve) => silent.close(resolve));
  }
});

test('a site path is found once through /sites and claimed through the site route', async () => {
  await withServer(async (server) => {
    const adapter = hyperclayAdapter(client(server));

    const located = await adapter.locateSite({ site: 'demos/maya' });
    const again = await adapter.locateSite({ site: '/demos/maya/' });
    const claimed = await adapter.claimSiteSubdomain(located.id, 'maya');

    assert.deepEqual(located, { id: '42', ref: 'hyperclay:42' });
    assert.deepEqual(again, located);
    assert.equal(claimed.subdomain, 'maya');
    const paths = server.state.requests.map((seen) => `${seen.method} ${new URL(seen.url, 'http://localhost').pathname}`);
    assert.deepEqual(paths, [
      'GET /_/agent/v1/whoami',
      'GET /_/agent/v1/sites',
      'POST /_/agent/v1/sites/42/subdomain',
    ]);
  });
});

test('a server without the feature is refused before any write', async () => {
  await withServer(async (server) => {
    server.state.features = [];
    const adapter = hyperclayAdapter(client(server));

    await assert.rejects(adapter.claimSiteSubdomain('42', 'maya'), (error) => error.code === 'not-supported');
    assert.ok(!server.state.requests.some((seen) => seen.method === 'POST'));
  });
});

test('an unknown site path is not-found with the list_sites hint', async () => {
  await withServer(async (server) => {
    const adapter = hyperclayAdapter(client(server));

    await assert.rejects(adapter.locateSite({ site: 'demos/other' }), (error) => {
      assert.equal(error.code, 'not-found');
      assert.match(error.hint, /list_sites/);
      return true;
    });
  });
});

test('a folder id makes no /sites request', async () => {
  await withServer(async (server) => {
    const adapter = hyperclayAdapter(client(server));

    assert.deepEqual(await adapter.locateSite({ site: 'hyperclay:42' }), { id: '42', ref: 'hyperclay:42' });
    assert.deepEqual(server.state.requests, []);
  });
});
