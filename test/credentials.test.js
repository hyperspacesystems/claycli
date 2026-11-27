import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/cli.js';
import { baseUrl, homeDir, readKey, saveKey } from '../src/credentials.js';
import { redact } from '../src/errors.js';

const GOOD_KEY = `hcak_${'a'.repeat(64)}`;
const REVOKED_KEY = `hcak_${'b'.repeat(64)}`;

function collector() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  stream.text = () => Buffer.concat(chunks).toString('utf8');
  return stream;
}

async function run(argv, { input = '', env }) {
  const stdout = collector();
  const stderr = collector();
  const stdin = Readable.from(input === '' ? [] : [input]);
  const code = await main(argv, { stdin, stdout, stderr, env });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'claycli-test-'));
}

function whoamiBody() {
  return {
    person: { username: 'david' },
    key: {
      id: 'key_1',
      name: 'laptop',
      prefix: GOOD_KEY.slice(0, 13),
      access: 'write',
      scope: { kind: 'account', accountId: 'acct_1', folderId: null },
      expiresAt: '2030-01-02T03:04:05.000Z',
    },
  };
}

async function startServer() {
  const seen = [];
  const server = http.createServer((request, response) => {
    const authorization = request.headers.authorization || null;
    seen.push({ url: request.url, authorization });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/_/agent/v1/whoami') {
      const key = (authorization || '').replace(/^Bearer /, '');
      if (key === GOOD_KEY) {
        response.statusCode = 200;
        response.end(JSON.stringify(whoamiBody()));
        return;
      }
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { code: 'key-revoked', message: 'That agent key was revoked.' } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: 'not-found', message: 'No such route.' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withServer(fn) {
  const fake = await startServer();
  const home = await tempHome();
  try {
    await fn({ base: fake.base, seen: fake.seen, home });
  } finally {
    await fake.close();
    await fs.rm(home, { recursive: true, force: true });
  }
}

function envFor(home, base, extra = {}) {
  return { HOME: home, CLAY_CLI_URL: base, ...extra };
}

function credentialsFile(home) {
  return path.join(home, '.config', 'claycli', 'credentials.json');
}

function oldCredentialsFile(home) {
  return path.join(home, '.config', 'clay-agent', 'credentials.json');
}

async function saveUnderOldName(home, hosts) {
  const file = oldCredentialsFile(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ v: 1, hosts }));
  return file;
}

test('login stores the key in a private file and prints who signed in', async () => {
  await withServer(async ({ base, home }) => {
    const result = await run(['login', '--hyperclay-url', base], {
      input: `${GOOD_KEY}\n`,
      env: envFor(home, base),
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Signed in as david through "laptop" \(write, one account\)/);
    assert.ok(!result.stdout.includes(GOOD_KEY));
    assert.ok(!result.stderr.includes(GOOD_KEY));

    const file = credentialsFile(home);
    const store = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(store.v, 1);
    assert.equal(store.hosts[base].key, GOOD_KEY);

    const fileStat = await fs.stat(file);
    assert.equal(fileStat.mode & 0o777, 0o600);
    const dirStat = await fs.stat(path.dirname(file));
    assert.equal(dirStat.mode & 0o777, 0o700);
  });
});

test('login refuses a key passed as an argument', async () => {
  await withServer(async ({ base, home }) => {
    const result = await run(['login', '--hyperclay-url', base, GOOD_KEY], {
      env: envFor(home, base),
    });

    assert.equal(result.code, 1);
    await assert.rejects(fs.readFile(credentialsFile(home), 'utf8'), { code: 'ENOENT' });
    assert.ok(!result.stderr.includes('hcak_'));
    assert.ok(!result.stdout.includes('hcak_'));
  });
});

test('login rejects a malformed key and saves nothing', async () => {
  await withServer(async ({ base, home, seen }) => {
    const result = await run(['login', '--hyperclay-url', base], {
      input: 'not-a-key\n',
      env: envFor(home, base),
    });

    assert.equal(result.code, 4);
    assert.match(result.stderr, /not an agent key/);
    assert.equal(seen.length, 0);
    await assert.rejects(fs.readFile(credentialsFile(home), 'utf8'), { code: 'ENOENT' });
  });
});

test('login with a revoked key exits 4 and saves nothing', async () => {
  await withServer(async ({ base, home }) => {
    const result = await run(['login', '--hyperclay-url', base], {
      input: `${REVOKED_KEY}\n`,
      env: envFor(home, base),
    });

    assert.equal(result.code, 4);
    assert.match(result.stderr, /revoked/);
    assert.ok(!result.stderr.includes(REVOKED_KEY));
    await assert.rejects(fs.readFile(credentialsFile(home), 'utf8'), { code: 'ENOENT' });
  });
});

test('status shows the prefix, never the full key, and sends the bearer token', async () => {
  await withServer(async ({ base, home, seen }) => {
    const env = envFor(home, base);
    await run(['login', '--hyperclay-url', base], { input: `${GOOD_KEY}\n`, env });

    const result = await run(['status', '--hyperclay-url', base], { env });

    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes(GOOD_KEY.slice(0, 13)));
    assert.ok(!result.stdout.includes(GOOD_KEY));
    assert.ok(!result.stderr.includes(GOOD_KEY));
    assert.match(result.stdout, /david/);
    assert.match(result.stdout, /laptop/);
    assert.match(result.stdout, /2030-01-02/);
    assert.ok(seen.some((entry) => entry.authorization === `Bearer ${GOOD_KEY}`));
  });
});

test('status without a key exits 4, and uses CLAY_CLI_KEY when set', async () => {
  await withServer(async ({ base, home }) => {
    const missing = await run(['status', '--hyperclay-url', base], { env: envFor(home, base) });
    assert.equal(missing.code, 4);
    assert.match(missing.stderr, /Not signed in/);
    await assert.rejects(fs.readFile(credentialsFile(home), 'utf8'), { code: 'ENOENT' });

    const fromEnv = await run(['status', '--hyperclay-url', base], {
      env: envFor(home, base, { CLAY_CLI_KEY: GOOD_KEY }),
    });
    assert.equal(fromEnv.code, 0);
    assert.ok(fromEnv.stdout.includes(GOOD_KEY.slice(0, 13)));
    assert.ok(!fromEnv.stdout.includes(GOOD_KEY));
  });
});

test('logout removes the key and status then exits 4', async () => {
  await withServer(async ({ base, home }) => {
    const env = envFor(home, base);
    await run(['login', '--hyperclay-url', base], { input: `${GOOD_KEY}\n`, env });

    const logout = await run(['logout', '--hyperclay-url', base], { env });
    assert.equal(logout.code, 0);
    assert.match(logout.stdout, /Signed out\./);

    const store = JSON.parse(await fs.readFile(credentialsFile(home), 'utf8'));
    assert.equal(store.hosts[base], undefined);

    const status = await run(['status', '--hyperclay-url', base], { env });
    assert.equal(status.code, 4);
    assert.match(status.stderr, /Not signed in/);
  });
});

test('a key saved under the old clay-agent name still signs in, and logout removes it', async () => {
  await withServer(async ({ base, home }) => {
    const env = envFor(home, base);
    const other = 'https://other.example';
    const oldFile = await saveUnderOldName(home, { [base]: { key: GOOD_KEY }, [other]: { key: REVOKED_KEY } });
    await saveKey('https://third.example', REVOKED_KEY, env);

    const status = await run(['status', '--hyperclay-url', base], { env });
    assert.equal(status.code, 0);
    assert.ok(status.stdout.includes(GOOD_KEY.slice(0, 13)));

    const logout = await run(['logout', '--hyperclay-url', base], { env });
    assert.equal(logout.code, 0);
    assert.match(logout.stdout, /Signed out\./);

    const store = JSON.parse(await fs.readFile(oldFile, 'utf8'));
    assert.equal(store.hosts[base], undefined);
    assert.equal(store.hosts[other].key, REVOKED_KEY);

    const after = await run(['status', '--hyperclay-url', base], { env });
    assert.equal(after.code, 4);
    assert.match(after.stderr, /Not signed in/);
  });
});

test('a new sign-in is saved under the new name, wins over the old file, and logout clears both', async () => {
  await withServer(async ({ base, home }) => {
    const env = envFor(home, base);
    const oldFile = await saveUnderOldName(home, { [base]: { key: REVOKED_KEY } });

    const login = await run(['login', '--hyperclay-url', base], { input: `${GOOD_KEY}\n`, env });
    assert.equal(login.code, 0);
    const saved = JSON.parse(await fs.readFile(credentialsFile(home), 'utf8'));
    assert.equal(saved.hosts[base].key, GOOD_KEY);
    assert.equal(JSON.parse(await fs.readFile(oldFile, 'utf8')).hosts[base].key, REVOKED_KEY);

    const status = await run(['status', '--hyperclay-url', base], { env });
    assert.equal(status.code, 0);

    const logout = await run(['logout', '--hyperclay-url', base], { env });
    assert.equal(logout.code, 0);
    assert.equal(JSON.parse(await fs.readFile(credentialsFile(home), 'utf8')).hosts[base], undefined);
    assert.equal(JSON.parse(await fs.readFile(oldFile, 'utf8')).hosts[base], undefined);

    const after = await run(['status', '--hyperclay-url', base], { env });
    assert.equal(after.code, 4);
    assert.match(after.stderr, /Not signed in/);
  });
});

test('logout removes the key from the file it can read, and names the file it could not', async () => {
  await withServer(async ({ base, home }) => {
    const env = envFor(home, base);
    const oldFile = await saveUnderOldName(home, { [base]: { key: GOOD_KEY } });
    await fs.mkdir(path.dirname(credentialsFile(home)), { recursive: true });
    await fs.writeFile(credentialsFile(home), 'not json');

    const logout = await run(['logout', '--hyperclay-url', base], { env });

    assert.equal(logout.code, 4);
    assert.ok(logout.stderr.includes(credentialsFile(home)));
    assert.equal(JSON.parse(await fs.readFile(oldFile, 'utf8')).hosts[base], undefined);
  });
});

test('redact keeps only the 13-character prefix of a key', async () => {
  const message = `The host rejected ${GOOD_KEY} just now.`;
  const redacted = redact(message);
  assert.equal(redacted, `The host rejected ${GOOD_KEY.slice(0, 13)}\u2026 just now.`);
  assert.ok(!redacted.includes(GOOD_KEY));
});

test('status --json prints the whoami body as JSON', async () => {
  await withServer(async ({ base, home }) => {
    const env = envFor(home, base);
    await run(['login', '--hyperclay-url', base], { input: `${GOOD_KEY}\n`, env });

    const result = await run(['status', '--json', '--hyperclay-url', base], { env });

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.person.username, 'david');
    assert.equal(parsed.key.name, 'laptop');
    assert.ok(!result.stdout.includes(GOOD_KEY));
  });
});

