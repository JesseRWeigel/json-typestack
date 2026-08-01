// One of the agreement expectations in test/scenarios.mjs says the JSON Schema layer
// ACCEPTS a document that is missing a required empty-string key. That is not a claim
// about the generated schema, which lists "" in `required` exactly as the spec says it
// should. It is a claim about ajv 8.x, which does not act on it.
//
// Pinning the third-party behaviour here means the expectation over in scenarios.mjs is
// falsifiable: if a later ajv starts enforcing it, this test fails and points at the line
// to flip. Without this, "ajv accepts it" would be an unexamined excuse.

import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { jtsGenerate } from '../src/index.js';

test('ajv does not enforce an empty-string entry in `required` (upstream limitation)', () => {
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile({
    type: 'object',
    properties: { '': { type: 'string' }, a: { type: 'string' } },
    required: ['', 'a'],
    additionalProperties: true,
  });
  assert.equal(validate({ '': 'x', a: 'y' }), true, 'present should validate');
  assert.equal(
    validate({ a: 'y' }),
    true,
    'ajv started enforcing required:[""] - flip the awkward[1] expectation in test/scenarios.mjs'
  );
  // The type constraint on the same property IS enforced, so the property itself is not
  // being ignored wholesale.
  assert.equal(validate({ '': 1, a: 'y' }), false);
});

test('the generated schema still lists the empty key as required', () => {
  // Whatever ajv does with it, the artefact we ship has to be right.
  const g = jtsGenerate([{ '': 'a', b: 1 }, { '': 'c', b: 2 }], { name: 'T' });
  assert.ok(g.jsonschemaObject.required.includes(''));
});

test('every other awkward key IS enforced by ajv', () => {
  const g = jtsGenerate(
    [
      { '2fa': true, 'my-field': 'x', class: 1, 'a b': 1 },
      { '2fa': false, 'my-field': 'y', class: 2, 'a b': 2 },
    ],
    { name: 'T' }
  );
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  const validate = ajv.compile(g.jsonschemaObject);
  assert.equal(validate({ '2fa': true, 'my-field': 'x', class: 1, 'a b': 1 }), true);
  for (const missing of ['2fa', 'my-field', 'class', 'a b']) {
    const doc = { '2fa': true, 'my-field': 'x', class: 1, 'a b': 1 };
    delete doc[missing];
    assert.equal(validate(doc), false, `ajv accepted a document missing ${missing}`);
  }
});
