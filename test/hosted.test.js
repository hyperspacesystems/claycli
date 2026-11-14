import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ClayError } from '../src/errors.js';
import { HOSTED_PARSE_LIMIT, handleHostedRequest, hostedResolve } from '../src/hosted.js';
import { TOOLS, hostedTools } from '../src/tools.js';

const KEY = 'hcak_test';
const BASE = 'https://hyperclay.test';

function fakeDocument() {
  return {
    id: '7',
    name: 'notes.html',
    path: 'notes.html',
    url: 'https://david.hyperclay.com/notes.html',
    etag: 'E1',
    size: 11,
    hasApiRules: false,
    html: '<h1>Hi from the fake host</h1>',
  };
}

function fakeLargeDocument() {
  const head = '<!doctype html><html><body><main id="board"><h1>Board</h1></main>';
  const tail = '</body></html>';
  const html = head + 'x'.repeat(150000 - head.length - tail.length) + tail;
  return {
    id: '8',
    name: 'big.html',
    path: 'big.html',
    url: 'https://david.hyperclay.com/big.html',
    etag: 'E8',
    size: html.length,
    hasApiRules: false,
    html,
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// The agent API as hyperclay.com answers it for the documents the fake knows.
function fakeAgentApi() {
  const documents = { 7: fakeDocument(), 8: fakeLargeDocument() };
  const state = { requests: [], document: documents[7], documents };

  async function fetchImpl(url, options = {}) {
    const target = new URL(String(url));
    const headers = options.headers ?? {};
    state.requests.push({ url: String(url), method: options.method ?? 'GET', authorization: headers.Authorization ?? null });
    const tail = target.pathname.split('/').filter(Boolean).slice(3);

    if (target.pathname === '/_/agent/v1/whoami') {
      return json(200, { person: { username: 'david' }, key: {}, features: ['files', 'file-writes'] });
    }

    if (options.method === 'GET' && tail.length === 1 && tail[0] === 'documents') {
      const doc = state.document;
      return json(200, {
        documents: [{ id: doc.id, account: 'david', path: doc.path, name: doc.name, url: doc.url, updatedAt: '2024-01-01T00:00:00.000Z' }],
        nextCursor: null,
      });
    }

    if (options.method === 'GET' && tail.length === 2 && tail[0] === 'documents') {
      const document = state.documents[tail[1]];
      if (!document) return json(404, { error: { code: 'not-found', message: 'No route.' } });
      if (headers['If-None-Match'] === document.etag) return new Response(null, { status: 304, headers: { etag: document.etag } });
      return json(200, document);
    }

    return json(404, { error: { code: 'not-found', message: 'No route.' } });
  }

  return { state, fetchImpl };
}

async function startHostedServer({ allow } = {}) {
  const api = fakeAgentApi();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : undefined;
      try {
        await handleHostedRequest({
          req,
          res,
          body,
          base: BASE,
          getKey: () => KEY,
          allow,
          fetchImpl: api.fetchImpl,
        });
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(error) }));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, api, url: `http://127.0.0.1:${server.address().port}/` };
}

test('hostedTools offers every stdio tool but publish_site, with no host and a required etag', () => {
  const names = TOOLS.map((tool) => tool.name);
  const hosted = hostedTools();

  assert.deepEqual(hosted.map((tool) => tool.name), names.filter((name) => name !== 'publish_site'));
  assert.equal(hosted.length, 17);

  for (const tool of hosted) {
    assert.ok(!('host' in tool.inputSchema), tool.name);
  }

  for (const name of ['write_data', 'edit_document', 'save_document', 'restore_version']) {
    const tool = hosted.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.equal(tool.inputSchema.etag.safeParse(undefined).success, false, name);
    assert.equal(tool.inputSchema.etag.safeParse('E1').success, true, name);
  }
});

test('hostedTools offers only the tools allow() accepts, and never publish_site', () => {
  const hosted = hostedTools({ allow: (name) => name === 'read_document' || name === 'publish_site' });
  assert.deepEqual(hosted.map((tool) => tool.name), ['read_document']);
});

test('hostedResolve takes only hyperclay ids and https addresses', async () => {
  assert.deepEqual(await hostedResolve('hyperclay:12'), { host: 'hyperclay', id: '12', ref: 'hyperclay:12' });
  assert.deepEqual(await hostedResolve('https://david.hyperclay.com/notes.html'), {
    host: 'hyperclay',
    url: 'https://david.hyperclay.com/notes.html',
  });

  for (const reference of ['/etc/hosts', 'notes.html', 'http://127.0.0.1:4321/a.html', 'file:///tmp/a.html']) {
    await assert.rejects(hostedResolve(reference), (error) => {
      assert.ok(error instanceof ClayError);
      assert.equal(error.code, 'not-found', reference);
      return true;
    });
  }

  await assert.rejects(hostedResolve('hyperclay:12', { host: 'local' }), (error) => {
    assert.equal(error.code, 'host-not-allowed');
    return true;
  });
});

let hosted = null;
let client = null;

after(async () => {
  if (client) await client.close();
  if (hosted) await new Promise((resolve) => hosted.server.close(resolve));
});

test('the hosted server answers listTools and read_document over real HTTP with the caller key', async () => {
  hosted = await startHostedServer();
  client = new Client({ name: 'hosted-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(hosted.url)));

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    TOOLS.map((tool) => tool.name).filter((name) => name !== 'publish_site'),
  );
  assert.equal(listed.tools.length, 17);

  const read = await client.callTool({ name: 'read_document', arguments: { document: 'hyperclay:7' } });
  assert.equal(read.isError, undefined);
  assert.match(read.content[0].text, /Hi from the fake host/);

  const seen = hosted.api.state.requests.find((entry) => entry.url === `${BASE}/_/agent/v1/documents/7`);
  assert.ok(seen, 'the hosted server did not read the document from hyperclay.com');
  assert.equal(seen.authorization, `Bearer ${KEY}`);

  const saved = await client.callTool({ name: 'save_document', arguments: { document: 'hyperclay:7', html: '<p>x</p>' } });
  assert.equal(saved.isError, true);
  assert.match(saved.content[0].text, /etag/i);
});

test('hosted mode sets a parse limit below what the process can afford to parse', () => {
  assert.equal(HOSTED_PARSE_LIMIT, 100000);
});

test('the hosted server refuses to outline a document past the parse limit', async () => {
  const server = await startHostedServer();
  const session = new Client({ name: 'hosted-parse-limit-test', version: '1.0.0' });
  await session.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  try {
    const outlined = await session.callTool({ name: 'outline_document', arguments: { document: 'hyperclay:8' } });
    assert.equal(outlined.isError, true);
    assert.equal(outlined.structuredContent.error.code, 'too-large-to-parse');
    assert.match(outlined.structuredContent.error.hint, /range/);

    const found = await session.callTool({
      name: 'find_in_document',
      arguments: { document: 'hyperclay:8', text: 'Board' },
    });
    assert.equal(found.isError, undefined);
    assert.equal(found.structuredContent.count, 1);
    assert.equal(found.structuredContent.elementPaths, false);
    assert.equal(found.structuredContent.matches[0].path, null);

    const ranged = await session.callTool({
      name: 'read_document',
      arguments: { document: 'hyperclay:8', range: { start: 0, length: 20 } },
    });
    assert.equal(ranged.isError, undefined);
    assert.equal(ranged.structuredContent.html.length, 20);
  } finally {
    await session.close();
    await new Promise((resolve) => server.server.close(resolve));
  }
});
