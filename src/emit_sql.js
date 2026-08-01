// Postgres DDL emitter.
//
// Every mapping decision here is deliberate and is listed in the README. Summary:
//
//   string                -> text            (not varchar(n): the samples cannot tell you
//                                             a real maximum, and text is not slower)
//   integer, int32 range  -> integer
//   integer, int64 range  -> bigint
//   integer, wider        -> numeric
//   non-integer number    -> double precision (JSON numbers are IEEE 754 doubles once parsed)
//   boolean               -> boolean
//   object                -> jsonb           (no child table is invented)
//   array                 -> jsonb           (not text[]: arrays can be heterogeneous)
//   union of scalars      -> jsonb           (not text: text would lose the difference
//                                             between the number 1 and the string "1")
//   only null observed    -> text            (nothing to go on; column stays nullable)
//
// Nullability: a column is NOT NULL only when the field is required AND null was never
// observed. Optional and nullable both become "this column may be NULL", because a row
// has no way to express an absent column. That collapse is real and is the one place
// where the SQL output carries less information than the other three.
//
// Every jsonb column carries a CHECK on jsonb_typeof so the container kind is enforced
// rather than merely documented.

import { jtsSortedFields, jtsMembers, jtsIsNullable, jtsIsOptional, jtsIsEmptyObject } from './model.js';
import { jtsQuotePgIdent, jtsPgColumnNames, jtsPgTableName, jtsPgFitIdentifiers } from './naming.js';

export const JTS_PG_MAX_COLUMNS = 1600;

const JTS_INT32_MIN = -2147483648;
const JTS_INT32_MAX = 2147483647;

const JTS_JSONB_TYPEOF = {
  boolean: 'boolean',
  integer: 'number',
  number: 'number',
  string: 'string',
  array: 'array',
  object: 'object',
};

// Returns { type, checkKinds|null, note|null }
export function jtsPgColumnType(ts) {
  const members = jtsMembers(ts);
  if (members.length === 0) {
    return { type: 'text', checkKinds: null, note: 'only null was observed for this field' };
  }
  if (members.length === 1) {
    const m = members[0];
    if (m === 'boolean') return { type: 'boolean', checkKinds: null, note: null };
    if (m === 'string') return { type: 'text', checkKinds: null, note: null };
    if (m === 'number') return { type: 'double precision', checkKinds: null, note: null };
    if (m === 'integer') {
      const min = ts.intMin ?? 0;
      const max = ts.intMax ?? 0;
      if (min >= JTS_INT32_MIN && max <= JTS_INT32_MAX) {
        return { type: 'integer', checkKinds: null, note: null };
      }
      if (min >= Number.MIN_SAFE_INTEGER && max <= Number.MAX_SAFE_INTEGER) {
        return { type: 'bigint', checkKinds: null, note: 'values exceed the int32 range' };
      }
      return { type: 'numeric', checkKinds: null, note: 'values exceed the int64 safe range' };
    }
    if (m === 'array') {
      return { type: 'jsonb', checkKinds: ['array'], note: null };
    }
    if (m === 'object') {
      return {
        type: 'jsonb',
        checkKinds: ['object'],
        note: jtsIsEmptyObject(ts) ? 'no fields were ever present on this object' : null,
      };
    }
  }
  const kinds = [...new Set(members.map((m) => JTS_JSONB_TYPEOF[m]))].sort();
  return {
    type: 'jsonb',
    checkKinds: kinds,
    note: `mixed types across samples (${members.join(' | ')}); jsonb keeps them apart, text would not`,
  };
}

// A Postgres text literal. Plain quoting handles the ordinary case; a value carrying a
// control character or a backslash needs the E'' escape-string form, because a raw newline
// inside a literal would split the emitted DDL across lines. U+0000 is the one character
// with no representation at all: Postgres text and jsonb both reject it, which is why
// jtsPgUnloadableKeys exists.
const JTS_NUL = /\u0000/;
const JTS_NEEDS_ESCAPE_STRING = /[\u0000-\u001F\u007F\\]/;

function jtsPgLiteral(str) {
  const s = String(str);
  if (!JTS_NEEDS_ESCAPE_STRING.test(s)) return `'${s.replace(/'/g, "''")}'`;
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "'") out += "\\'";
    else if (ch === '\\') out += '\\\\';
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `E'${out}'`;
}

// Keys Postgres cannot carry at all. A U+0000 is rejected by both the text and the jsonb
// input functions, so no statement can name such a key and no document containing one can
// be cast to jsonb. The DDL warns about them by name rather than emitting SQL that fails.
export function jtsPgUnloadableKeys(rootTs) {
  const shape = rootTs.object;
  if (!shape) return [];
  return jtsSortedFields(shape).map((f) => f.key).filter((k) => JTS_NUL.test(k));
}

