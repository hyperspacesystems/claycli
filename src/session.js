export function createSession({ maxBytes = 64 * 1024 * 1024 } = {}) {
  const caches = new Map();
  const seen = new Map();
  const whole = new Map();

  function touchCache(ref, entry) {
    caches.delete(ref);
    caches.set(ref, entry);
  }

  function totalBytes() {
    let total = 0;
    for (const entry of caches.values()) {
      if (entry.html !== undefined) total += entry.html.length;
    }
    return total;
  }

  function evict() {
    while (totalBytes() > maxBytes && caches.size > 1) {
      const oldest = caches.keys().next().value;
      caches.delete(oldest);
    }
  }

  return {
    remember(ref, { etag, html }) {
      const entry = html === undefined ? { etag } : { etag, html };
      touchCache(ref, entry);
      evict();
    },

    latest(ref) {
      const entry = caches.get(ref);
      if (!entry) return null;
      const copy = { etag: entry.etag };
      if (entry.html !== undefined) copy.html = entry.html;
      return copy;
    },

    htmlFor(ref, etag) {
      const entry = caches.get(ref);
      if (!entry || entry.etag !== etag) return null;
      return entry.html ?? null;
    },

    seenEtag(ref) {
      return seen.get(ref) ?? null;
    },

    markSeen(ref, etag) {
      seen.delete(ref);
      seen.set(ref, etag);
    },

    wholeEtag(ref) {
      return whole.get(ref) ?? null;
    },

    markWhole(ref, etag) {
      whole.delete(ref);
      whole.set(ref, etag);
    },

    clearWhole(ref) {
      whole.delete(ref);
    },
  };
}
