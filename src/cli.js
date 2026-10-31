import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import { ClayError, asClayError, exitCode, redact } from './errors.js';
import { baseUrl, isAgentKey, readKey, removeKey, saveKey } from './credentials.js';
import { whoami } from './hosts/whoami.js';
import { runMcp } from './mcp.js';
import { buildActions } from './runtime.js';

const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;

const USAGE = `clay-agent lets AI agents read and edit your hyperclay.com documents.

Usage:
  clay-agent login [--hyperclay-url <url>]
  clay-agent logout [--hyperclay-url <url>]
  clay-agent status [--hyperclay-url <url>] [--json]
  clay-agent mcp [--read-only] [--hosts <a,b>]
  clay-agent list [where] [--cursor <id>]
  clay-agent read <document> [--select <css>] [--range <start:length>] [--max-chars <n>]
  clay-agent read <document> --outline [--depth <n>]
  clay-agent read <document> (--find <text> | --regex <pattern>) [--limit <n>]
  clay-agent data <document>
  clay-agent data <document> --write <json|-> --if-match <etag>
  clay-agent edit <document> (--find <text> --replace <text> [--occurrence <n>] | --edits <file.json>) --if-match <etag>
  clay-agent save <document> --file <path|-> --if-match <etag>
  clay-agent versions <document> [--before <id>]
  clay-agent version <document> <version-id> [--select <css>] [--range <start:length>]
  clay-agent restore <document> <version-id> --if-match <etag>

Document commands take --json, --host <host> and --hyperclay-url <url>.
Your agent key is only read from stdin or the CLAY_AGENT_KEY environment variable.
`;

const NOT_SIGNED_IN =
  'Not signed in. Make an agent key in the dashboard (Account, then Agent keys), then run: npx -y @panphora/clay-agent login';

const KEY_COMMAND_LINE =
  'Do not put the key on the command line: it would be saved in your shell history. Run `clay-agent login` and paste it.';

const KEY_IN_ARGV = /hcak_[0-9a-f]{64}/i;

const SCOPES = {
  all: 'everything',
  account: 'one account',
  folder: 'one folder',
};

function scopeLabel(scope) {
  return SCOPES[scope?.kind] || 'unknown scope';
}

function parseArgv(argv) {
  const flags = { json: false, url: null };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--hyperclay-url') {
      flags.url = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--hyperclay-url=')) {
      flags.url = arg.slice('--hyperclay-url='.length);
    } else if (arg.startsWith('-')) {
      positionals.push(arg);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readSecret(stdin, stderr) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stderr, terminal: true });
    rl._writeToOutput = () => {};
    rl.on('SIGINT', () => {
      stderr.write('\n');
      process.exit(130);
    });
    stderr.write('Paste your agent key: ');
    let answer = '';
    let answered = false;
    rl.on('line', (line) => {
      if (answered) return;
      answered = true;
      answer = line;
      rl.close();
    });
    rl.on('close', () => {
      stderr.write('\n');
      resolve(answer);
    });
  });
}

async function readPastedKey({ stdin, stderr }) {
  if (stdin.isTTY) return readSecret(stdin, stderr);
  return readAll(stdin);
}

function expiresLabel(expiresAt) {
  if (!expiresAt) return 'never';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return String(expiresAt);
  return date.toISOString().slice(0, 10);
}

async function login(argv, { stdin, stdout, stderr, env }) {
  const { flags, positionals } = parseArgv(argv);
  if (positionals.length) {
    throw new ClayError('invalid-argument', KEY_COMMAND_LINE);
  }
  const base = baseUrl({ flag: flags.url, env });
  const key = (await readPastedKey({ stdin, stderr })).trim();
  if (!isAgentKey(key)) {
    throw new ClayError('invalid-key', 'That is not an agent key. Copy it from the dashboard: it starts with hcak_.');
  }
  const info = await whoami(base, key);
  await saveKey(base, key, env);
  const name = info?.key?.name || 'unnamed key';
  if (flags.json) {
    stdout.write(`${JSON.stringify({ person: info?.person, key: info?.key }, null, 2)}\n`);
    return 0;
  }
  stdout.write(
    `Signed in as ${info?.person?.username} through "${name}" (${info?.key?.access}, ${scopeLabel(info?.key?.scope)})\n`,
  );
  return 0;
}

