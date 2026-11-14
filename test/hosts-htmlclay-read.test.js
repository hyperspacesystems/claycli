import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { htmlClayAdapter, htmlClayClient, htmlClayDocumentId } from '../src/hosts/htmlclay.js';
import { buildActions } from '../src/runtime.js';
import { resolveTarget } from '../src/target.js';

const TOKEN = 'a'.repeat(64);

const HOME_HTML = '<!doctype html><h1>Home</h1>';

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
  };

  function json(response, status, body, headers = {}) {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  }

  function route(request, response) {
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
      return json(response, 200, { id: tail[3], createdAt: '2024-01-01T00:00:00.000Z', html: '<h1>Old</h1>' });
    }

    return json(response, 404, { error: { code: 'not-found', message: 'No route.' } });
  }

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      state.requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const next = state.next;
      state.next = null;
      if (next) {
        response.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers ?? {}) });
        response.end(next.body ?? '');
        return;
      }
      route(request, response);
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

async function tempHome(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-htmlclay-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function writeHTMLClayConfig(home, port) {
  const dir = path.join(home, 'Library', 'Application Support', 'htmlclay');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ port }), 'utf8');
}

test('reads a document through the lane, sending the token when there is one', async () => {
  await withServer({}, async (server) => {
    const id = htmlClayDocumentId('/home/me/index.html');
    const read = await client(server, TOKEN).read(id);
    assert.equal(read.html, HOME_HTML);
    assert.equal(read.etag, 'E1');
    assert.equal(server.state.requests[0].headers.authorization, `Bearer ${TOKEN}`);

    const anonymous = await client(server, null).read(id);
    assert.equal(anonymous.html, HOME_HTML);
    assert.equal(server.state.requests[1].headers.authorization, undefined);
  });
});

test('lists documents with their path as the ref', async () => {
  const file = '/home/me/notes/a.html';
  const doc = { ...document(file), path: 'notes/a.html', url: 'http://notes.htmlclay.localhost:4321/a' };
  await withServer({ doc, truncated: true }, async (server) => {
    const listed = await htmlClayAdapter(client(server)).list();
    assert.deepEqual(listed.documents, [
      {
        ref: 'notes/a.html',
        host: 'htmlclay',
        name: 'a.html',
        url: 'http://notes.htmlclay.localhost:4321/a',
        path: 'notes/a.html',
        folder: null,
        kind: 'file',
        open: true,
      },
    ]);
    assert.equal(listed.nextCursor, null);
    assert.equal(listed.truncated, true);
  });
});

test('versions and one version read through the lane', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');

    const versions = await adapter.versions(id);
    assert.equal(versions.versions.length, 1);
    assert.equal(versions.versions[0].id, 'v1');
    assert.equal(versions.nextBefore, null);
    assert.match(server.state.requests[0].url, /\/documents\/.+\/versions$/);

    const one = await adapter.version(id, 'v1');
    assert.equal(one.html, '<h1>Old</h1>');
  });
});

test('a refusal keeps its code and gets the lane hint', async () => {
  await withServer({}, async (server) => {
    server.answer(404, { error: { code: 'not-reachable', message: 'x' } });
    await assert.rejects(client(server, TOKEN).read(htmlClayDocumentId('/home/me/index.html')), (error) => {
      assert.equal(error.code, 'not-reachable');
      assert.equal(error.status, 404);
      assert.equal(error.hint, 'Open the document in HTML Clay, or serve or trust its folder, then try again.');
      return true;
    });
  });
});

test('a redirect is never followed', async () => {
  const behind = await startServer();
  try {
    await withServer({}, async (server) => {
      server.answer(302, '', { headers: { location: `http://127.0.0.1:${behind.port}/x` } });
      await assert.rejects(client(server, TOKEN).read(htmlClayDocumentId('/home/me/index.html')));
      assert.equal(behind.state.requests.length, 0);
    });
  } finally {
    await behind.close();
  }
});

