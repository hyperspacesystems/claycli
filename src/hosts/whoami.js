import { ClayError, asClayError, redact } from '../errors.js';

const TIMEOUT_MS = 30000;

function isTimeout(error) {
  return error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError';
}

export async function whoami(base, key) {
  let response;
  try {
    response = await fetch(`${base}/_/agent/v1/whoami`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeout(error)) {
      throw new ClayError('host-unavailable', 'The host did not answer in time.', {
        hint: 'Check your connection, then try again.',
        retryable: true,
      });
    }
    throw asClayError(error?.cause ?? error);
  }

  if (response.status === 200) {
    try {
      return await response.json();
    } catch (error) {
      throw asClayError(error);
    }
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const error = body?.error;
  if (error?.code) {
    throw new ClayError(error.code, redact(error.message || 'The host refused this agent key.'), {
      status: response.status,
    });
  }

  if (response.status === 404) {
    throw new ClayError('not-found', 'This host does not have agent keys turned on.');
  }

  throw new ClayError('internal', redact(`The host answered with ${response.status}.`), {
    status: response.status,
  });
}
