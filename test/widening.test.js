// Type widening across samples. The failure this guards against is "last sample wins",
// which looks fine on a single sample and quietly drops half the real type.

import test from 'node:test';
import assert from 'node:assert/strict';
import { jtsGenerate } from '../src/index.js';

test('number then string widens to a union, not to the last one seen', () => {
  const g = jtsGenerate([{ id: 1 }, { id: 'x' }], { name: 'T' });
  assert.match(g.ts, /^ {2}id: number \| string;$/m);
  assert.match(g.zod, /^ {2}id: z\.union\(\[z\.number\(\)\.int\(\), z\.string\(\)\]\),$/m);
  assert.deepEqual(g.jsonschemaObject.properties.id, { type: ['integer', 'string'] });
  assert.match(g.sql, /"id" jsonb NOT NULL, -- mixed types/);
});

test('string then number widens to the same union, so order does not decide the type', () => {
  const a = jtsGenerate([{ id: 1 }, { id: 'x' }], { name: 'T' });
  const b = jtsGenerate([{ id: 'x' }, { id: 1 }], { name: 'T' });
  assert.equal(a.ts, b.ts);
  assert.equal(a.zod, b.zod);
  assert.equal(a.jsonschema, b.jsonschema);
  assert.equal(a.sql, b.sql);
});

test('the union is not collapsed to the first sample either', () => {
  const g = jtsGenerate([{ id: 1 }, { id: 'x' }], { name: 'T' });
  assert.doesNotMatch(g.ts, /^ {2}id: number;$/m);
  assert.doesNotMatch(g.ts, /^ {2}id: string;$/m);
});

test('integer plus float widens to number, and integer alone stays integer', () => {
  const mixed = jtsGenerate([{ n: 1 }, { n: 1.5 }], { name: 'T' });
  assert.deepEqual(mixed.jsonschemaObject.properties.n, { type: 'number' });
  assert.match(mixed.zod, /n: z\.number\(\),/);
  assert.match(mixed.sql, /"n" double precision NOT NULL/);

  const ints = jtsGenerate([{ n: 1 }, { n: 2 }], { name: 'T' });
  assert.deepEqual(ints.jsonschemaObject.properties.n, { type: 'integer' });
  assert.match(ints.zod, /n: z\.number\(\)\.int\(\),/);
  assert.match(ints.sql, /"n" integer NOT NULL/);
});

test('null plus string is nullable, which is not the same as a two-member union', () => {
  const nullable = jtsGenerate([{ a: 'x' }, { a: null }], { name: 'T' });
  const union = jtsGenerate([{ a: 'x' }, { a: 1 }], { name: 'T' });
  assert.match(nullable.ts, /a: string \| null;/);
  assert.match(union.ts, /a: number \| string;/);
  assert.notEqual(nullable.sql, union.sql);
  // The nullable one keeps a real text column; the union one has to fall back to jsonb.
  assert.match(nullable.sql, /"a" text\b/);
  assert.match(union.sql, /"a" jsonb\b/);
});

test('an array of mixed element shapes yields a union element, not unknown[]', () => {
  const g = jtsGenerate([{ xs: [1, 'a', true] }], { name: 'T' });
  assert.match(g.ts, /xs: \(boolean \| number \| string\)\[\];/);
  assert.match(g.zod, /xs: z\.array\(z\.union\(\[z\.boolean\(\), z\.number\(\)\.int\(\), z\.string\(\)\]\)\),/);
  assert.deepEqual(g.jsonschemaObject.properties.xs, {
    type: 'array',
    items: { type: ['boolean', 'integer', 'string'] },
  });
  assert.doesNotMatch(g.ts, /any/);
  assert.doesNotMatch(g.ts, /unknown\[\]/);
});

test('an array of objects with different keys merges into one element type', () => {
  const g = jtsGenerate([{ xs: [{ a: 1 }, { b: 2 }] }], { name: 'T' });
  assert.match(g.ts, /xs: TXsItem\[\];/);
  assert.match(g.ts, /export interface TXsItem \{\n {2}a\?: number;\n {2}b\?: number;\n\}/);
});

test('an array mixing objects and scalars keeps both branches', () => {
  const g = jtsGenerate([{ xs: [1, { a: 1 }] }], { name: 'T' });
  assert.match(g.ts, /xs: \(number \| TXsItem\)\[\];/);
  assert.deepEqual(g.jsonschemaObject.properties.xs, {
    type: 'array',
    items: { anyOf: [{ type: 'integer' }, { $ref: '#/$defs/TXsItem' }] },
  });
});

test('a field that is sometimes an object and sometimes a scalar keeps both', () => {
  const g = jtsGenerate([{ a: { b: 1 } }, { a: 'x' }], { name: 'T' });
  assert.match(g.ts, /a: string \| TA;/);
  assert.match(g.sql, /"a" jsonb NOT NULL, -- mixed types across samples \(string \| object\)/);
  assert.match(g.sql, /jsonb_typeof\("a"\) IN \('object', 'string'\)/);
});

test('int32 overflow moves the column to bigint, and further to numeric', () => {
  const small = jtsGenerate([{ n: 2147483647 }], { name: 'T' });
  assert.match(small.sql, /"n" integer/);
  const big = jtsGenerate([{ n: 2147483648 }], { name: 'T' });
  assert.match(big.sql, /"n" bigint NOT NULL,? -- values exceed the int32 range/);
  const huge = jtsGenerate([{ n: 1e300 }], { name: 'T' });
  assert.match(huge.sql, /"n" numeric NOT NULL,? -- values exceed the int64 safe range/);
});
