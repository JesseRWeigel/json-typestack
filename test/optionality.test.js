// The whole reason this tool takes several samples: a field missing from any one of them
// is optional, and a field present in all of them is required. Both directions are
// asserted in all four outputs, so a generator that hard-codes either answer fails here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { jtsGenerate } from '../src/index.js';

const TWO_OF_THREE = [
  { id: 1, email: 'a@example.com' },
  { id: 2 },
  { id: 3, email: 'c@example.com' },
];

const THREE_OF_THREE = [
  { id: 1, email: 'a@example.com' },
  { id: 2, email: 'b@example.com' },
  { id: 3, email: 'c@example.com' },
];

test('a field present in 2 of 3 samples is optional in all four outputs', () => {
  const g = jtsGenerate(TWO_OF_THREE, { name: 'User' });
  assert.match(g.ts, /^ {2}email\?: string;$/m);
  assert.match(g.zod, /^ {2}email: z\.string\(\)\.optional\(\),$/m);
  assert.deepEqual(g.jsonschemaObject.required, ['id']);
  assert.ok(!g.jsonschemaObject.required.includes('email'));
  assert.match(g.sql, /^ {2}"email" text, -- optional: absent from at least one sample$/m);
});

test('a field present in 3 of 3 samples is required in all four outputs', () => {
  const g = jtsGenerate(THREE_OF_THREE, { name: 'User' });
  assert.match(g.ts, /^ {2}email: string;$/m);
  assert.doesNotMatch(g.ts, /email\?/);
  assert.match(g.zod, /^ {2}email: z\.string\(\),$/m);
  assert.doesNotMatch(g.zod, /email: z\.string\(\)\.optional/);
  assert.deepEqual(g.jsonschemaObject.required, ['email', 'id']);
  assert.match(g.sql, /^ {2}"email" text NOT NULL,?$/m);
});

test('one absent sample is enough to make a field optional', () => {
  const g = jtsGenerate([{ a: 1 }, { a: 1 }, { a: 1 }, { a: 1 }, {}], { name: 'T' });
  assert.match(g.ts, /a\?: number;/);
  assert.deepEqual(g.jsonschemaObject.required, undefined);
});

test('optionality inside a nested object is measured against that object, not the root', () => {
  // `address` appears twice; `city` appears in both of those, so city is REQUIRED even
  // though it is present in only 2 of 3 top-level samples.
  const g = jtsGenerate(
    [
      { id: 1, address: { city: 'NY', zip: '1' } },
      { id: 2 },
      { id: 3, address: { city: 'LA' } },
    ],
    { name: 'User' }
  );
  assert.match(g.ts, /^ {2}address\?: UserAddress;$/m);
  assert.match(g.ts, /^ {2}city: string;$/m); // 2 of 2 address objects
  assert.match(g.ts, /^ {2}zip\?: string;$/m); // 1 of 2 address objects
  assert.deepEqual(g.jsonschemaObject.$defs.UserAddress.required, ['city']);
});

test('optionality inside an array element is measured per element, not per sample', () => {
  const g = jtsGenerate(
    [
      { rows: [{ a: 1, b: 2 }, { a: 2 }] },
      { rows: [{ a: 3, b: 4 }] },
    ],
    { name: 'T' }
  );
  // three elements seen, `a` in all three, `b` in two
  assert.match(g.ts, /^ {2}a: number;$/m);
  assert.match(g.ts, /^ {2}b\?: number;$/m);
});

test('a single sample reports every field as required', () => {
  const g = jtsGenerate([{ a: 1, b: 2 }], { name: 'T' });
  assert.deepEqual(g.jsonschemaObject.required, ['a', 'b']);
});

test('the two directions produce different output for the same field name', () => {
  const optional = jtsGenerate(TWO_OF_THREE, { name: 'User' });
  const required = jtsGenerate(THREE_OF_THREE, { name: 'User' });
  for (const target of ['ts', 'zod', 'jsonschema', 'sql']) {
    assert.notEqual(
      optional[target],
      required[target],
      `${target} output is identical whether email is optional or required`
    );
  }
});
