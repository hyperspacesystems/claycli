import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ClayError } from './errors.js';

export const DEFAULT_BASE = 'https://hyperclay.com';

const KEY_PATTERN = /^hcak_[0-9a-f]{64}$/;

export function isAgentKey(key) {
  return KEY_PATTERN.test(String(key ?? ''));
}

export function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function configDir(env = process.env) {
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(homeDir(env), 'AppData', 'Roaming'), 'clay-agent');
  }
  const root = env.XDG_CONFIG_HOME || path.join(homeDir(env), '.config');
  return path.join(root, 'clay-agent');
}

export function credentialsPath(env = process.env) {
  return path.join(configDir(env), 'credentials.json');
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
  const base = flag || env.CLAY_AGENT_URL || DEFAULT_BASE;
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

async function readStore(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ClayError('key-missing', 'clay-agent could not read its credentials file.', {
      hint: 'Run `clay-agent login` again.',
    });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ClayError('key-missing', 'clay-agent could not read its credentials file.', {
      hint: 'Run `clay-agent login` again.',
    });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ClayError('key-missing', 'clay-agent could not read its credentials file.', {
      hint: 'Run `clay-agent login` again.',
    });
  }
  return data;
}

async function writeStore(file, data, dir) {
  const temp = path.join(dir, `.credentials-${process.pid}-${Date.now()}.json`);
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temp, 0o600);
  await fs.rename(temp, file);
}

function checkedKey(key) {
  if (!isAgentKey(key)) {
    throw new ClayError('invalid-key', 'CLAY_AGENT_KEY is not a valid agent key.', {
      hint: 'Copy the key again from the dashboard; it is hcak_ followed by 64 lowercase letters and digits on one line.',
    });
  }
  return key;
}

export async function readKey(base, env = process.env) {
  if (base === baseUrl({ env }) && env.CLAY_AGENT_KEY) {
    const key = env.CLAY_AGENT_KEY.trim();
    if (key) return checkedKey(key);
  }
  const file = credentialsPath(env);
  const data = await readStore(file);
  if (!data) return null;
  const key = data.hosts?.[base]?.key;
  if (typeof key !== 'string' || !key) return null;
  return checkedKey(key.trim());
}

export async function saveKey(base, key, env = process.env) {
  if (!isAgentKey(key)) {
    throw new ClayError('invalid-key', 'That is not an agent key. Copy it from the dashboard: it starts with hcak_.');
  }
  const dir = configDir(env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const file = credentialsPath(env);
  const existing = await readStore(file);
  const data = {
    v: 1,
    hosts: { ...(existing?.hosts || {}) },
  };
  data.hosts[base] = { key };
  await writeStore(file, data, dir);
}

export async function removeKey(base, env = process.env) {
  const file = credentialsPath(env);
  const existing = await readStore(file);
  if (!existing?.hosts || !(base in existing.hosts)) return false;
  delete existing.hosts[base];
  const dir = configDir(env);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await writeStore(file, { v: 1, hosts: existing.hosts }, dir);
  return true;
}
