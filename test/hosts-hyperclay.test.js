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
    data: { visits: 1 },
    dataEtag: 'D1',
    versions: [
      { id: 'v1', createdAt: '2024-01-01T00:00:00.000Z', recordedBy: { name: 'Ann' }, kind: 'edit' },
    ],
  };

  function json(response, status, body, headers = {}) {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  }

  function refusal(response, status, code, message, extra = {}, headers = {}) {
    json(response, status, { error: { code, message, ...extra } }, headers);
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
      if (request.headers['if-match'] !== doc.etag) {
        return refusal(response, 412, 'conflict', 'The document changed.', {
          etag: doc.etag,
          changedBy: { name: 'Ann' },
        });
      }
      doc.html = parsed.html;
      doc.etag = 'E2';
      return json(response, 200, { etag: doc.etag, changed: true, undoVersionId: 'v2' });
    }

    if (request.method === 'GET' && tail.length === 3 && tail[0] === 'documents' && tail[2] === 'data') {
      return json(response, 200, { data: state.data, etag: state.dataEtag });
    }

    if (request.method === 'POST' && tail.length === 3 && tail[0] === 'documents' && tail[2] === 'data') {
      const parsed = JSON.parse(body || '{}');
      if (request.headers['if-match'] !== state.dataEtag) {
        return refusal(response, 412, 'conflict', 'The data changed.', { etag: state.dataEtag });
      }
      state.data = parsed.data;
      state.dataEtag = 'D2';
      return json(response, 200, { data: state.data, etag: state.dataEtag, changed: true });
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

    return refusal(response, 404, 'not-found', 'No route.');
  }

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: request.method, url: request.url, headers: request.headers, body });
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
      assert.equal(error.hint, 'The document changed after you read it. Read it again and redo the change.');
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
  } finally {
    silent.closeAllConnections();
    await new Promise((resolve) => silent.close(resolve));
  }
});
