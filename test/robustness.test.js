// Shapes that crash naive generators: nothing to infer from, nothing inside, too deep,
// and too wide. Each of these must produce usable output rather than an exception.

import test from 'node:test';
import assert from 'node:assert/strict';
import { jtsGenerate, jtsParseSamples } from '../src/index.js';

test('an array that is always empty gives unknown[] rather than a guess', () => {
  const g = jtsGenerate([{ xs: [] }, { xs: [] }], { name: 'T' });
  assert.match(g.ts, /xs: unknown\[\];/);
  assert.match(g.zod, /xs: z\.array\(z\.unknown\(\)\),/);
  assert.deepEqual(g.jsonschemaObject.properties.xs, { type: 'array' });
  assert.match(g.sql, /"xs" jsonb NOT NULL/);
  assert.deepEqual(g.fixturesObject.full, { xs: [] });
});

test('an empty array in one sample and a populated one in another uses the populated type', () => {
  const g = jtsGenerate([{ xs: [] }, { xs: ['a'] }], { name: 'T' });
  assert.match(g.ts, /xs: string\[\];/);
});

test('an object that is always empty becomes an open record, not an empty interface', () => {
  // `interface Empty {}` in TypeScript accepts every non-null value, which would be a lie.
  const g = jtsGenerate([{ meta: {} }, { meta: {} }], { name: 'T' });
  assert.match(g.ts, /meta: Record<string, unknown>;/);
  assert.doesNotMatch(g.ts, /interface TMeta/);
  assert.match(g.zod, /meta: z\.record\(z\.string\(\), z\.unknown\(\)\),/);
  assert.deepEqual(g.jsonschemaObject.properties.meta, { type: 'object' });
});

test('a root object with no fields at all still produces all five outputs', () => {
  const g = jtsGenerate([{}, {}], { name: 'T' });
  assert.match(g.ts, /export type T = Record<string, unknown>;/);
  assert.match(g.zod, /export const T = z\.record\(z\.string\(\), z\.unknown\(\)\);/);
  assert.deepEqual(g.jsonschemaObject, {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'T',
    type: 'object',
    additionalProperties: true,
  });
  assert.match(g.sql, /"document" jsonb NOT NULL/);
  assert.deepEqual(g.fixturesObject.full, {});
});

test('deep nesting does not blow the stack', () => {
  let deep = { leaf: 1 };
  for (let i = 0; i < 120; i += 1) deep = { n: deep };
  const g = jtsGenerate([deep], { name: 'D' });
  assert.match(g.ts, /export interface D \{\n {2}n: DN;\n\}/);
  // 120 wrappers plus the innermost object that holds `leaf`.
  assert.equal((g.ts.match(/export interface /g) || []).length, 121);
});

test('nesting past the depth limit fails loudly instead of overflowing the stack', () => {
  let deep = { leaf: 1 };
  for (let i = 0; i < 400; i += 1) deep = { n: deep };
  assert.throws(() => jtsGenerate([deep], { name: 'D' }), /nests deeper than/);
});

test('a 5000-key object is handled, and the DDL warns that Postgres cannot take it', () => {
  const wide = {};
  for (let i = 0; i < 5000; i += 1) wide[`key_${i}`] = i;
  const started = Date.now();
  const g = jtsGenerate([wide, wide], { name: 'Wide' });
  const elapsed = Date.now() - started;
  assert.equal(Object.keys(g.jsonschemaObject.properties).length, 5000);
  assert.equal((g.ts.match(/^ {2}key_\d+: number;$/gm) || []).length, 5000);
  assert.match(g.sql, /WARNING: 5000 columns\. Postgres allows at most 1600/);
  assert.ok(elapsed < 20000, `took ${elapsed}ms`);
});

test('a table at exactly the Postgres column limit is not warned about', () => {
  const wide = {};
  for (let i = 0; i < 1600; i += 1) wide[`key_${i}`] = i;
  const g = jtsGenerate([wide], { name: 'Wide' });
  assert.doesNotMatch(g.sql, /WARNING/);
});

test('non-object samples are rejected with a message naming the offender', () => {
  assert.throws(() => jtsGenerate([{ a: 1 }, 5], { name: 'T' }), /sample 1 is not a JSON object \(got number\)/);
  assert.throws(() => jtsGenerate([[1, 2]], { name: 'T' }), /sample 0 is not a JSON object \(got array\)/);
  assert.throws(() => jtsGenerate([null], { name: 'T' }), /sample 0 is not a JSON object \(got null\)/);
  assert.throws(() => jtsGenerate([], { name: 'T' }), /need at least one sample/);
});

test('input can be one object, an array of objects, or NDJSON', () => {
  assert.deepEqual(jtsParseSamples('{"a":1}'), [{ a: 1 }]);
  assert.deepEqual(jtsParseSamples('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(jtsParseSamples('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  assert.throws(() => jtsParseSamples('   '), /empty input/);
  assert.throws(() => jtsParseSamples('{oops}'), /input:/);
});

test('unicode keys and values survive intact', () => {
  const g = jtsGenerate([{ 'ключ': 'значение', '絵文字🙂': 1 }], { name: 'T' });
  assert.match(g.ts, /"ключ": string;/);
  assert.match(g.sql, /"ключ" text NOT NULL/);
  assert.ok('絵文字🙂' in g.jsonschemaObject.properties);
});
