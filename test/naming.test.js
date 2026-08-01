// Illegal identifiers and the nested-type naming scheme.
//
// A JSON key can be `2fa`, `my-field`, `class`, `SELECT` or the empty string. TypeScript,
// JavaScript, JSON Schema and Postgres each have different rules about that, and the four
// outputs have to stay usable in all four languages.

import test from 'node:test';
import assert from 'node:assert/strict';
import { jtsGenerate } from '../src/index.js';
import { jtsPgColumnNames, jtsPgTableName, jtsRootTypeName, jtsJsKey } from '../src/naming.js';

const AWKWARD = [
  { '2fa': true, 'my-field': 'x', class: 1, '': 'empty', 'ok_key': 1, 'SELECT': 'v', 'a b': 1, 'a"b': 1 },
];

test('keys that are not JS identifiers are quoted in TypeScript and Zod', () => {
  const g = jtsGenerate(AWKWARD, { name: 'T' });
  assert.match(g.ts, /^ {2}"2fa": boolean;$/m);
  assert.match(g.ts, /^ {2}"my-field": string;$/m);
  assert.match(g.ts, /^ {2}"": string;$/m);
  assert.match(g.ts, /^ {2}"a b": number;$/m);
  assert.match(g.ts, /^ {2}"a\\"b": number;$/m);
  // A reserved word is a perfectly legal property name and must NOT be mangled.
  assert.match(g.ts, /^ {2}class: number;$/m);
  assert.match(g.ts, /^ {2}ok_key: number;$/m);
  assert.match(g.zod, /^ {2}"my-field": z\.string\(\),$/m);
  assert.match(g.zod, /^ {2}class: z\.number\(\)\.int\(\),$/m);
});

test('JSON Schema carries awkward keys verbatim', () => {
  const s = jtsGenerate(AWKWARD, { name: 'T' }).jsonschemaObject;
  for (const k of ['2fa', 'my-field', 'class', '', 'SELECT', 'a b', 'a"b']) {
    assert.ok(k in s.properties, `property ${JSON.stringify(k)} missing`);
    assert.ok(s.required.includes(k));
  }
});

test('Postgres keeps every legal key exactly, quoted, and renames only the empty one', () => {
  const g = jtsGenerate(AWKWARD, { name: 'T' });
  assert.match(g.sql, /^ {2}"2fa" boolean NOT NULL,$/m);
  assert.match(g.sql, /^ {2}"my-field" text NOT NULL,$/m);
  assert.match(g.sql, /^ {2}"class" integer NOT NULL,$/m);
  assert.match(g.sql, /^ {2}"SELECT" text NOT NULL,$/m);
  assert.match(g.sql, /^ {2}"a b" integer NOT NULL,$/m);
  assert.match(g.sql, /^ {2}"a""b" integer NOT NULL,$/m);
  assert.match(
    g.sql,
    /^ {2}"column" text NOT NULL, -- from JSON key "": the empty string is not a legal Postgres identifier$/m
  );
});

test('column names longer than 63 bytes are truncated and de-duplicated', () => {
  const long = 'k'.repeat(70);
  const mapped = jtsPgColumnNames([`${long}A`, `${long}B`, '', '']);
  assert.equal(mapped[0].column.length, 63);
  assert.equal(mapped[1].column.length, 63);
  assert.notEqual(mapped[0].column, mapped[1].column);
  assert.match(mapped[1].reason, /collided/);
  assert.equal(mapped[2].column, 'column');
  assert.equal(mapped[3].column, 'column2');
  assert.equal(new Set(mapped.map((m) => m.column)).size, 4);
});

test('multi-byte keys are truncated on a byte budget, not a character count', () => {
  // Three bytes per character, so 21 of them is 63 bytes and 22 is 66.
  const mapped = jtsPgColumnNames(['あ'.repeat(22)]);
  assert.equal(mapped[0].column, 'あ'.repeat(21));
  assert.equal(Buffer.byteLength(mapped[0].column, 'utf8'), 63);
});

test('nested types are named after their path', () => {
  const g = jtsGenerate(
    [{ address: { geo: { lat: 1 } }, orders: [{ lineItems: [{ sku: 'a' }] }] }],
    { name: 'User' }
  );
  for (const n of ['User', 'UserAddress', 'UserAddressGeo', 'UserOrdersItem', 'UserOrdersItemLineItemsItem']) {
    assert.match(g.ts, new RegExp(`^export interface ${n} \\{$`, 'm'), `missing interface ${n}`);
  }
});

test('two keys that sanitise to the same type name do not collide', () => {
  const g = jtsGenerate([{ 'foo-bar': { a: 1 }, foo_bar: { b: 1 } }], { name: 'T' });
  assert.match(g.ts, /^export interface TFooBar \{$/m);
  assert.match(g.ts, /^export interface TFooBar2 \{$/m);
  const names = [...g.ts.matchAll(/^export interface (\w+) \{$/gm)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length, 'duplicate interface name emitted');
});

test('a root name that is empty or starts with a digit becomes a legal type name', () => {
  assert.equal(jtsRootTypeName(''), 'Root');
  assert.equal(jtsRootTypeName('   '), 'Root');
  assert.equal(jtsRootTypeName('2fa'), 'T2fa');
  assert.equal(jtsRootTypeName('user profile'), 'UserProfile');
  assert.equal(jtsRootTypeName('my-type'), 'MyType');
});

test('the table name is snake_case and quoted, so reserved words are fine', () => {
  assert.equal(jtsPgTableName('UserProfile'), 'user_profile');
  assert.equal(jtsPgTableName('User'), 'user');
  const g = jtsGenerate([{ a: 1 }], { name: 'User' });
  assert.match(g.sql, /^CREATE TABLE "user" \($/m);
});

test('jtsJsKey quotes exactly what needs quoting', () => {
  assert.equal(jtsJsKey('ok'), 'ok');
  assert.equal(jtsJsKey('$ok'), '$ok');
  assert.equal(jtsJsKey('_ok'), '_ok');
  assert.equal(jtsJsKey('class'), 'class');
  assert.equal(jtsJsKey('2fa'), '"2fa"');
  assert.equal(jtsJsKey(''), '""');
  assert.equal(jtsJsKey('a-b'), '"a-b"');
});

test('the generated TypeScript and Zod contain no unquoted illegal identifier', () => {
  const g = jtsGenerate(AWKWARD, { name: 'T' });
  // Every property line must be `  <ident>` or `  "<quoted>"`.
  for (const src of [g.ts, g.zod]) {
    for (const line of src.split('\n')) {
      const m = /^ {2}([^:]+)[?]?:/.exec(line);
      if (!m) continue;
      const key = m[1].replace(/\?$/, '');
      assert.ok(
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) || /^".*"$/.test(key),
        `illegal unquoted key: ${JSON.stringify(key)}`
      );
    }
  }
});