async function logout(argv, { stdout, env }) {
  const { flags } = parseArgv(argv);
  const base = baseUrl({ flag: flags.url, env });
  const removed = await removeKey(base, env);
  if (flags.json) {
    stdout.write(`${JSON.stringify({ removed }, null, 2)}\n`);
    return 0;
  }
  stdout.write(removed ? 'Signed out.\n' : 'You were not signed in.\n');
  return 0;
}

async function status(argv, { stdout, env }) {
  const { flags } = parseArgv(argv);
  const base = baseUrl({ flag: flags.url, env });
  const key = await readKey(base, env);
  if (!key) {
    throw new ClayError('key-missing', NOT_SIGNED_IN);
  }
  const info = await whoami(base, key);
  if (flags.json) {
    stdout.write(`${JSON.stringify({ person: info.person, key: info.key }, null, 2)}\n`);
    return 0;
  }
  const k = info.key || {};
  stdout.write(`Signed in as ${info.person?.username}\n`);
  stdout.write(`Key: "${k.name}" (${k.prefix}\u2026, ${k.access}, ${scopeLabel(k.scope)})\n`);
  stdout.write(`Expires: ${expiresLabel(k.expiresAt)}\n`);
  return 0;
}

const COMMAND_USAGE = {
  list: 'Usage: clay-agent list [where] [--cursor <id>]',
  read: 'Usage: clay-agent read <document> [--select <css>] [--range <start:length>] [--max-chars <n>] [--outline [--depth <n>]] [--find <text> | --regex <pattern> [--limit <n>]]',
  data: 'Usage: clay-agent data <document> [--write <json|-> --if-match <etag>]',
  edit: 'Usage: clay-agent edit <document> (--find <text> --replace <text> [--occurrence <n>] | --edits <file.json>) --if-match <etag>',
  save: 'Usage: clay-agent save <document> --file <path|-> --if-match <etag>',
  versions: 'Usage: clay-agent versions <document> [--before <id>]',
  version: 'Usage: clay-agent version <document> <version-id> [--select <css>] [--range <start:length>]',
  restore: 'Usage: clay-agent restore <document> <version-id> --if-match <etag>',
  mcp: 'Usage: clay-agent mcp [--read-only] [--hosts <a,b>]',
};

const FLAG_NAMES = {
  '--host': 'host',
  '--hyperclay-url': 'hyperclayUrl',
  '--cursor': 'cursor',
  '--select': 'select',
  '--range': 'range',
  '--max-chars': 'maxChars',
  '--depth': 'depth',
  '--find': 'find',
  '--regex': 'regex',
  '--limit': 'limit',
  '--write': 'write',
  '--if-match': 'ifMatch',
  '--replace': 'replace',
  '--occurrence': 'occurrence',
  '--edits': 'edits',
  '--file': 'file',
  '--before': 'before',
  '--hosts': 'hosts',
};

const BOOLEAN_FLAGS = {
  '--json': 'json',
  '--outline': 'outline',
  '--read-only': 'readOnly',
};

function usageFailure(usage) {
  return new ClayError('invalid-argument', usage, { details: { usage } });
}

function parseCommandArgv(argv, usage) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (name in BOOLEAN_FLAGS) {
      flags[BOOLEAN_FLAGS[name]] = true;
      continue;
    }
    if (name in FLAG_NAMES) {
      let value = inline;
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined) throw usageFailure(usage);
        i += 1;
      }
      flags[FLAG_NAMES[name]] = value;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') throw usageFailure(usage);
    positionals.push(arg);
  }
  return { flags, positionals };
}

function requirePositionals(positionals, count, usage) {
  if (positionals.length < count) throw usageFailure(usage);
}

function parseWholeNumber(value, usage) {
  if (!/^\d+$/.test(String(value ?? ''))) throw usageFailure(usage);
  return Number(value);
}

function parseRangeArgument(value, usage) {
  const match = /^(\d+):(\d+)$/.exec(String(value ?? ''));
  if (!match) throw usageFailure(usage);
  return { start: Number(match[1]), length: Number(match[2]) };
}

function documentInput(positionals, flags) {
  const input = { document: positionals[0] };
  if (flags.host !== undefined) input.host = flags.host;
  return input;
}

async function buildForDocument(context, flags) {
  const hosts = flags.hosts === undefined ? undefined : String(flags.hosts).split(',');
  return buildActions({
    env: context.env,
    cwd: context.cwd,
    explicitEtag: true,
    hosts,
    hyperclayUrl: flags.hyperclayUrl ?? null,
  });
}