test('a key with a newline in the middle is invalid-key with exit 4 and never printed', async () => {
  await withServer(async ({ base, home, seen }) => {
    const broken = `hcak_${'a'.repeat(32)}\n${'a'.repeat(32)}`;

    const result = await run(['status', '--hyperclay-url', base, '--json'], {
      env: envFor(home, base, { CLAY_CLI_KEY: broken }),
    });

    assert.equal(result.code, 4);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.error.code, 'invalid-key');
    assert.match(parsed.error.message, /^CLAY_CLI_KEY is not a valid agent key/);
    assert.ok(!/hcak_[0-9a-f]{64}/.test(result.stdout));
    assert.ok(!/hcak_[0-9a-f]{64}/.test(result.stderr));
    assert.equal(seen.length, 0);
  });
});

test('a malformed key in the credentials file is invalid-key too', async () => {
  await withServer(async ({ base, home, seen }) => {
    const file = credentialsFile(home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ v: 1, hosts: { [base]: { key: 'nope' } } }));

    const result = await run(['status', '--hyperclay-url', base], { env: envFor(home, base) });

    assert.equal(result.code, 4);
    assert.match(result.stderr, /The saved key is not a valid agent key/);
    assert.ok(!result.stderr.includes('nope'));
    assert.equal(seen.length, 0);
  });
});

