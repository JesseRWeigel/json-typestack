// Sample inference. Builds one TypeSet per position in the document tree by folding
// every sample into it, keeping the counts that later let us decide optional vs required.
//
// A TypeSet records, for one position:
//   count            how many values were observed here at all
//   scalars          how many of each JSON scalar kind
//   object           the merged object shape, if an object was ever seen here
//   array            the merged array shape, if an array was ever seen here
//
// Optionality is a property of a FIELD, not of a type: field.present < object.count.
// Nullability is a property of the TYPE: scalars.null > 0. They are stored separately
// and stay separate all the way to the four emitters.

export function jtsNewTypeSet() {
  return {
    count: 0,
    scalars: { string: 0, number: 0, integer: 0, boolean: 0, null: 0 },
    maxStringLength: 0,
    intMin: null,
    intMax: null,
    object: null, // { count, fields: Map<key, {present, type}> , emptyCount }
    array: null, // { count, element: TypeSet, emptyCount }
  };
}

// Guard against self-referential input. JSON.parse output cannot be cyclic, but the
// browser page and library callers can hand us a live object graph.
const JTS_MAX_DEPTH = 200;

export function jtsObserve(ts, value, depth = 0) {
  if (depth > JTS_MAX_DEPTH) {
    throw new Error(`sample nests deeper than ${JTS_MAX_DEPTH} levels`);
  }
  ts.count += 1;
  if (value === null) {
    ts.scalars.null += 1;
    return ts;
  }
  const t = typeof value;
  if (t === 'boolean') {
    ts.scalars.boolean += 1;
    return ts;
  }
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite numbers are not valid JSON');
    if (Number.isInteger(value)) {
      ts.scalars.integer += 1;
      ts.intMin = ts.intMin === null ? value : Math.min(ts.intMin, value);
      ts.intMax = ts.intMax === null ? value : Math.max(ts.intMax, value);
    } else {
      ts.scalars.number += 1;
    }
    return ts;
  }
  if (t === 'string') {
    ts.scalars.string += 1;
    if (value.length > ts.maxStringLength) ts.maxStringLength = value.length;
    return ts;
  }
  if (Array.isArray(value)) {
    if (!ts.array) ts.array = { count: 0, emptyCount: 0, element: jtsNewTypeSet() };
    ts.array.count += 1;
    if (value.length === 0) ts.array.emptyCount += 1;
    for (const el of value) jtsObserve(ts.array.element, el, depth + 1);
    return ts;
  }
  if (t === 'object') {
    if (!ts.object) ts.object = { count: 0, fields: new Map() };
    ts.object.count += 1;
    for (const key of Object.keys(value)) {
      let field = ts.object.fields.get(key);
      if (!field) {
        field = { present: 0, type: jtsNewTypeSet() };
        ts.object.fields.set(key, field);
      }
      field.present += 1;
      jtsObserve(field.type, value[key], depth + 1);
    }
    return ts;
  }
  throw new Error(`value of type ${t} is not representable in JSON`);
}

// Codepoint order, locale independent. Every emitter sorts fields through this, which is
// what makes output independent of the key order in the input.
export function jtsCompareKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function jtsSortedFields(objectShape) {
  return [...objectShape.fields.keys()]
    .sort(jtsCompareKeys)
    .map((key) => ({ key, ...objectShape.fields.get(key) }));
}

export function jtsIsOptional(objectShape, field) {
  return field.present < objectShape.count;
}

export function jtsIsNullable(ts) {
  return ts.scalars.null > 0;
}

// The non-null members of a TypeSet, in canonical order. Canonical order is fixed so that
// a union renders the same regardless of which sample happened to arrive first.
// Order: boolean, number, string, array, object.
export function jtsMembers(ts) {
  const out = [];
  if (ts.scalars.boolean > 0) out.push('boolean');
  if (ts.scalars.number > 0) out.push('number');
  else if (ts.scalars.integer > 0) out.push('integer');
  if (ts.scalars.string > 0) out.push('string');
  if (ts.array) out.push('array');
  if (ts.object) out.push('object');
  return out;
}

// True when nothing at all was observed here, which happens only for the element type of
// an array that was always empty.
export function jtsIsUnknown(ts) {
  return ts.count === 0;
}

// An object shape with no fields at all: `{}` appeared in every sample.
export function jtsIsEmptyObject(ts) {
  return !!ts.object && ts.object.fields.size === 0;
}

export function jtsInfer(samples) {
  if (!Array.isArray(samples)) throw new Error('samples must be an array');
  if (samples.length === 0) throw new Error('need at least one sample');
  samples.forEach((s, i) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error(`sample ${i} is not a JSON object (got ${s === null ? 'null' : Array.isArray(s) ? 'array' : typeof s})`);
    }
  });
  const root = jtsNewTypeSet();
  for (const s of samples) jtsObserve(root, s);
  return root;
}