function printResult(result, flags, context) {
  if (flags.json) {
    context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const hasHtml = result && typeof result === 'object' && Object.hasOwn(result, 'html');
  if (hasHtml && !Object.hasOwn(result, 'matches')) {
    const html = String(result.html);
    context.stdout.write(html);
    if (!html.endsWith('\n')) context.stdout.write('\n');
    return;
  }
  context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function readInput(source, context) {
  if (source === '-') return readAll(context.stdin);
  return fs.readFile(source, 'utf8');
}

async function readJsonArgument(value, context) {
  if (value === '-') return readAll(context.stdin);
  return String(value);
}

async function listCommand(argv, context) {
  const usage = COMMAND_USAGE.list;
  const { flags, positionals } = parseCommandArgv(argv, usage);
  const actions = await buildForDocument(context, flags);
  const input = {};
  if (positionals[0] !== undefined) input.where = positionals[0];
  if (flags.host !== undefined) input.host = flags.host;
  if (flags.cursor !== undefined) input.cursor = flags.cursor;
  printResult(await actions.list_documents(input), flags, context);
  return 0;
}

async function readCommand(argv, context) {
  const usage = COMMAND_USAGE.read;
  const { flags, positionals } = parseCommandArgv(argv, usage);
  requirePositionals(positionals, 1, usage);
  const actions = await buildForDocument(context, flags);
  const input = documentInput(positionals, flags);

  if (flags.outline) {
    if (flags.depth !== undefined) input.depth = parseWholeNumber(flags.depth, usage);
    if (flags.select !== undefined) input.select = flags.select;
    printResult(await actions.outline_document(input), flags, context);
    return 0;
  }

  if (flags.find !== undefined || flags.regex !== undefined) {
    if (flags.find !== undefined) input.text = flags.find;
    if (flags.regex !== undefined) input.regex = flags.regex;
    if (flags.limit !== undefined) input.limit = parseWholeNumber(flags.limit, usage);
    printResult(await actions.find_in_document(input), flags, context);
    return 0;
  }

  if (flags.select !== undefined) input.select = flags.select;
  if (flags.range !== undefined) input.range = parseRangeArgument(flags.range, usage);
  if (flags.maxChars !== undefined) input.maxChars = parseWholeNumber(flags.maxChars, usage);
  printResult(await actions.read_document(input), flags, context);
  return 0;
}

async function dataCommand(argv, context) {
  const usage = COMMAND_USAGE.data;
  const { flags, positionals } = parseCommandArgv(argv, usage);
  requirePositionals(positionals, 1, usage);
  const actions = await buildForDocument(context, flags);
  const input = documentInput(positionals, flags);

  if (flags.write === undefined) {
    printResult(await actions.read_data(input), flags, context);
    return 0;
  }

  const text = await readJsonArgument(flags.write, context);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ClayError('invalid-json', 'That is not JSON.', { hint: 'Pass a JSON object, or - to read it from stdin.' });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ClayError('invalid-json', 'The data must be a JSON object.', {
      hint: 'Pass an object such as {"title":"Notes"}.',
    });
  }
  input.data = data;
  if (flags.ifMatch !== undefined) input.etag = flags.ifMatch;
  printResult(await actions.write_data(input), flags, context);
  return 0;
}

async function editCommand(argv, context) {
  const usage = COMMAND_USAGE.edit;
  const { flags, positionals } = parseCommandArgv(argv, usage);
  requirePositionals(positionals, 1, usage);
  const actions = await buildForDocument(context, flags);
  const input = documentInput(positionals, flags);

  if (flags.edits !== undefined) {
    const text = await readInput(flags.edits, context);
    try {
      input.edits = JSON.parse(text);
    } catch {
      throw new ClayError('invalid-json', 'That edits file is not JSON.', {
        hint: 'Pass an array of {"find","replace"} objects.',
      });
    }
  } else {
    if (flags.find === undefined || flags.replace === undefined) throw usageFailure(usage);
    const edit = { find: flags.find, replace: flags.replace };
    if (flags.occurrence !== undefined) edit.occurrence = parseWholeNumber(flags.occurrence, usage);
    input.edits = [edit];
  }

  if (flags.ifMatch !== undefined) input.etag = flags.ifMatch;
  printResult(await actions.edit_document(input), flags, context);
  return 0;
}

async function saveCommand(argv, context) {
  const usage = COMMAND_USAGE.save;
  const { flags, positionals } = parseCommandArgv(argv, usage);
  requirePositionals(positionals, 1, usage);
  if (flags.file === undefined) throw usageFailure(usage);
  const actions = await buildForDocument(context, flags);
  const input = documentInput(positionals, flags);
  input.html = await readInput(flags.file, context);
  if (flags.ifMatch !== undefined) input.etag = flags.ifMatch;
  printResult(await actions.save_document(input), flags, context);
  return 0;
}

async function versionsCommand(argv, context) {
  const usage = COMMAND_USAGE.versions;
  const { flags, positionals } = parseCommandArgv(argv, usage);
  requirePositionals(positionals, 1, usage);
  const actions = await buildForDocument(context, flags);
  const input = documentInput(positionals, flags);
  if (flags.before !== undefined) input.before = flags.before;
  printResult(await actions.list_versions(input), flags, context);
  return 0;
}

async function versionCommand(argv, context) {
  const usage = COMMAND_USAGE.version;
  const { flags, positionals } = parseCommandArgv(argv, usage);
  requirePositionals(positionals, 2, usage);
  const actions = await buildForDocument(context, flags);
  const input = documentInput(positionals, flags);
  input.version = positionals[1];
  if (flags.select !== undefined) input.select = flags.select;
  if (flags.range !== undefined) input.range = parseRangeArgument(flags.range, usage);
  if (flags.maxChars !== undefined) input.maxChars = parseWholeNumber(flags.maxChars, usage);
  printResult(await actions.read_version(input), flags, context);
  return 0;
}

async function restoreCommand(argv, context) {
  const usage = COMMAND_USAGE.restore;
  const { flags, positionals } = parseCommandArgv(argv, usage);
  requirePositionals(positionals, 2, usage);
  const actions = await buildForDocument(context, flags);
  const input = documentInput(positionals, flags);
  input.version = positionals[1];
  if (flags.ifMatch !== undefined) input.etag = flags.ifMatch;
  printResult(await actions.restore_version(input), flags, context);
  return 0;
}

async function mcpCommand(argv, context) {
  await runMcp({
    env: context.env,
    cwd: context.cwd,
    argv,
  });
  return 0;
}

async function dispatch(argv, context) {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    context.stdout.write(USAGE);
    return 0;
  }
  if (command === '--version' || command === '-V') {
    context.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!command) {
    context.stderr.write(USAGE);
    return 1;
  }
  if (command === 'login') return login(rest, context);
  if (command === 'logout') return logout(rest, context);
  if (command === 'status') return status(rest, context);
  if (command === 'mcp') return mcpCommand(rest, context);
  if (command === 'list') return listCommand(rest, context);
  if (command === 'read') return readCommand(rest, context);
  if (command === 'data') return dataCommand(rest, context);
  if (command === 'edit') return editCommand(rest, context);
  if (command === 'save') return saveCommand(rest, context);
  if (command === 'versions') return versionsCommand(rest, context);
  if (command === 'version') return versionCommand(rest, context);
  if (command === 'restore') return restoreCommand(rest, context);
  context.stderr.write(USAGE);
  return 1;
}

