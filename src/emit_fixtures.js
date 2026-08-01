// Example fixture generator.
//
// Three fixtures come out of every run, and all three must validate against the schemas
// generated from the same samples:
//
//   minimal  only the required keys, non-null values
//   full     every key, non-null values wherever a non-null type was observed
//   nulls    every key, null wherever null is allowed
//
// A generator that emits fixtures its own schema rejects is a common bug, so verify
// checks all three against Zod, JSON Schema and the Postgres DDL.

import { jtsSortedFields, jtsMembers, jtsIsNullable, jtsIsOptional, jtsIsUnknown, jtsIsEmptyObject } from './model.js';

function jtsExampleFor(ts, mode) {
  if (jtsIsUnknown(ts)) return null;
  const members = jtsMembers(ts);
  const nullable = jtsIsNullable(ts);
  if (members.length === 0) return null; // only null was ever observed
  if (mode === 'nulls' && nullable) return null;

  switch (members[0]) {
    case 'boolean':
      return true;
    case 'integer':
      return 1;
    case 'number':
      return 1.5;
    case 'string':
      return 'example';
    case 'array': {
      const el = ts.array.element;
      if (jtsIsUnknown(el)) return [];
      return [jtsExampleFor(el, mode)];
    }
    case 'object':
      return jtsIsEmptyObject(ts) ? {} : jtsObjectExample(ts.object, mode);
    default:
      throw new Error(`unknown member ${members[0]}`);
  }
}

function jtsObjectExample(shape, mode) {
  const out = {};
  for (const f of jtsSortedFields(shape)) {
    if (mode === 'minimal' && jtsIsOptional(shape, f)) continue;
    out[f.key] = jtsExampleFor(f.type, mode);
  }
  return out;
}

export function jtsBuildFixtures(rootTs) {
  const shape = rootTs.object ?? { count: 1, fields: new Map() };
  return {
    minimal: jtsObjectExample(shape, 'minimal'),
    full: jtsObjectExample(shape, 'full'),
    nulls: jtsObjectExample(shape, 'nulls'),
  };
}

export function jtsEmitFixtures(rootTs) {
  return `${JSON.stringify(jtsBuildFixtures(rootTs), null, 2)}\n`;
}
