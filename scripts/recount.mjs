// An independent recount of optionality and nullability.
//
// The agreement harness compares four artefacts that all come out of one call to
// jtsGenerate. If the inference were wrong in the same way in all four, they would agree
// with each other and be wrong together. So this file derives the answer a third time,
// straight from the raw samples, with a counting loop that imports nothing from src/, and
// then reads the answer back out of the CLI's TEXT output rather than its data structures.
//
// Only the scenario data is shared. No logic is.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { SCENARIOS } from '../test/scenarios.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'jts-recount-'));

let checks = 0;
const problems = [];

function cli(file, target, name) {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, 'bin', 'json-typestack.js'), '--name', name, '--only', target, file],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error(`CLI failed for ${target}: ${r.stderr}`);
  return r.stdout;
}

// Read the answer back out of the emitted TEXT, deliberately by hand.
function requiredFromJsonSchema(text) {
  const schema = JSON.parse(text);
  return new Set(schema.required || []);
}

function optionalFromTypeScript(text, rootName) {
  // Take only the root interface block.
  const start = text.indexOf(`export interface ${rootName} {`);
  if (start === -1) return null;
  const end = text.indexOf('\n}', start);
  const block = text.slice(start, end);
  const optional = new Set();
  const seen = new Set();
  for (const line of block.split('\n').slice(1)) {
    const m = /^ {2}(".*?"|[^:?]+)(\?)?:/.exec(line);
    if (!m) continue;
    const key = m[1].startsWith('"') ? JSON.parse(m[1]) : m[1];
    seen.add(key);
    if (m[2]) optional.add(key);
  }
  return { optional, seen };
}

function notNullFromSql(text) {
  const notNull = new Set();
  const seen = new Set();
  for (const line of text.split('\n')) {
    const m = /^ {2}("(?:[^"]|"")*") ([a-z ]+?)(?: (NOT NULL))?[,;]?(?: --.*)?$/.exec(line);
    if (!m) continue;
    const col = m[1].slice(1, -1).replace(/""/g, '"');
    seen.add(col);
    if (m[3]) notNull.add(col);
  }
  return { notNull, seen };
}

// The column name a key SHOULD get, re-derived here from the rules the README states,
// with a Buffer-based implementation rather than the codepoint-based one in src/naming.js.
// Writing it a second way is the point: a helper that called into src/ could not catch a
// bug in src/.
function expectedColumnNames(keys) {
  const used = new Set();
  const truncate = (s) => {
    let buf = Buffer.from(s, 'utf8');
    if (buf.length <= 63) return s;
    buf = buf.subarray(0, 63);
    // Drop any trailing bytes that would leave a partial UTF-8 sequence.
    let text = buf.toString('utf8');
    while (text.includes('�')) {
      buf = buf.subarray(0, buf.length - 1);
      text = buf.toString('utf8');
    }
    return text;
  };
  const truncateTo = (s, limit) => {
    if (Buffer.byteLength(s, 'utf8') <= limit) return s;
    let out = '';
    for (const ch of s) {
      if (Buffer.byteLength(out + ch, 'utf8') > limit) break;
      out += ch;
    }
    return out;
  };
  return keys.map((key) => {
    let base = '';
    for (const ch of key) {
      const c = ch.codePointAt(0);
      base += c < 0x20 || c === 0x7f ? '_' : ch;
    }
    if (base === '') base = 'column';
    base = truncate(base);
    let name = base;
    let n = 2;
    while (used.has(name)) {
      name = truncateTo(base, 63 - String(n).length) + n;
      n += 1;
    }
    used.add(name);
    return name;
  });
}

for (const sc of SCENARIOS) {
  // --- the independent count -----------------------------------------------------------
  const present = new Map();
  const sawNull = new Set();
  const total = sc.samples.length;
  for (const sample of sc.samples) {
    for (const key of Object.keys(sample)) {
      present.set(key, (present.get(key) || 0) + 1);
      if (sample[key] === null) sawNull.add(key);
    }
  }
  // Columns are emitted in codepoint order, and the rename rules depend on that order.
  const sortedKeys = [...present.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const expectedColumn = new Map(
    sortedKeys.map((k, i) => [k, expectedColumnNames(sortedKeys)[i]])
  );

  const file = join(work, `${sc.id}.json`);
  writeFileSync(file, JSON.stringify(sc.samples));
  const schemaRequired = requiredFromJsonSchema(cli(file, 'jsonschema', sc.typeName));
  const ts = optionalFromTypeScript(cli(file, 'ts', sc.typeName), sc.typeName.replace(/^(.)/, (c) => c.toUpperCase()));
  const sql = notNullFromSql(cli(file, 'sql', sc.typeName));

  if (!ts) {
    problems.push(`${sc.id}: could not find the root interface in the TypeScript output`);
    continue;
  }

  for (const [key, count] of present) {
    const shouldBeOptional = count < total;
    const isNullable = sawNull.has(key);
    checks += 1;

    if (schemaRequired.has(key) === shouldBeOptional) {
      problems.push(
        `${sc.id}.${JSON.stringify(key)}: seen in ${count}/${total} samples, ` +
          `JSON Schema says ${schemaRequired.has(key) ? 'required' : 'optional'}`
      );
    }
    if (ts.optional.has(key) !== shouldBeOptional) {
      problems.push(
        `${sc.id}.${JSON.stringify(key)}: seen in ${count}/${total} samples, ` +
          `TypeScript says ${ts.optional.has(key) ? 'optional' : 'required'}`
      );
    }
    // A column is NOT NULL only when the key was in every sample AND never null.
    const columnKey = expectedColumn.get(key);
    const shouldBeNotNull = !shouldBeOptional && !isNullable;
    if (sql.notNull.has(columnKey) !== shouldBeNotNull) {
      problems.push(
        `${sc.id}.${JSON.stringify(key)}: seen in ${count}/${total}, null seen: ${isNullable}, ` +
          `SQL says ${sql.notNull.has(columnKey) ? 'NOT NULL' : 'nullable'}`
      );
    }
    if (!ts.seen.has(key)) problems.push(`${sc.id}.${JSON.stringify(key)}: missing from the TypeScript interface`);
    if (!sql.seen.has(columnKey)) problems.push(`${sc.id}.${JSON.stringify(key)}: missing from the DDL`);
  }
}

rmSync(work, { recursive: true, force: true });

console.log(`  ${checks} top-level fields recounted from raw samples across ${SCENARIOS.length} scenarios`);
if (problems.length) {
  for (const p of problems) console.log(`  FAIL  ${p}`);
  console.log(`RECOUNT FAILED (${problems.length})`);
  process.exit(1);
}
console.log('  RECOUNT OK: optional, required and NOT NULL all match an independent count');
