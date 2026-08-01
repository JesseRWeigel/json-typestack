// The four-way agreement check.
//
// Given the same samples, the TypeScript type, the Zod schema, the JSON Schema and the
// Postgres DDL must accept the same documents and reject the same documents. This runs
// all four for real:
//
//   Zod           the actual zod package, importing the generated .mjs
//   JSON Schema   ajv, a third-party validator that shares no code with the generator
//   Postgres      pglite, a real Postgres compiled to WASM, running the generated DDL
//   TypeScript    the actual tsc, compiling the generated interfaces plus a typed fixture
//
// Nothing here re-implements the semantics being tested, which is the point: a checker
// written from the same understanding as the generator inherits the generator's bugs.
//
// Exit 0 only if every expectation in test/scenarios.mjs held.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import Ajv2020 from 'ajv/dist/2020.js';
import { jtsGenerate } from '../src/index.js';
import { SCENARIOS } from '../test/scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// Inside the project so `import { z } from "zod"` resolves from node_modules.
const WORK = join(ROOT, '.agreement-work');

const counts = {
  samplesZod: [0, 0],
  samplesAjv: [0, 0],
  samplesPg: [0, 0],
  fixturesZod: [0, 0],
  fixturesAjv: [0, 0],
  fixturesPg: [0, 0],
  wrongZod: [0, 0],
  wrongAjv: [0, 0],
  wrongPg: [0, 0],
  wrongTs: [0, 0],
  tsCompiles: [0, 0],
};
const failures = [];

function score(bucket, ok, detail) {
  counts[bucket][1] += 1;
  if (ok) counts[bucket][0] += 1;
  else failures.push(`${bucket}: ${detail}`);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(WORK, 'pos'), { recursive: true });
mkdirSync(join(WORK, 'neg'), { recursive: true });

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      skipLibCheck: true,
      types: [],
    },
    include: ['*.ts'],
  },
  null,
  2
);
writeFileSync(join(WORK, 'pos', 'tsconfig.json'), TSCONFIG);
writeFileSync(join(WORK, 'neg', 'tsconfig.json'), TSCONFIG);

const db = await PGlite.create();

// Loads through the statement the tool itself printed in the DDL header, so the header
// is under test too. A load statement that quietly NULLs a renamed column shows up here
// as a NOT NULL violation rather than as a comment nobody read.
async function pgAccepts(loadSql, doc) {
  try {
    await db.query(loadSql.replace(/;\s*$/, ''), [JSON.stringify(doc)]);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e.message).split('\n')[0] };
  }
}

const tsExpectations = []; // { file, expect }
const posFiles = [];

