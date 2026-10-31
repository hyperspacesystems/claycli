import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { saveKey } from '../src/credentials.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'clay-agent.js');
const KEY = `hcak_${'d'.repeat(64)}`;
const HTML = '<!doctype html><html><body><h1>Cat</h1></body></html>';

async function startServer() {
  const state = {
    etag: 'E1',
    html: HTML,
    data: { title: 'Old' },
    dataEtag: 'D1',
    requests: [],
    next: null,
  };

  function json(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  function route(request, response, body) {
    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const tail = parts.slice(3);

    if (request.method === 'GET' && tail.length === 1 && tail[0] === 'documents') {
      return json(response, 200, {
        documents: [
          {
            id: '1',
            account: 'acct_1',
            path: 'index.html',
            name: 'index.html',
            url: 'https://hyperclay.com/d/1',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      });
    }

    if (request.method === 'GET' && tail.length === 2 && tail[0] === 'documents') {
      if (request.headers['if-none-match'] === state.etag) {
        response.writeHead(304, { etag: state.etag });
        return response.end();
      }
      return json(response, 200, { id: tail[1], etag: state.etag, html: state.html, size: state.html.length });
    }

    if (request.method === 'PUT' && tail.length === 2 && tail[0] === 'documents') {
      if (request.headers['if-match'] !== state.etag) {
        return json(response, 412, {
          error: { code: 'conflict', message: 'The document changed.', etag: 'E2' },
        });
      }
      const parsed = JSON.parse(body || '{}');
      state.html = parsed.html;
      state.etag = 'E2';
      return json(response, 200, { etag: state.etag, changed: true, undoVersionId: 'v2' });
    }

    if (tail.length === 3 && tail[0] === 'documents' && tail[2] === 'data') {
      if (request.method === 'GET') {
        return json(response, 200, { id: tail[1], etag: state.dataEtag, data: state.data });
      }
      if (request.method === 'POST') {
        if (request.headers['if-match'] !== state.dataEtag) {
          return json(response, 412, {
            error: { code: 'conflict', message: 'The data changed.', etag: 'D2' },
          });
        }
        const parsed = JSON.parse(body || '{}');
        state.data = parsed.data;
        state.dataEtag = 'D2';
        return json(response, 200, { etag: state.dataEtag, changed: true, data: state.data });
      }
    }

    return json(response, 404, { error: { code: 'not-found', message: 'No route.' } });
  }

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      const next = state.next;
      state.next = null;
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
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runCli(args, { env, input = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'clay-agent-cli-test-'));
}

async function withServer(fn) {
  const server = await startServer();
  const home = await tempHome();
  try {
    await fn({ base: server.base, state: server.state, home });
  } finally {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  }
}

function envFor(home, base, extra = {}) {
  return { HOME: home, CLAY_AGENT_URL: base, CLAY_AGENT_KEY: KEY, ...extra };
}

test('read prints the html and --json adds the etag', async () => {
  await withServer(async ({ base, home }) => {
    const env = envFor(home, base);

    const plain = await runCli(['read', 'hyperclay:1'], { env });
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /<h1>Cat<\/h1>/);

    const asJson = await runCli(['read', 'hyperclay:1', '--json'], { env });
    assert.equal(asJson.code, 0, asJson.stderr);
    const parsed = JSON.parse(asJson.stdout);
    assert.equal(parsed.etag, 'E1');
    assert.equal(parsed.html, HTML);
  });
});

test('save without --if-match is refused with read-first', async () => {
  await withServer(async ({ base, home, state }) => {
    const result = await runCli(['save', 'hyperclay:1', '--file', '-', '--json'], {
      env: envFor(home, base),
      input: '<h1>New</h1>',
    });

    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'read-first');
    assert.equal(state.requests.length, 0);
  });
});

test('save with a stale --if-match exits 2 and prints the current etag on stdout', async () => {
  await withServer(async ({ base, home }) => {
    const result = await runCli(['save', 'hyperclay:1', '--file', '-', '--if-match', 'E0'], {
      env: envFor(home, base),
      input: '<h1>New</h1>',
    });

    assert.equal(result.code, 2);
    assert.equal(result.stdout.trim(), 'E2');
    assert.match(result.stderr, /changed/i);
  });
});

test('edit with --if-match changes the document', async () => {
  await withServer(async ({ base, home, state }) => {
    const result = await runCli(['edit', 'hyperclay:1', '--find', 'Cat', '--replace', 'Dog', '--if-match', 'E1'], {
      env: envFor(home, base),
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(state.html, /Dog/);
    assert.equal(state.etag, 'E2');
  });
});

test('read without a key exits 4', async () => {
  await withServer(async ({ base, home }) => {
    const result = await runCli(['read', 'hyperclay:1'], { env: envFor(home, base, { CLAY_AGENT_KEY: '' }) });

    assert.equal(result.code, 4);
    assert.match(result.stderr, /Not signed in/);
  });
});

test('mcp on stdio lists the eleven tools and keeps stdout clean', async () => {
  await withServer(async ({ base, home }) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, 'mcp'],
      cwd: ROOT,
      env: envFor(home, base),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'clay-agent-cli-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 11);
      assert.ok(tools.some((tool) => tool.name === 'edit_document'));
    } finally {
      await client.close();
    }
  });
});

