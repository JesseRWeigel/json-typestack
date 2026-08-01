// Optional and nullable are the pair everybody conflates, so they get their own file.
//
//   optional  the key can be missing            email?: string
//   nullable  the key is there, value is null   email: string | null
//   both      email?: string | null
//
// Three different fields, three different renderings, in all four outputs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { jtsGenerate } from '../src/index.js';

// `opt` is missing from one sample. `nul` is present in every sample but null in one.
// `both` is missing from one and null in another.
const SAMPLES = [
  { keep: 'x', opt: 'a', nul: 'a', both: 'a' },
  { keep: 'x', nul: null, both: null },
  { keep: 'x', opt: 'c', nul: 'c' },
];

test('nullable renders differently from optional in TypeScript', () => {
  const g = jtsGenerate(SAMPLES, { name: 'T' });
  assert.match(g.ts, /^ {2}opt\?: string;$/m);
  assert.match(g.ts, /^ {2}nul: string \| null;$/m);
  assert.match(g.ts, /^ {2}both\?: string \| null;$/m);
  assert.match(g.ts, /^ {2}keep: string;$/m);
});

test('nullable renders differently from optional in Zod', () => {
  const g = jtsGenerate(SAMPLES, { name: 'T' });
  assert.match(g.zod, /^ {2}opt: z\.string\(\)\.optional\(\),$/m);
  assert.match(g.zod, /^ {2}nul: z\.string\(\)\.nullable\(\),$/m);
  assert.match(g.zod, /^ {2}both: z\.string\(\)\.nullable\(\)\.optional\(\),$/m);
  assert.match(g.zod, /^ {2}keep: z\.string\(\),$/m);
});

test('nullable renders differently from optional in JSON Schema', () => {
  const s = jtsGenerate(SAMPLES, { name: 'T' }).jsonschemaObject;
  // optional: absent from required, type unchanged
  assert.ok(!s.required.includes('opt'));
  assert.deepEqual(s.properties.opt, { type: 'string' });
  // nullable: present in required, "null" added to the type
  assert.ok(s.required.includes('nul'));
  assert.deepEqual(s.properties.nul, { type: ['string', 'null'] });
  // both: absent from required AND null in the type
  assert.ok(!s.required.includes('both'));
  assert.deepEqual(s.properties.both, { type: ['string', 'null'] });
  assert.deepEqual(s.required, ['keep', 'nul']);
});

test('optional and nullable both make a Postgres column nullable, and the DDL says which', () => {
  const g = jtsGenerate(SAMPLES, { name: 'T' });
  // The distinction cannot survive into a row, so the comment carries it instead.
  assert.match(g.sql, /^ {2}"opt" text,? -- optional: absent from at least one sample$/m);
  assert.match(g.sql, /^ {2}"nul" text,? -- always present, but null in at least one sample$/m);
  assert.match(g.sql, /^ {2}"both" text,? -- optional AND nullable in the source samples$/m);
  assert.match(g.sql, /^ {2}"keep" text NOT NULL,?$/m);
});

test('a nullable field is not reported as optional', () => {
  const onlyNullable = jtsGenerate(
    [{ a: 'x' }, { a: null }],
    { name: 'T' }
  );
  assert.deepEqual(onlyNullable.jsonschemaObject.required, ['a']);
  assert.doesNotMatch(onlyNullable.ts, /a\?:/);
  assert.doesNotMatch(onlyNullable.zod, /\.optional\(\)/);
});

test('an optional field is not reported as nullable', () => {
  const onlyOptional = jtsGenerate([{ a: 'x' }, {}], { name: 'T' });
  assert.doesNotMatch(onlyOptional.ts, /null/);
  assert.doesNotMatch(onlyOptional.zod, /\.nullable\(\)/);
  assert.deepEqual(onlyOptional.jsonschemaObject.properties.a, { type: 'string' });
});

test('optional and nullable produce different output from each other', () => {
  const opt = jtsGenerate([{ a: 'x' }, {}], { name: 'T' });
  const nul = jtsGenerate([{ a: 'x' }, { a: null }], { name: 'T' });
  for (const target of ['ts', 'zod', 'jsonschema', 'sql']) {
    assert.notEqual(opt[target], nul[target], `${target} cannot tell optional from nullable`);
  }
});

test('a field that is only ever null gets a null type, not a missing one', () => {
  const g = jtsGenerate([{ a: null }, { a: null }], { name: 'T' });
  assert.match(g.ts, /^ {2}a: null;$/m);
  assert.match(g.zod, /^ {2}a: z\.null\(\),$/m);
  assert.deepEqual(g.jsonschemaObject.properties.a, { type: 'null' });
  assert.match(g.sql, /"a" text,? -- only null was observed for this field$/m);
});

test('a nullable nested object keeps both the reference and the null', () => {
  const g = jtsGenerate([{ a: { b: 1 } }, { a: null }], { name: 'T' });
  assert.match(g.ts, /^ {2}a: TA \| null;$/m);
  assert.match(g.zod, /^ {2}a: TA\.nullable\(\),$/m);
  assert.deepEqual(g.jsonschemaObject.properties.a, {
    anyOf: [{ $ref: '#/$defs/TA' }, { type: 'null' }],
  });
  // jsonb holds JSON null as a value distinct from SQL NULL, so the CHECK allows it.
  assert.match(g.sql, /jsonb_typeof\("a"\) IN \('object', 'null'\)/);
});