export async function main(argv, { stdin, stdout, stderr, env, cwd }) {
  const context = { stdin, stdout, stderr, env, cwd: cwd ?? process.cwd() };
  const json = argv.includes('--json');
  try {
    if (argv.some((arg) => KEY_IN_ARGV.test(String(arg)))) {
      throw new ClayError('invalid-argument', KEY_COMMAND_LINE);
    }
    return await dispatch(argv, context);
  } catch (error) {
    const clay = asClayError(error);
    if (clay.details?.usage) {
      if (json) {
        stdout.write(`${JSON.stringify({ error: { code: 'usage', message: clay.details.usage } }, null, 2)}\n`);
        return 1;
      }
      stderr.write(`${clay.details.usage}\n`);
      if (clay.hint) stderr.write(`${clay.hint}\n`);
      return 1;
    }
    if (clay.code === 'conflict' && clay.etag) {
      if (json) stdout.write(`${JSON.stringify(clay.toJSON(), null, 2)}\n`);
      else stdout.write(`${clay.etag}\n`);
    }
    if (json) {
      stderr.write(`${JSON.stringify(clay.toJSON(), null, 2)}\n`);
    } else {
      stderr.write(`${redact(clay.message)}\n`);
      if (clay.hint) stderr.write(`${redact(clay.hint)}\n`);
    }
    return exitCode(clay.code);
  }
}
