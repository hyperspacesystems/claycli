import fs from 'node:fs/promises';
import path from 'node:path';

import { homeDir } from './credentials.js';

export function userConfigDir(env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    return path.join(homeDir(env), 'Library', 'Application Support');
  }
  if (platform === 'win32') {
    return env.APPDATA || path.join(homeDir(env), 'AppData', 'Roaming');
  }
  return env.XDG_CONFIG_HOME || path.join(homeDir(env), '.config');
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

async function readJson(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// htmlClay reads HTML Clay's own config folder: the port it answers on, the agent
// token a program sends (null when the file is missing or not a token), and the
// folders it serves, each path compared after resolving links.
export async function htmlClay(env = process.env, platform = process.platform) {
  const dir = path.join(userConfigDir(env, platform), 'htmlclay');
  const data = await readJson(path.join(dir, 'config.json'));
  if (!isObject(data) || !isPositiveInteger(data.port)) return null;
  const servedFolders = [];
  for (const folder of Array.isArray(data.servedFolders) ? data.servedFolders : []) {
    if (!isObject(folder)) continue;
    if (typeof folder.id !== 'string' || folder.id === '') continue;
    if (typeof folder.name !== 'string' || folder.name === '') continue;
    if (typeof folder.path !== 'string' || !path.isAbsolute(folder.path)) continue;
    servedFolders.push({ id: folder.id, name: folder.name, path: await realPathOrSelf(folder.path), serving: folder.serving === true });
  }
  return { port: data.port, token: await readAgentToken(path.join(dir, 'agent-token')), servedFolders };
}

async function realPathOrSelf(file) {
  try {
    return await fs.realpath(file);
  } catch {
    return path.resolve(file);
  }
}

// readAgentToken is the token HTML Clay wrote at start: 32 random bytes as hex.
async function readAgentToken(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const token = text.trim();
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

export function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function hyperclayLocal(env = process.env, platform = process.platform, { isAlive = defaultIsAlive } = {}) {
  const file = path.join(userConfigDir(env, platform), 'Hyperclay Local', 'served-roots.json');
  const data = await readJson(file);
  if (!isObject(data)) return null;
  if (data.v !== 1) return null;
  if (typeof data.pid !== 'number') return null;
  if (!Array.isArray(data.roots)) return null;
  if (!isAlive(data.pid)) return null;

  const roots = [];
  for (const root of data.roots) {
    if (!isObject(root)) continue;
    if (typeof root.path !== 'string' || !path.isAbsolute(root.path)) continue;
    if (!isPositiveInteger(root.port)) continue;
    roots.push({ path: root.path, port: root.port });
  }
  return { roots };
}

export async function discover(env = process.env, platform = process.platform, options = {}) {
  const [clay, local] = await Promise.all([htmlClay(env, platform), hyperclayLocal(env, platform, options)]);
  return { htmlClay: clay, hyperclayLocal: local };
}