for (const sc of SCENARIOS) {
  const g = jtsGenerate(sc.samples, { name: sc.typeName });

  // ---- Zod: import the generated module and use the real library -------------------
  const zodPath = join(WORK, `${sc.id}.zod.mjs`);
  writeFileSync(zodPath, g.zod);
  const zodMod = await import(`${zodPath}?v=${Date.now()}`);
  const zodSchema = zodMod[g.rootName];
  if (!zodSchema) throw new Error(`${sc.id}: generated Zod module has no export ${g.rootName}`);

  // ---- JSON Schema: ajv ------------------------------------------------------------
  // strict:true keeps ajv complaining about anything malformed in the generated schema.
  // allowUnionTypes only switches off ajv's house style preference against
  // `"type": ["integer", "string"]`, which is valid JSON Schema and is exactly what a
  // widened field has to emit.
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: false });
  const validate = ajv.compile(g.jsonschemaObject);

  // ---- Postgres: pglite ------------------------------------------------------------
  await db.exec(g.sql);
  const load = g.pgLoadStatement;

  // ---- samples ---------------------------------------------------------------------
  for (const [i, s] of sc.samples.entries()) {
    const z = zodSchema.safeParse(s);
    score('samplesZod', z.success, `${sc.id} sample ${i}: ${z.error ? z.error.issues[0].message : ''}`);
    const a = validate(s);
    score('samplesAjv', a, `${sc.id} sample ${i}: ${ajv.errorsText(validate.errors)}`);
    const p = await pgAccepts(load, s);
    score('samplesPg', p.ok, `${sc.id} sample ${i}: ${p.message ?? ''}`);
  }

  // ---- generated fixtures ----------------------------------------------------------
  for (const [name, fixture] of Object.entries(g.fixturesObject)) {
    const z = zodSchema.safeParse(fixture);
    score('fixturesZod', z.success, `${sc.id} fixture ${name}: ${z.error ? JSON.stringify(z.error.issues[0]) : ''}`);
    const a = validate(fixture);
    score('fixturesAjv', a, `${sc.id} fixture ${name}: ${ajv.errorsText(validate.errors)}`);
    const p = await pgAccepts(load, fixture);
    score('fixturesPg', p.ok, `${sc.id} fixture ${name}: ${p.message ?? ''}`);
  }

  // ---- wrong documents -------------------------------------------------------------
  for (const [i, w] of sc.wrong.entries()) {
    const z = zodSchema.safeParse(w.value);
    const zodVerdict = z.success ? 'accept' : 'reject';
    score('wrongZod', zodVerdict === w.expect.zod, `${sc.id}[${i}] ${w.label}: zod ${zodVerdict}, expected ${w.expect.zod}`);

    const a = validate(w.value);
    const ajvVerdict = a ? 'accept' : 'reject';
    score('wrongAjv', ajvVerdict === w.expect.ajv, `${sc.id}[${i}] ${w.label}: ajv ${ajvVerdict}, expected ${w.expect.ajv}`);

    const p = await pgAccepts(load, w.value);
    const pgVerdict = p.ok ? 'accept' : 'reject';
    score('wrongPg', pgVerdict === w.expect.pg, `${sc.id}[${i}] ${w.label}: postgres ${pgVerdict}, expected ${w.expect.pg}`);
  }

  // ---- TypeScript source: interfaces plus typed fixtures ---------------------------
  const fixtureAssignments = Object.entries(g.fixturesObject)
    .map(([name, v]) => `const fixture_${name}: ${g.rootName} = ${JSON.stringify(v, null, 2)};\nvoid fixture_${name};`)
    .join('\n\n');
  writeFileSync(join(WORK, 'pos', `${sc.id}.ts`), `${g.ts}\n${fixtureAssignments}\n`);
  posFiles.push(`${sc.id}.ts`);

  for (const [i, w] of sc.wrong.entries()) {
    const file = `${sc.id}_${i}.ts`;
    writeFileSync(
      join(WORK, 'neg', file),
      `${g.ts}\nconst wrong: ${g.rootName} = ${JSON.stringify(w.value, null, 2)};\nvoid wrong;\n`
    );
    tsExpectations.push({ file, expect: w.expect.ts, label: `${sc.id}[${i}] ${w.label}` });
  }
}

await db.close();

// ---- run the real tsc --------------------------------------------------------------
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');
function runTsc(dir) {
  return spawnSync(TSC, ['--noEmit', '--pretty', 'false', '-p', join(WORK, dir)], {
    encoding: 'utf8',
    cwd: ROOT,
  });
}

const pos = runTsc('pos');
const posOut = (pos.stdout || '') + (pos.stderr || '');
for (const file of posFiles) {
  score(
    'tsCompiles',
    pos.status === 0 && !posOut.includes(`${file}(`),
    `${file} did not compile:\n${posOut}`
  );
}

const neg = runTsc('neg');
const negOut = (neg.stdout || '') + (neg.stderr || '');
for (const e of tsExpectations) {
  const errored = negOut.includes(`${e.file}(`);
  const verdict = errored ? 'reject' : 'accept';
  score('wrongTs', verdict === e.expect, `${e.label}: tsc ${verdict}, expected ${e.expect}`);
}

// ---- report ------------------------------------------------------------------------
const LABELS = {
  samplesZod: 'input samples accepted by the generated Zod schema',
  samplesAjv: 'input samples accepted by the generated JSON Schema (ajv)',
  samplesPg: 'input samples accepted by the generated Postgres DDL (pglite)',
  fixturesZod: 'generated fixtures accepted by the generated Zod schema',
  fixturesAjv: 'generated fixtures accepted by the generated JSON Schema',
  fixturesPg: 'generated fixtures accepted by the generated Postgres DDL',
  wrongZod: 'wrong documents where Zod matched the declared expectation',
  wrongAjv: 'wrong documents where JSON Schema matched the declared expectation',
  wrongPg: 'wrong documents where Postgres matched the declared expectation',
  wrongTs: 'wrong documents where tsc matched the declared expectation',
  tsCompiles: 'scenarios whose generated TypeScript + fixtures compiled under tsc --strict',
};

let width = 0;
for (const k of Object.keys(LABELS)) width = Math.max(width, LABELS[k].length);
for (const [k, label] of Object.entries(LABELS)) {
  const [ok, total] = counts[k];
  process.stdout.write(`  ${label.padEnd(width)}  ${ok}/${total}\n`);
}

if (failures.length) {
  process.stdout.write('\nDISAGREEMENTS:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.stdout.write(`\nAGREEMENT FAILED (${failures.length})\n`);
  process.exit(1);
}
rmSync(WORK, { recursive: true, force: true });
process.stdout.write('\nAGREEMENT OK\n');
