// JSON Schema emitter, draft 2020-12.
//
// optional  ->  the key is left out of the object's `required` array
// nullable  ->  "null" is added to the key's `type`
//
// Nested objects go in `$defs` under the same names the TypeScript output uses, so the
// two can be read side by side.
//
// `additionalProperties` is true, matching Zod's non-strict objects. Both therefore
// accept a sample with an extra key, which keeps the two in agreement.

import { jtsSortedFields, jtsMembers, jtsIsNullable, jtsIsOptional, jtsIsUnknown, jtsIsEmptyObject } from './model.js';

const JTS_SCALAR_JSON_TYPE = {
  boolean: 'boolean',
  integer: 'integer',
  number: 'number',
  string: 'string',
};

export function jtsJsonSchemaType(ts, names) {
  if (jtsIsUnknown(ts)) return {}; // nothing observed: accept anything
  const members = jtsMembers(ts);
  const nullable = jtsIsNullable(ts);

  if (members.length === 0) return { type: 'null' };

  const allScalar = members.every((m) => m in JTS_SCALAR_JSON_TYPE);
  if (allScalar) {
    const types = members.map((m) => JTS_SCALAR_JSON_TYPE[m]);
    if (nullable) types.push('null');
    return { type: types.length === 1 ? types[0] : types };
  }

  const branches = members.map((m) => {
    if (m in JTS_SCALAR_JSON_TYPE) return { type: JTS_SCALAR_JSON_TYPE[m] };
    if (m === 'array') {
      const el = jtsJsonSchemaType(ts.array.element, names);
      return Object.keys(el).length === 0
        ? { type: 'array' }
        : { type: 'array', items: el };
    }
    if (m === 'object') {
      return jtsIsEmptyObject(ts)
        ? { type: 'object' }
        : { $ref: `#/$defs/${names.byShape.get(ts.object)}` };
    }
    throw new Error(`unknown member ${m}`);
  });
  if (nullable) branches.push({ type: 'null' });
  return branches.length === 1 ? branches[0] : { anyOf: branches };
}

function jtsObjectSchema(ts, shape, names) {
  const properties = {};
  const required = [];
  for (const f of jtsSortedFields(shape)) {
    properties[f.key] = jtsJsonSchemaType(f.type, names);
    if (!jtsIsOptional(shape, f)) required.push(f.key);
  }
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  schema.additionalProperties = true;
  return schema;
}

export function jtsBuildJsonSchema(rootTs, names, opts = {}) {
  const rootName = opts.rootName ?? 'Root';
  const defs = {};
  for (const { name, ts, shape } of names.order) {
    if (name === rootName && ts === rootTs) continue;
    defs[name] = jtsObjectSchema(ts, shape, names);
  }
  const root =
    names.order.length > 0 && names.order[0].ts === rootTs
      ? jtsObjectSchema(rootTs, rootTs.object, names)
      : { type: 'object', additionalProperties: true };
  const out = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: rootName,
    ...root,
  };
  if (Object.keys(defs).length > 0) {
    // Sorted so the file is byte-stable regardless of traversal details.
    out.$defs = {};
    for (const k of Object.keys(defs).sort()) out.$defs[k] = defs[k];
  }
  return out;
}

export function jtsEmitJsonSchema(rootTs, names, opts = {}) {
  return `${JSON.stringify(jtsBuildJsonSchema(rootTs, names, opts), null, 2)}\n`;
}
