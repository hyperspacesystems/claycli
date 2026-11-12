import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSiteTarget } from '../src/site-target.js';

test('a site is a folder path, an address, or a folder ref', () => {
  assert.deepEqual(parseSiteTarget('demos/maya'), { path: 'demos/maya' });
  assert.deepEqual(parseSiteTarget('/demos/maya/'), { path: 'demos/maya' });
  assert.deepEqual(parseSiteTarget('hyperclay:42'), { id: '42' });
  assert.deepEqual(parseSiteTarget('https://maya.hyperclay.com'), { url: 'https://maya.hyperclay.com/' });
  assert.deepEqual(parseSiteTarget('https://ann.hyperclay.com/demos/maya/'), { url: 'https://ann.hyperclay.com/demos/maya/' });
});

test('a local folder, an empty name, a parent step or a key is refused', () => {
  for (const value of ['./maya', '../maya', '.', '~/maya', 'demos\\maya', '', '   ', 'demos/../maya', 'demos//maya', `hcak_${'a'.repeat(64)}`]) {
    assert.throws(() => parseSiteTarget(value), (error) => error.code === 'invalid-argument', value);
  }
});
