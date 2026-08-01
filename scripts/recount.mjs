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
    const columnKey = key === '' ? 'column' : key;
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
