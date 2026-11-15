import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { htmlClayAdapter, htmlClayClient, htmlClayDocumentId } from '../src/hosts/htmlclay.js';

const TOKEN = 'a'.repeat(64);

// The lane admits a request for 127.0.0.1 on its port that carries none of the
// headers a browser sends, and answers 403 to any other.
const BROWSER_HEADERS = ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'cookie'];

const HOME_HTML = '<!doctype html><h1>Home</h1>';
const OLD_HTML = '<h1>Old</h1>';

function document(file) {
  return {
    id: htmlClayDocumentId(file),
    path: path.basename(file),
    url: `http://127.0.0.1:4321/${path.basename(file)}`,
    folder: null,
    kind: 'file',
    open: true,
    etag: 'E1',
    html: HOME_HTML,
  };
}

async function startServer({ doc = document('/home/me/index.html'), truncated = false } = {}) {
  const state = {
    requests: [],
    next: null,
    document: doc,
    truncated,
    data: { visits: 1 },
    dataEtag: 'D1',
    versions: [
      { id: 'v1', createdAt: '2024-01-01T00:00:00.000Z', size: 11, kind: 'edit', pinned: false, restorable: true },
    ],
    replays: new Map(),
    writes: 0,
    dataWrites: 0,
    lastSaveId: null,
  };

  function json(response, status, body, headers = {}) {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  }

  function writeOnce(request, response, body, mode, kind) {
    const ifMatch = request.headers['if-match'];
    if (!ifMatch) {
      return json(response, 428, { error: { code: 'precondition-required', message: 'x' } });
    }

    const operationId = body?.operationId;
    const replay = state.replays.get(operationId);
    if (replay) {
      return json(response, replay.status, replay.body);
    }

    const current = kind === 'data' ? state.dataEtag : state.document.etag;
    if (ifMatch !== current) {
      return json(response, 412, {
        error: { code: 'conflict', message: 'x', etag: current, saveId: state.lastSaveId },
      });
    }

    if (kind === 'data') state.dataWrites += 1;
    else state.writes += 1;
    const n = kind === 'data' ? state.dataWrites : state.writes;
    const etag = `${kind === 'data' ? 'D' : 'E'}${n + 1}`;
    state.lastSaveId = operationId;

    if (kind === 'data') {
      state.data = body?.data;
      state.dataEtag = etag;
    } else {
      state.document.html = kind === 'restore' ? OLD_HTML : body?.html;
      state.document.etag = etag;
    }

    const answer = { etag, changed: true, operationId, undoVersionId: 'v-undo' };
    state.replays.set(operationId, { status: 200, body: answer });

    if (mode === 'destroy') {
      request.socket.destroy();
      return undefined;
    }
    return json(response, 200, answer);
  }

  function route(request, response, body, mode) {
    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const tail = parts.slice(3);
    const doc = state.document;

    if (request.method === 'GET' && tail.length === 1 && tail[0] === 'whoami') {
      return json(response, 200, { host: 'htmlclay', version: '1.0.0', capabilities: ['documents', 'data'] });
    }

    if (request.method === 'GET' && tail.length === 1 && tail[0] === 'documents') {
      return json(response, 200, {
        documents: [{ id: doc.id, path: doc.path, url: doc.url, folder: doc.folder, kind: doc.kind, open: doc.open }],
        truncated: state.truncated,
      });
    }

    if (request.method === 'GET' && tail.length === 2 && tail[0] === 'documents') {
      if (request.headers['if-none-match'] === doc.etag) {
        response.writeHead(304, { etag: doc.etag });
        return response.end();
      }
      return json(response, 200, { id: doc.id, path: doc.path, url: doc.url, etag: doc.etag, html: doc.html });
    }

    if (request.method === 'GET' && tail.length === 3 && tail[0] === 'documents' && tail[2] === 'data') {
      return json(response, 200, { data: state.data, etag: state.dataEtag });
    }

    if (request.method === 'GET' && tail.length === 3 && tail[0] === 'documents' && tail[2] === 'versions') {
      return json(response, 200, { versions: state.versions, nextBefore: null });
    }

    if (request.method === 'GET' && tail.length === 4 && tail[0] === 'documents' && tail[2] === 'versions') {
      return json(response, 200, { id: tail[3], createdAt: '2024-01-01T00:00:00.000Z', html: OLD_HTML });
    }

    if (request.method === 'PUT' && tail.length === 2 && tail[0] === 'documents') {
      return writeOnce(request, response, body, mode, 'save');
    }

    if (request.method === 'POST' && tail.length === 3 && tail[0] === 'documents' && tail[2] === 'data') {
      return writeOnce(request, response, body, mode, 'data');
    }

    if (request.method === 'POST' && tail.length === 5 && tail[0] === 'documents' && tail[2] === 'versions' && tail[4] === 'restore') {
      return writeOnce(request, response, body, mode, 'restore');
    }

    return json(response, 404, { error: { code: 'not-found', message: 'No route.' } });
  }

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      if (request.headers.host !== `127.0.0.1:${request.socket.localPort}` || BROWSER_HEADERS.some((name) => name in request.headers)) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'forbidden', message: 'Not a program on this machine.' } }));
        return;
      }
      const next = state.next;
      state.next = null;
      if (next && !next.applyThenDestroy) {
        response.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers ?? {}) });
        response.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? ''));
        return;
      }
      route(request, response, body ? JSON.parse(body) : null, next?.applyThenDestroy ? 'destroy' : null);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    state,
    answer(status, body, options = {}) {
      state.next = { status, body: typeof body === 'string' ? body : JSON.stringify(body), ...options };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withServer(options, fn) {
  const server = await startServer(options);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function client(server, token = null) {
  return htmlClayClient({ port: server.port, token });
}

function operationIds(server) {
  return server.state.requests.map((request) => JSON.parse(request.body).operationId);
}

test('a save sends If-Match and an operation id and answers the new etag', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');

    const answer = await adapter.save(id, { html: '<h1>New</h1>', etag: 'E1' });
    assert.equal(answer.etag, 'E2');
    assert.equal(answer.changed, true);
    assert.equal(answer.undoVersionId, 'v-undo');
    assert.equal(typeof answer.operationId, 'string');

    const request = server.state.requests.at(-1);
    assert.equal(request.headers['if-match'], 'E1');
    assert.equal(JSON.parse(request.body).operationId, answer.operationId);
  });
});

