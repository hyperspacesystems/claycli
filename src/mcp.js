import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ClayError } from './errors.js';
import { buildActions } from './runtime.js';
import { INSTRUCTIONS, TOOLS, registerTools } from './tools.js';

const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;

export function createMcpServer({ actions, readOnly = false, version = VERSION }) {
  const server = new McpServer({ name: 'clay-agent', version }, { instructions: INSTRUCTIONS });
  registerTools(server, { actions, tools: TOOLS.filter((tool) => !readOnly || tool.read) });
  return server;
}

const MCP_HOSTS = ['hyperclay', 'htmlclay', 'local'];

const MCP_USAGE = 'Usage: clay-agent mcp [--read-only] [--hosts <a,b>] [--hyperclay-url <url>]';

function usageFailure(hint = null) {
  return new ClayError('invalid-argument', MCP_USAGE, { hint, details: { usage: MCP_USAGE } });
}

function parseArgv(argv) {
  const options = { readOnly: false, hosts: undefined, hyperclayUrl: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--read-only') {
      options.readOnly = true;
    } else if (arg === '--hosts') {
      if (argv[i + 1] === undefined) throw usageFailure();
      options.hosts = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--hosts=')) {
      options.hosts = arg.slice('--hosts='.length);
    } else if (arg === '--hyperclay-url') {
      if (argv[i + 1] === undefined) throw usageFailure();
      options.hyperclayUrl = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--hyperclay-url=')) {
      options.hyperclayUrl = arg.slice('--hyperclay-url='.length);
    } else if (arg === '--host' || arg.startsWith('--host=')) {
      throw usageFailure('Use --hosts');
    } else {
      throw usageFailure();
    }
  }
  if (typeof options.hosts === 'string') {
    options.hosts = options.hosts
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (options.hosts !== undefined) {
    if (!options.hosts.length) throw usageFailure();
    for (const host of options.hosts) {
      if (!MCP_HOSTS.includes(host)) throw usageFailure();
    }
  }
  return options;
}

export async function runMcp({ env, cwd, argv = [] }) {
  const { readOnly, hosts, hyperclayUrl } = parseArgv(argv);

  console.log = (...args) => console.error(...args);
  console.info = (...args) => console.error(...args);

  const actions = await buildActions({
    env,
    cwd,
    readOnly,
    explicitEtag: false,
    hosts,
    hyperclayUrl,
  });
  const server = createMcpServer({ actions, readOnly, version: VERSION });
  await server.connect(new StdioServerTransport());
  return server;
}
