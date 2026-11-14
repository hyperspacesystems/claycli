import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRequire } from 'node:module';

import { createActions } from './actions.js';
import { ClayError } from './errors.js';
import { hyperclayAdapter } from './hosts/hyperclay-adapter.js';
import { hyperclayClient } from './hosts/hyperclay.js';
import { HOSTED_INSTRUCTIONS, hostedTools, registerTools } from './tools.js';

const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;
const REFERENCE = /^hyperclay:(\d+)$/;
export const HOSTED_PARSE_LIMIT = 100000;
const HOSTED_REGEX_WORKERS = 4;

// Only hyperclay:<id> and https:// addresses; never a file path or a loopback app.
export async function hostedResolve(document, { host } = {}) {
  if (host && host !== 'hyperclay') throw new ClayError('host-not-allowed', 'This server reaches hyperclay.com documents only.');
  const reference = String(document ?? '').trim();
  const byId = REFERENCE.exec(reference);
  if (byId) return { host: 'hyperclay', id: byId[1], ref: `hyperclay:${byId[1]}` };
  let url = null;
  try {
    url = new URL(reference);
  } catch {
    url = null;
  }
  if (url && url.protocol === 'https:') return { host: 'hyperclay', url: reference };
  throw new ClayError('not-found', 'Give a document as hyperclay:<id> or its https:// address.', {
    hint: 'list_documents shows the id of every document you can reach.',
  });
}

export function createHostedServer({ actions, allow, version = VERSION }) {
  const server = new McpServer({ name: 'hyperclay', version }, { instructions: HOSTED_INSTRUCTIONS });
  registerTools(server, { actions, tools: hostedTools({ allow }) });
  return server;
}

// Answers one MCP POST. `base` is where the agent API answers (`${base}/_/agent/v1`),
// `getKey` returns the caller's bearer credential, `allow(toolName)` says which tools it may see.
export async function handleHostedRequest({ req, res, body, base, getKey, allow, fetchImpl = fetch }) {
  const client = hyperclayClient({ base, getKey, fetchImpl });
  const actions = createActions({
    adapters: { hyperclay: hyperclayAdapter(client) },
    resolve: hostedResolve,
    explicitEtag: true,
    parseLimit: HOSTED_PARSE_LIMIT,
    editScanLimit: true,
    regexWorkers: HOSTED_REGEX_WORKERS,
  });
  const server = createHostedServer({ actions, allow });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
