// Byte-identical output for the same input, and no dependence on the order keys happen
// to appear in. Both matter because the output is meant to be committed and diffed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { jtsGenerate } from '../src/index.js';

const TARGETS = ['ts', 'zod', 'jsonschema', 'sql', 'fixtures'];

const SAMPLES = [
  { id: 1, email: 'a@example.com', tags: ['x'], profile: { city: 'NY', zip: null } },
  { id: 'two', tags: [], profile: { city: 'LA' } },
  { id: 3, email: 'c@example.com', tags: ['y', 'z'], profile: { city: 'SF', zip: '3' } },
];

function permuteKeys(value, seed) {
  if (Array.isArray(value)) return value.map((v, i) => permuteKeys(v, seed + i));
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    // Deterministic rotation, so the test itself is reproducible.
    const rotated = keys.slice(seed % (keys.length || 1)).concat(keys.slice(0, seed % (keys.length || 1)));
    const out = {};
    for (const k of rotated) out[k] = permuteKeys(value[k], seed + 1);
    return out;
  }
  return value;
}

test('the same samples produce byte-identical output twice', () => {
  const a = jtsGenerate(SAMPLES, { name: 'User' });
  const b = jtsGenerate(SAMPLES, { name: 'User' });
  for (const t of TARGETS) assert.equal(a[t], b[t], `${t} differs between two runs`);
});

test('permuting key order inside every object does not change the output', () => {
  const base = jtsGenerate(SAMPLES, { name: 'User' });
  for (let seed = 1; seed <= 5; seed += 1) {
    const permuted = jtsGenerate(permuteKeys(SAMPLES, seed), { name: 'User' });
    for (const t of TARGETS) {
      assert.equal(permuted[t], base[t], `${t} changed when key order changed (seed ${seed})`);
    }
  }
});

test('the permuter actually reorders keys, or the test above proves nothing', () => {
  const permuted = permuteKeys(SAMPLES, 1);
  assert.notDeepEqual(Object.keys(permuted[0]), Object.keys(SAMPLES[0]));
  assert.deepEqual(
    [...Object.keys(permuted[0])].sort(),
    [...Object.keys(SAMPLES[0])].sort()
  );
});

test('reversing the sample order does not change the output', () => {
  const a = jtsGenerate(SAMPLES, { name: 'User' });
  const b = jtsGenerate([...SAMPLES].reverse(), { name: 'User' });
  for (const t of TARGETS) assert.equal(a[t], b[t], `${t} depends on sample order`);
});

test('output is sorted by key, so a new key lands in one place in the diff', () => {
  const g = jtsGenerate([{ zeta: 1, alpha: 2, mid: 3 }], { name: 'T' });
  const props = Object.keys(g.jsonschemaObject.properties);
  assert.deepEqual(props, ['alpha', 'mid', 'zeta']);
  const tsOrder = [...g.ts.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(tsOrder, ['alpha', 'mid', 'zeta']);
});
