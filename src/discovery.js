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

export async function htmlClay(env = process.env, platform = process.platform) {
  const file = path.join(userConfigDir(env, platform), 'htmlclay', 'config.json');
  const data = await readJson(file);
  if (!isObject(data) || !isPositiveInteger(data.port)) return null;
  return { port: data.port };
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
