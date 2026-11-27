import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ClayError } from './errors.js';

export const DEFAULT_BASE = 'https://hyperclay.com';

const KEY_PATTERN = /^hcak_[0-9a-f]{64}$/;

// The tool was named clay-agent through 0.7.0. Keys saved and variables set under that name keep working.
const FOLDER = 'claycli';
const OLD_FOLDER = 'clay-agent';
const ENV_PREFIXES = ['CLAY_CLI_', 'CLAY_AGENT_'];

export function isAgentKey(key) {
  return KEY_PATTERN.test(String(key ?? ''));
}

export function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function configRoot(env) {
  if (process.platform === 'win32') {
    return env.APPDATA || path.join(homeDir(env), 'AppData', 'Roaming');
  }
  return env.XDG_CONFIG_HOME || path.join(homeDir(env), '.config');
}

export function configDir(env = process.env) {
  return path.join(configRoot(env), FOLDER);
}

export function credentialsPath(env = process.env) {
  return path.join(configDir(env), 'credentials.json');
}

function credentialsPaths(env) {
  return [credentialsPath(env), path.join(configRoot(env), OLD_FOLDER, 'credentials.json')];
}

function fromEnv(env, suffix) {
  for (const prefix of ENV_PREFIXES) {
    const name = prefix + suffix;
    const value = String(env[name] ?? '').trim();
    if (value) return { name, value };
  }
  return null;
}

function httpsOnly() {
  return new ClayError('invalid-argument', 'The hyperclay URL must use https.', {
    hint: 'Use https://hyperclay.com, or http only for localhost.',
  });
}

function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
}

export function baseUrl({ flag, env = process.env } = {}) {
  const base = flag || fromEnv(env, 'URL')?.value || DEFAULT_BASE;
  let url;
  try {
    url = new URL(String(base));
  } catch {
    throw httpsOnly();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpsOnly();
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) throw httpsOnly();
  return String(base).replace(/\/+$/, '');
}

function unreadable(file) {
  return new ClayError('key-missing', `claycli could not read ${file}.`, {
    hint: 'Fix or delete that file, then run `claycli login` again.',
  });
}

async function readStore(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw unreadable(file);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw unreadable(file);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw unreadable(file);
  return data;
}

async function writeStore(file, data) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const temp = path.join(dir, `.credentials-${process.pid}-${Date.now()}.json`);
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temp, 0o600);
  await fs.rename(temp, file);
}

function checkedKey(key, source) {
  if (!isAgentKey(key)) {
    throw new ClayError('invalid-key', `${source} is not a valid agent key.`, {
      hint: 'Copy the key again from the dashboard; it is hcak_ followed by 64 lowercase letters and digits on one line.',
    });
  }
  return key;
}

export async function readKey(base, env = process.env) {
  if (base === baseUrl({ env })) {
    const variable = fromEnv(env, 'KEY');
    if (variable) return checkedKey(variable.value, variable.name);
  }
  for (const file of credentialsPaths(env)) {
    const key = (await readStore(file))?.hosts?.[base]?.key;
    if (typeof key === 'string' && key) return checkedKey(key.trim(), 'The saved key');
  }
  return null;
}

export async function saveKey(base, key, env = process.env) {
  if (!isAgentKey(key)) {
    throw new ClayError('invalid-key', 'That is not an agent key. Copy it from the dashboard: it starts with hcak_.');
  }
  const file = credentialsPath(env);
  const existing = await readStore(file);
  await writeStore(file, { v: 1, hosts: { ...(existing?.hosts || {}), [base]: { key } } });
}

// Sign-out clears the key from every file it can read before it reports one it could not.
export async function removeKey(base, env = process.env) {
  let removed = false;
  let failure = null;
  for (const file of credentialsPaths(env)) {
    try {
      const existing = await readStore(file);
      if (!existing?.hosts || !(base in existing.hosts)) continue;
      delete existing.hosts[base];
      await writeStore(file, { v: 1, hosts: existing.hosts });
      removed = true;
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return removed;
}