test('a retried save is written once', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');

    server.state.next = { applyThenDestroy: true };
    await assert.rejects(adapter.save(id, { html: '<h1>New</h1>', etag: 'E1' }), { code: 'outcome-unknown' });

    const answer = await adapter.save(id, { html: '<h1>New</h1>', etag: 'E1' });
    assert.equal(answer.etag, 'E2');
    assert.equal(server.state.writes, 1);

    const ids = operationIds(server);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
  });
});

test('a different change gets a new operation id', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');

    const first = await adapter.save(id, { html: '<h1>A</h1>', etag: 'E1' });
    const second = await adapter.save(id, { html: '<h1>B</h1>', etag: first.etag });
    assert.notEqual(first.operationId, second.operationId);

    server.state.next = { applyThenDestroy: true };
    await assert.rejects(adapter.save(id, { html: '<h1>C</h1>', etag: second.etag }), { code: 'outcome-unknown' });
    const lost = operationIds(server).at(-1);

    const other = await adapter.save(id, { html: '<h1>D</h1>', etag: server.state.document.etag });
    assert.notEqual(other.operationId, lost);
  });
});

test('a 412 naming our own operation id counts as applied', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');

    server.state.next = { applyThenDestroy: true };
    await assert.rejects(adapter.save(id, { html: 'A', etag: 'E1' }), { code: 'outcome-unknown' });
    const firstId = operationIds(server).at(-1);

    server.state.replays.clear();

    const answer = await adapter.save(id, { html: 'A', etag: 'E1' });
    assert.deepEqual(answer, { etag: 'E2', changed: true, operationId: firstId, undoVersionId: null });
    assert.equal(server.state.writes, 1);
  });
});