test('a host error with a key in its details and hint prints no full key with --json', async () => {
  await withServer(async ({ base, home, state }) => {
    state.next = {
      status: 422,
      body: JSON.stringify({
        error: {
          code: 'invalid-content',
          message: 'The host refused this document.',
          hint: `The rejected key was ${KEY}.`,
          rejectedValue: KEY,
          [KEY]: 'field name',
        },
      }),
    };

    const result = await runCli(['read', 'hyperclay:1', '--json'], { env: envFor(home, base) });

    assert.equal(result.code, 1);
    assert.ok(!result.stdout.includes(KEY));
    assert.ok(!result.stderr.includes(KEY));
    assert.ok(result.stderr.includes(KEY.slice(0, 13)));
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.error.details.rejectedValue, `${KEY.slice(0, 13)}\u2026`);
    assert.equal(parsed.error.details[`${KEY.slice(0, 13)}\u2026`], 'field name');
  });
});

test('a save answered by an HTML 502 exits 5 as outcome-unknown', async () => {
  await withServer(async ({ base, home, state }) => {
    state.next = {
      status: 502,
      contentType: 'text/html',
      body: '<!doctype html><h1>Bad gateway</h1>',
    };

    const result = await runCli(['save', 'hyperclay:1', '--file', '-', '--if-match', 'E1'], {
      env: envFor(home, base),
      input: '<h1>New</h1>',
    });

    assert.equal(result.code, 5);
    assert.match(result.stderr, /may or may not have been saved/);
  });
});

test('mcp starts without a key and answers each call with the login hint', async () => {
  await withServer(async ({ base, home }) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, 'mcp'],
      cwd: ROOT,
      env: { HOME: home, CLAY_AGENT_URL: base },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'clay-agent-cli-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 11);

      const read = await client.callTool({ name: 'read_document', arguments: { document: 'hyperclay:1' } });
      assert.equal(read.isError, true);
      assert.equal(read.structuredContent.error.code, 'key-missing');
      assert.match(read.structuredContent.error.hint, /login/);
      assert.match(read.structuredContent.error.hint, /Agent keys/);
    } finally {
      await client.close();
    }
  });
});

test('--help and --version exit 0, and a conflict with --json prints an etag object', async () => {
  await withServer(async ({ base, home }) => {
    const help = await runCli(['--help'], { env: envFor(home, base) });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage:/);

    const { version } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const printed = await runCli(['--version'], { env: envFor(home, base) });
    assert.equal(printed.code, 0);
    assert.equal(printed.stdout.trim(), version);

    const conflict = await runCli(['save', 'hyperclay:1', '--file', '-', '--if-match', 'E0', '--json'], {
      env: envFor(home, base),
      input: '<h1>New</h1>',
    });
    assert.equal(conflict.code, 2);
    const parsed = JSON.parse(conflict.stdout);
    assert.equal(parsed.error.code, 'conflict');
    assert.equal(parsed.error.etag, 'E2');
  });
});

test('data --write sends the JSON argument itself, never a path', async () => {
  await withServer(async ({ base, state, home }) => {
    const env = envFor(home, base);
    const result = await runCli(
      ['data', 'hyperclay:1', '--write', '{"title":"Notes"}', '--if-match', 'D1'],
      { env },
    );
    assert.equal(result.code, 0, result.stderr);
    const post = state.requests.filter((entry) => entry.method === 'POST' && entry.url.includes('/data')).at(-1);
    assert.ok(post, 'no data write was sent');
    assert.deepEqual(JSON.parse(post.body).data, { title: 'Notes' });
    assert.deepEqual(state.data, { title: 'Notes' });
  });
});

test('a key in any argument is refused before any request and never echoed', async () => {
  await withServer(async ({ base, home, state }) => {
    const result = await runCli(['list', KEY], { env: envFor(home, base) });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Do not put the key on the command line/);
    assert.ok(!result.stdout.includes(KEY.slice('hcak_'.length)));
    assert.ok(!result.stderr.includes(KEY.slice('hcak_'.length)));
    assert.ok(!/hcak_[0-9a-f]{64}/.test(result.stdout + result.stderr));
    assert.equal(state.requests.length, 0);
  });
});

test('the mcp server reads the key on each call, so a later login works without a restart', async () => {
  await withServer(async ({ base, home, state }) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, 'mcp'],
      cwd: ROOT,
      env: { HOME: home, CLAY_AGENT_URL: base },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'clay-agent-cli-test', version: '1.0.0' });

    try {
      await client.connect(transport);

      const before = await client.callTool({ name: 'list_documents', arguments: {} });
      assert.equal(before.isError, true);
      assert.equal(before.structuredContent.error.code, 'key-missing');
      assert.equal(state.requests.length, 0);

      await saveKey(base, KEY, { HOME: home });

      const after = await client.callTool({ name: 'list_documents', arguments: {} });
      assert.equal(after.isError, undefined);
      assert.equal(after.structuredContent.documents.length, 1);
      const listed = state.requests.filter((entry) => entry.url.includes('/documents')).at(-1);
      assert.equal(listed.headers.authorization, `Bearer ${KEY}`);
    } finally {
      await client.close();
    }
  });
});

test('mcp refuses --host, positionals and unknown hosts with a usage message', async () => {
  await withServer(async ({ base, home }) => {
    const env = envFor(home, base);

    const hinted = await runCli(['mcp', '--host', 'local'], { env });
    assert.equal(hinted.code, 1);
    assert.match(hinted.stderr, /Usage: clay-agent mcp/);
    assert.match(hinted.stderr, /Use --hosts/);

    for (const args of [['mcp', 'read-only'], ['mcp', '--hosts', 'foo'], ['mcp', '--hosts', '']]) {
      const result = await runCli(args, { env });
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, /Usage: clay-agent mcp/, args.join(' '));
    }
  });
});
