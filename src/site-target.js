import { ClayError } from './errors.js';

const SITE_HINT =
  'Name the site by its folder in your account (demos/maya), its address (https://maya.hyperclay.com), or hyperclay:<folder id>.';

export function parseSiteTarget(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ClayError('invalid-argument', 'Name a site.', { hint: SITE_HINT });
  if (text.includes('hcak_')) throw new ClayError('invalid-argument', 'Do not put an agent key in a site name.');
  const ref = /^hyperclay:(\d+)$/.exec(text);
  if (ref) return { id: ref[1] };
  if (/^https?:\/\//i.test(text)) {
    try {
      return { url: new URL(text).href };
    } catch {
      throw new ClayError('invalid-argument', 'That site address is not a URL.', { hint: SITE_HINT });
    }
  }
  if (/^\.{1,2}(\/|$)/.test(text) || text.startsWith('~') || text.includes('\\')) {
    throw new ClayError('invalid-argument', 'A site is a folder in your hyperclay.com account, not a folder on this computer.', {
      hint: SITE_HINT,
    });
  }
  const segments = text.replace(/^\/+|\/+$/g, '').split('/');
  if (!segments[0] || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ClayError('invalid-argument', 'That is not a folder path.', { hint: SITE_HINT });
  }
  return { path: segments.join('/') };
}