test('a 412 naming another id is a conflict', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');

    server.state.document.etag = 'E9';
    server.state.lastSaveId = 'someone-else';

    await assert.rejects(adapter.save(id, { html: 'A', etag: 'E1' }), { code: 'conflict', etag: 'E9' });
    assert.equal(server.state.writes, 0);
  });
});

test('a conflict and a 428 are never retried on their own', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');

    server.state.document.etag = 'E9';
    server.state.lastSaveId = 'someone-else';
    await assert.rejects(adapter.save(id, { html: 'A', etag: 'E1' }), { code: 'conflict' });
    assert.equal(server.state.requests.length, 1);

    server.state.next = { status: 428, body: { error: { code: 'precondition-required', message: 'x' } } };
    await assert.rejects(adapter.save(id, { html: '<h1>New</h1>', etag: 'E1' }), {
      code: 'precondition-required',
    });
    assert.equal(server.state.requests.length, 2);
    assert.equal(server.state.writes, 0);
  });
});

test('wouldRemove reaches the caller unchanged', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');

    server.state.next = {
      status: 428,
      body: {
        error: {
          code: 'read-required',
          message: 'x',
          etag: 'D1',
          wouldRemove: { items: [{ id: 'a' }, { id: 'b' }] },
        },
      },
    };

    await assert.rejects(adapter.writeData(id, { data: { items: [] }, etag: 'D1' }), (error) => {
      assert.equal(error.code, 'read-required');
      assert.equal(error.etag, 'D1');
      assert.deepEqual(error.details.wouldRemove, { items: [{ id: 'a' }, { id: 'b' }] });
      assert.equal(typeof error.hint, 'string');
      assert.ok(error.hint.length > 0);
      assert.match(error.hint, /read/i);
      return true;
    });
    assert.equal(server.state.dataWrites, 0);
  });
});

test('restore and data writes use the same operation id rules', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');

    const restored = await adapter.restore(id, 'v1', { etag: 'E1' });
    assert.equal(restored.etag, 'E2');

    const data = await adapter.writeData(id, { data: { x: 1 }, etag: 'D1' });
    assert.equal(data.etag, 'D2');

    server.state.next = { applyThenDestroy: true };
    await assert.rejects(adapter.writeData(id, { data: { x: 2 }, etag: 'D2' }), { code: 'outcome-unknown' });
    const retried = await adapter.writeData(id, { data: { x: 2 }, etag: 'D2' });
    assert.equal(retried.etag, 'D3');

    assert.equal(server.state.dataWrites, 2);
    const dataIds = server.state.requests
      .filter((request) => request.url.endsWith('/data'))
      .map((request) => JSON.parse(request.body).operationId);
    assert.equal(dataIds.length, 3);
    assert.equal(dataIds[1], dataIds[2]);
  });
});

test('refusals carry the lane hints', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');

    const refusals = [
      [404, { code: 'not-reachable', message: 'x' }],
      [503, { code: 'recovery-unavailable', message: 'x' }],
      [409, { code: 'operation-reused', message: 'x' }],
      [401, { code: 'unauthorized', message: 'x' }],
    ];

    for (const [status, error] of refusals) {
      server.answer(status, { error });
      await assert.rejects(adapter.save(id, { html: '<h1>New</h1>', etag: 'E1' }), (thrown) => {
        assert.equal(thrown.code, error.code);
        assert.equal(typeof thrown.hint, 'string');
        assert.ok(thrown.hint.length > 0);
        if (error.code === 'unauthorized') {
          assert.match(thrown.hint, /token/i);
          assert.doesNotMatch(thrown.hint, /hyperclay\.com/i);
          assert.doesNotMatch(thrown.hint, /key/i);
        }
        return true;
      });
    }
  });
});

test('a 503 recovery-unavailable forgets the operation id', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');

    server.answer(503, { error: { code: 'recovery-unavailable', message: 'x' } });
    await assert.rejects(adapter.save(id, { html: '<h1>New</h1>', etag: 'E1' }), {
      code: 'recovery-unavailable',
    });

    const answer = await adapter.save(id, { html: '<h1>New</h1>', etag: 'E1' });
    assert.equal(answer.etag, 'E2');

    const ids = operationIds(server);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
    assert.equal(server.state.writes, 1);
  });
});