// The statement that loads one JSON document into the generated table.
//
// Without renamed columns this is a plain jsonb_populate_record. When a column HAD to be
// renamed (the empty-string key, or a key over 63 bytes), populate_record would look for
// the column name and never find the original key, so the load statement rewrites those
// keys first. Getting this wrong is silent: every renamed column arrives NULL.
export function jtsPgLoadStatement(rootTs, rootName) {
  const table = jtsPgTableName(rootName);
  const q = jtsQuotePgIdent(table);
  const shape = rootTs.object;
  const renames = shape
    ? jtsPgColumnNames(jtsSortedFields(shape).map((f) => f.key))
        .filter((m) => m.renamed)
        // A key holding U+0000 cannot appear in any SQL literal, so it is left out of the
        // rewrite; jtsPgUnloadableKeys reports it and the DDL carries a warning.
        .filter((m) => !JTS_NUL.test(m.key))
    : [];
  if (renames.length === 0) {
    return `INSERT INTO ${q}\nSELECT * FROM jsonb_populate_record(null::${q}, $1::jsonb);`;
  }
  const dropped = renames.map((r) => jtsPgLiteral(r.key)).join(', ');
  const adds = renames
    .map(
      (r) =>
        `    (CASE WHEN $1::jsonb ? ${jtsPgLiteral(r.key)}` +
        ` THEN jsonb_build_object(${jtsPgLiteral(r.column)}, $1::jsonb -> ${jtsPgLiteral(r.key)})` +
        ` ELSE '{}'::jsonb END)`
    )
    .join(' ||\n');
  return (
    `INSERT INTO ${q}\nSELECT * FROM jsonb_populate_record(null::${q},\n` +
    `  ($1::jsonb - ARRAY[${dropped}]) ||\n${adds}\n);`
  );
}

export function jtsEmitPostgres(rootTs, names, opts = {}) {
  const rootName = opts.rootName ?? 'Root';
  const table = jtsPgTableName(rootName);
  const lines = [];
  lines.push('-- Generated by json-typestack. Do not edit by hand.');
  lines.push(`-- Inferred from ${opts.sampleCount ?? '?'} sample(s).`);
  lines.push('-- Load one document per row with:');
  for (const l of jtsPgLoadStatement(rootTs, rootName).split('\n')) lines.push(`--   ${l}`);
  lines.push('-- No primary key is inferred: samples cannot show which field is unique.');
  for (const key of jtsPgUnloadableKeys(rootTs)) {
    lines.push(
      `-- WARNING: the JSON key ${JSON.stringify(key)} contains U+0000, which Postgres`
    );
    lines.push('-- rejects in both text and jsonb. Its column exists but cannot be loaded');
    lines.push('-- from the source documents; strip or re-encode that key first.');
  }

  const shape = rootTs.object;
  if (!shape || shape.fields.size === 0) {
    lines.push('');
    lines.push(`CREATE TABLE ${jtsQuotePgIdent(table)} (`);
    lines.push('  "document" jsonb NOT NULL');
    lines.push(');');
    lines.push('-- The root object had no fields in any sample, so there is nothing to');
    lines.push('-- spread into columns. The whole document is stored as jsonb.');
    lines.push('');
    return lines.join('\n');
  }

  const fields = jtsSortedFields(shape);
  const mapped = jtsPgColumnNames(fields.map((f) => f.key));

  if (fields.length > JTS_PG_MAX_COLUMNS) {
    lines.push(
      `-- WARNING: ${fields.length} columns. Postgres allows at most ${JTS_PG_MAX_COLUMNS};`
    );
    lines.push('-- this table will be rejected. Store the document as a single jsonb column');
    lines.push('-- or split it across several tables.');
  }

  lines.push('');
  lines.push(`CREATE TABLE ${jtsQuotePgIdent(table)} (`);

  const body = [];
  const checkSpecs = [];
  fields.forEach((f, i) => {
    const { column, renamed, reason } = mapped[i];
    const { type, checkKinds, note } = jtsPgColumnType(f.type);
    const optional = jtsIsOptional(shape, f);
    const nullable = jtsIsNullable(f.type);
    const notNull = !optional && !nullable ? ' NOT NULL' : '';
    const comments = [];
    if (renamed) comments.push(`from JSON key ${JSON.stringify(f.key)}: ${reason}`);
    if (note) comments.push(note);
    // When null was the ONLY thing observed, the note above already says so; repeating
    // "and it was null sometimes" adds nothing.
    const onlyNull = jtsMembers(f.type).length === 0;
    if (optional && nullable && !onlyNull) comments.push('optional AND nullable in the source samples');
    else if (optional) comments.push('optional: absent from at least one sample');
    else if (nullable && !onlyNull) comments.push('always present, but null in at least one sample');
    body.push(
      `  ${jtsQuotePgIdent(column)} ${type}${notNull}${comments.length ? `, -- ${comments.join('; ')}` : ','}`
    );
    if (checkKinds) {
      const allowed = [...checkKinds];
      // A JSON null inside a jsonb column is the string 'null' to jsonb_typeof, and it is
      // distinct from SQL NULL. Allow it when the field was ever null.
      if (nullable) allowed.push('null');
      const list = allowed.map((k) => `'${k}'`).join(', ');
      const q = jtsQuotePgIdent(column);
      const expr =
        allowed.length === 1
          ? `jsonb_typeof(${q}) = ${list}`
          : `jsonb_typeof(${q}) IN (${list})`;
      checkSpecs.push({ want: `${table}_${column}_kind`, body: `CHECK (${q} IS NULL OR ${expr})` });
    }
  });

  // Constraint names hit the same 63-byte ceiling as column names, and two long columns
  // truncate to the same constraint name, which Postgres rejects outright. Fit them
  // through the same de-duplicating path.
  const checkNames = jtsPgFitIdentifiers(checkSpecs.map((c) => c.want), 'kind_check');
  const checks = checkSpecs.map(
    (c, i) => `  CONSTRAINT ${jtsQuotePgIdent(checkNames[i].name)} ${c.body},`
  );

  const all = [...body, ...checks];
  // Strip the trailing comma from the last entry, keeping any trailing comment.
  const last = all.length - 1;
  all[last] = all[last].replace(/,(\s*--.*)?$/, '$1');
  lines.push(...all);
  lines.push(');');
  lines.push('');
  return lines.join('\n');
}