test('CLAY_CLI_KEY is used only for the default base', async () => {
  const home = await tempHome();
  try {
    const env = { HOME: home, CLAY_CLI_KEY: GOOD_KEY };

    assert.equal(await readKey('https://other.example', env), null);
    assert.equal(await readKey('https://hyperclay.com', env), GOOD_KEY);

    await saveKey('https://other.example', REVOKED_KEY, env);
    assert.equal(await readKey('https://other.example', env), REVOKED_KEY);
    assert.equal(await readKey('https://hyperclay.com', env), GOOD_KEY);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('the old CLAY_AGENT_ variables still work, and the new names win', async () => {
  const home = await tempHome();
  try {
    const oldUrl = 'http://localhost:4001';
    const newUrl = 'http://localhost:4002';
    assert.equal(baseUrl({ env: { CLAY_AGENT_URL: oldUrl } }), oldUrl);
    assert.equal(baseUrl({ env: { CLAY_CLI_URL: newUrl, CLAY_AGENT_URL: oldUrl } }), newUrl);

    const base = 'https://hyperclay.com';
    assert.equal(await readKey(base, { HOME: home, CLAY_AGENT_KEY: GOOD_KEY }), GOOD_KEY);
    assert.equal(await readKey(base, { HOME: home, CLAY_CLI_KEY: '', CLAY_AGENT_KEY: GOOD_KEY }), GOOD_KEY);
    assert.equal(await readKey(base, { HOME: home, CLAY_CLI_KEY: REVOKED_KEY, CLAY_AGENT_KEY: GOOD_KEY }), REVOKED_KEY);
    await assert.rejects(readKey(base, { HOME: home, CLAY_AGENT_KEY: 'nope' }), /CLAY_AGENT_KEY is not a valid agent key/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('baseUrl refuses cleartext http except on loopback', () => {
  for (const flag of ['http://hyperclay.com', 'ftp://x']) {
    assert.throws(
      () => baseUrl({ flag }),
      (error) => {
        assert.equal(error.code, 'invalid-argument');
        assert.equal(error.message, 'The hyperclay URL must use https.');
        assert.equal(error.hint, 'Use https://hyperclay.com, or http only for localhost.');
        return true;
      },
      flag,
    );
  }

  assert.equal(baseUrl({ flag: 'http://127.0.0.1:4321' }), 'http://127.0.0.1:4321');
  assert.equal(baseUrl({ flag: 'http://foo.localhost' }), 'http://foo.localhost');
  assert.equal(baseUrl({ flag: 'https://hyperclay.com/' }), 'https://hyperclay.com');
});

test('homeDir falls back from HOME to USERPROFILE to os.homedir()', () => {
  assert.equal(homeDir({ HOME: '/home/david' }), '/home/david');
  assert.equal(homeDir({ USERPROFILE: 'C:\\Users\\x' }), 'C:\\Users\\x');
  assert.equal(homeDir({}), os.homedir());
});
