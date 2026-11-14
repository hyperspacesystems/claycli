import { createActions } from './actions.js';
import { baseUrl, readKey } from './credentials.js';
import { discover } from './discovery.js';
import { ClayError } from './errors.js';
import { htmlClayAdapter, htmlClayClient } from './hosts/htmlclay.js';
import { hyperclayAdapter } from './hosts/hyperclay-adapter.js';
import { hyperclayClient } from './hosts/hyperclay.js';
import { resolveTarget } from './target.js';

const DEFAULT_HOSTS = ['hyperclay', 'htmlclay', 'local'];

export async function buildActions({
  env,
  cwd,
  readOnly = false,
  explicitEtag = false,
  hosts = DEFAULT_HOSTS,
  hyperclayUrl = null,
} = {}) {
  const base = baseUrl({ flag: hyperclayUrl, env });
  const adapters = {};
  const discovered = await discover(env);

  if (hosts.includes('hyperclay')) {
    const client = hyperclayClient({ base, getKey: () => readKey(base, env) });
    adapters.hyperclay = hyperclayAdapter(client);
  }

  if (hosts.includes('htmlclay') && discovered.htmlClay) {
    adapters.htmlclay = htmlClayAdapter(
      htmlClayClient({ port: discovered.htmlClay.port, token: discovered.htmlClay.token }),
    );
  }

  async function resolve(document, { host } = {}) {
    const target = await resolveTarget(document, {
      cwd,
      env,
      discovered,
      hostOverride: host ?? null,
      hyperclayBase: base,
    });
    if (!hosts.includes(target.host)) {
      throw new ClayError('host-not-allowed', `This server was started without access to ${target.host}.`, {
        hint: 'Add it to --hosts.',
      });
    }
    return target;
  }

  return createActions({ adapters, resolve, readOnly, explicitEtag, cwd });
}
