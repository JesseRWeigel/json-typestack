// Naming and identifier legality.
//
// Every nested object gets its own named type. The name is derived from the PATH to that
// object, never from its contents, so two structurally identical objects at different
// paths stay distinct and a name never depends on traversal luck:
//
//   root type name              User
//   field `address`             UserAddress
//   field `orders`, an array    UserOrdersItem
//   `orders[].lineItems[]`      UserOrdersItemLineItemsItem
//
// Each object-key step contributes PascalCase(key); each step through an array
// contributes the literal `Item`.
//
// Sanitising can make two different paths collide (`foo-bar` and `foo_bar` both become
// `FooBar`). Collisions are resolved by appending 2, 3, ... in traversal order, which is
// depth-first over codepoint-sorted keys, so the assignment is deterministic.

import { jtsSortedFields, jtsIsEmptyObject } from './model.js';

// TypeScript / JavaScript identifier, conservative ASCII subset.
const JTS_JS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function jtsIsJsIdentifier(name) {
  return JTS_JS_IDENT.test(name);
}

// A JS object literal key that is not a plain identifier has to be quoted. `class` and
// other reserved words are legal as property names, so they are NOT quoted.
export function jtsJsKey(key) {
  return jtsIsJsIdentifier(key) ? key : JSON.stringify(key);
}

export function jtsPascal(key) {
  const parts = String(key).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return 'Field';
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

// The root name is the one place a leading digit or an empty string would produce an
// illegal type name, because nothing is prefixed in front of it.
export function jtsRootTypeName(raw) {
  const p = jtsPascal(raw === undefined || raw === null ? '' : raw);
  if (p === 'Field' && !String(raw ?? '').trim()) return 'Root';
  return /^[0-9]/.test(p) ? `T${p}` : p;
}

// Walks the tree and assigns a name to every object shape that has at least one field.
// Returns { byShape: Map<objectShape, name>, order: [{name, ts, shape}] } where `order`
// is the traversal order: root first, then depth first. Emitters that need dependencies
// first (Zod) reverse-sort it themselves.
export function jtsBuildNames(rootTs, rootName) {
  const byShape = new Map();
  const order = [];
  const used = new Set();

  const claim = (base) => {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let n = 2;
    while (used.has(`${base}${n}`)) n += 1;
    used.add(`${base}${n}`);
    return `${base}${n}`;
  };

  const walk = (ts, pathName) => {
    if (ts.object && !jtsIsEmptyObject(ts) && !byShape.has(ts.object)) {
      const name = claim(pathName);
      byShape.set(ts.object, name);
      order.push({ name, ts, shape: ts.object });
      for (const f of jtsSortedFields(ts.object)) {
        walk(f.type, `${name}${jtsPascal(f.key)}`);
      }
    } else if (ts.object && !jtsIsEmptyObject(ts)) {
      // Already named (only possible if the same shape object is reachable twice, which
      // the inference engine does not currently produce). Do not rename it.
    }
    if (ts.array) {
      // The array element inherits the array's own path plus `Item`.
      walk(ts.array.element, `${pathName}Item`);
    }
  };

  walk(rootTs, rootName);
  return { byShape, order };
}

// ---------------------------------------------------------------------------
// Postgres identifiers.
//
// Every generated identifier is double quoted, which means the JSON key can be carried
// through EXACTLY: `2fa`, `my-field`, `class`, `SELECT` and `Email` are all legal inside
// double quotes and keep their case. Only two things force a rename:
//   1. the empty string, which Postgres rejects as a zero-length delimited identifier
//   2. anything longer than 63 bytes, which Postgres silently truncates
// plus the collisions that truncation can create. Renames are reported so the DDL can
// carry a comment saying which JSON key each renamed column came from.

export const JTS_PG_NAME_LIMIT = 63;

function jtsUtf8Length(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

function jtsTruncateUtf8(s, limit) {
  if (jtsUtf8Length(s) <= limit) return s;
  let out = '';
  for (const ch of s) {
    if (jtsUtf8Length(out + ch) > limit) break;
    out += ch;
  }
  return out;
}

export function jtsQuotePgIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Maps a list of JSON keys to Postgres column names. Returns
// [{ key, column, renamed, reason }] in the order given.
export function jtsPgColumnNames(keys) {
  const used = new Set();
  const out = [];
  for (const key of keys) {
    let base = key;
    let reason = null;
    if (base === '') {
      base = 'column';
      reason = 'the empty string is not a legal Postgres identifier';
    } else if (jtsUtf8Length(base) > JTS_PG_NAME_LIMIT) {
      base = jtsTruncateUtf8(base, JTS_PG_NAME_LIMIT);
      reason = `longer than ${JTS_PG_NAME_LIMIT} bytes, which Postgres truncates`;
    }
    let column = base;
    if (used.has(column)) {
      let n = 2;
      const suffixRoom = (s) => jtsTruncateUtf8(base, JTS_PG_NAME_LIMIT - String(s).length) + s;
      while (used.has(suffixRoom(n))) n += 1;
      column = suffixRoom(n);
      reason = reason
        ? `${reason}, and the truncated name collided`
        : 'another key already claimed this column name';
    }
    used.add(column);
    out.push({ key, column, renamed: column !== key, reason });
  }
  return out;
}

// Table name: lower snake_case of the root type name. Quoted in the DDL, so reserved
// words such as `user` and `order` are fine.
export function jtsPgTableName(rootTypeName) {
  const snake = String(rootTypeName)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const name = snake || 'root';
  return jtsTruncateUtf8(name, JTS_PG_NAME_LIMIT);
}
