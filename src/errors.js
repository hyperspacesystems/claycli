// One error type for both front doors. The MCP server turns it into `isError` with
// `{ error: { code, message, hint } }`; the CLI prints it and exits with `exitCode(code)`.

export class ClayError extends Error {
  constructor(code, message, { hint = null, status = null, etag = null, retryable = false, details = null } = {}) {
    super(message);
    this.name = 'ClayError';
    this.code = code;
    this.hint = hint;
    this.status = status;
    this.etag = etag;
    this.retryable = retryable;
    this.details = details;
  }

  toJSON() {
    const error = { code: this.code, message: this.message };
    if (this.hint) error.hint = this.hint;
    if (this.status) error.status = this.status;
    if (this.etag) error.etag = this.etag;
    if (this.retryable) error.retryable = true;
    if (this.details) error.details = this.details;
    return redact({ error });
  }
}

const KEY_PATTERN = /hcak_[0-9a-f]{64}/gi;

function redactString(text) {
  return text.replace(KEY_PATTERN, (key) => `${key.slice(0, 13)}\u2026`);
}

// A key never reaches output: keep the prefix the dashboard shows, drop the rest.
export function redact(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [name, item] of Object.entries(value)) {
      result[redactString(name)] = redact(item);
    }
    return result;
  }
  return value;
}

// 0 done, 1 refused or failed, 2 conflict, 3 host unreachable,
// 4 not signed in or bad key, 5 outcome unknown.
const EXIT = {
  conflict: 2,
  'host-unavailable': 3,
  unauthorized: 4,
  'key-missing': 4,
  'key-revoked': 4,
  'key-expired': 4,
  'invalid-key': 4,
  'outcome-unknown': 5,
};

export function exitCode(code) {
  return EXIT[code] ?? 1;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

function isNetworkError(error) {
  for (const code of [error?.code, error?.cause?.code]) {
    if (typeof code !== 'string') continue;
    if (NETWORK_CODES.has(code) || code.startsWith('UND_ERR_')) return true;
  }
  return false;
}

export function asClayError(error) {
  if (error instanceof ClayError) return error;
  if (isNetworkError(error)) {
    return new ClayError('host-unavailable', 'Could not reach the host.', {
      hint: 'Check your internet connection, or open the desktop app if this is a local file, then try again.',
      retryable: true,
    });
  }
  return new ClayError('internal', 'Something went wrong inside claycli.');
}
