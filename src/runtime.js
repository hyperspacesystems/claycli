import { createActions } from './actions.js';
import { baseUrl, readKey } from './credentials.js';
import { discover } from './discovery.js';
import { ClayError } from './errors.js';
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

  if (hosts.includes('hyperclay')) {
    const client = hyperclayClient({ base, getKey: () => readKey(base, env) });
    adapters.hyperclay = hyperclayAdapter(client);
  }

  const discovered = await discover(env);

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

  return createActions({ adapters, resolve, readOnly, explicitEtag });
}