test('a 404 with no error body says the lane is missing', async () => {
  await withServer({}, async (server) => {
    server.answer(404, '');
    await assert.rejects(client(server).read(htmlClayDocumentId('/home/me/index.html')), {
      message: 'This HTML Clay has no agent lane. Update HTML Clay, then try again.',
    });
  });
});

test('writes refuse until the next version', async () => {
  await withServer({}, async (server) => {
    const adapter = htmlClayAdapter(client(server, TOKEN));
    const id = htmlClayDocumentId('/home/me/index.html');
    for (const refuse of [
      () => adapter.save(id, { html: '<h1>New</h1>', etag: 'E1' }),
      () => adapter.writeData(id, { data: {}, etag: 'D1' }),
      () => adapter.restore(id, 'v1', { etag: 'E1' }),
    ]) {
      await assert.rejects(refuse(), { code: 'not-supported' });
    }
    assert.equal(server.state.requests.length, 0);
  });
});

test('a served folder address becomes its file', async (t) => {
  const home = await tempHome(t);
  const notes = path.join(home, 'notes');
  await fs.mkdir(path.join(notes, 'sub'), { recursive: true });
  const file = path.join(notes, 'sub', 'a.html');
  await fs.writeFile(file, HOME_HTML, 'utf8');
  const notesDir = await fs.realpath(notes);
  const realFile = await fs.realpath(file);

  await withServer({}, async (server) => {
    const found = {
      htmlClay: {
        port: server.port,
        token: null,
        servedFolders: [{ id: 'f1', name: 'notes', path: notesDir, serving: true }],
      },
      hyperclayLocal: null,
    };
    const env = { HOME: home };

    const target = await resolveTarget(`http://notes.htmlclay.localhost:${server.port}/sub/a.html`, {
      cwd: home,
      env,
      platform: 'darwin',
      discovered: found,
    });
    assert.deepEqual(target, {
      host: 'htmlclay',
      port: server.port,
      id: htmlClayDocumentId(realFile),
      path: 'sub/a.html',
      ref: realFile,
    });

    await assert.rejects(
      resolveTarget(`http://elsewhere.htmlclay.localhost:${server.port}/sub/a.html`, {
        cwd: home,
        env,
        platform: 'darwin',
        discovered: found,
      }),
      { code: 'not-found' },
    );

    await assert.rejects(
      resolveTarget(`http://notes.htmlclay.localhost:${server.port}/%2E%2E%2Fsecret.html`, {
        cwd: home,
        env,
        platform: 'darwin',
        discovered: found,
      }),
      { code: 'not-found' },
    );

    assert.equal(server.state.requests.length, 0);
  });
});

test('a file outside the home folder is refused before any request', async (t) => {
  const home = await tempHome(t);
  const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clay-elsewhere-')));
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  const file = path.join(elsewhere, 'secret.html');
  await fs.writeFile(file, HOME_HTML, 'utf8');

  await withServer({}, async (server) => {
    await writeHTMLClayConfig(home, server.port);
    const actions = await buildActions({ env: { HOME: home }, cwd: home });

    await assert.rejects(actions.read_document({ document: file }), { code: 'host-unavailable' });
    assert.equal(server.state.requests.length, 0);
  });
});

test('buildActions registers the HTML Clay adapter', async (t) => {
  const home = await tempHome(t);
  const file = path.join(home, 'index.html');
  await fs.writeFile(file, HOME_HTML, 'utf8');
  const realFile = await fs.realpath(file);

  await withServer({ doc: { ...document(realFile), path: 'index.html' } }, async (server) => {
    await writeHTMLClayConfig(home, server.port);
    const actions = await buildActions({ env: { HOME: home }, cwd: home });

    const read = await actions.read_document({ document: file });
    assert.equal(read.host, 'htmlclay');
    assert.equal(read.ref, realFile);
    assert.equal(read.html, HOME_HTML);
    assert.equal(server.state.requests.length, 1);
    assert.match(server.state.requests[0].url, new RegExp(`/documents/${htmlClayDocumentId(realFile)}$`));
  });
});
