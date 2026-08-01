#!/usr/bin/env node
// json-typestack CLI.
//
//   json-typestack [options] [file ...]
//
// Each file holds one JSON object, a JSON array of objects, or NDJSON. With no files it
// reads stdin. All samples from all files are pooled, and it is the comparison ACROSS
// samples that decides which fields are optional.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { jtsGenerate, jtsParseSamples, JTS_TARGETS } from '../src/index.js';

const USAGE = `json-typestack: JSON samples in, five typed artefacts out.

Usage:
  json-typestack [options] [file ...]

Options:
  --name <Name>     root type name (default: Root)
  --only <target>   print one of: ${JTS_TARGETS.join(', ')}
  --out <dir>       write files into <dir> instead of printing
  -h, --help        this text

Each file holds a JSON object, a JSON array of objects, or NDJSON. With no file
arguments samples are read from stdin. A field is optional when it is missing from at
least one sample, so pass several samples of the same shape.

Examples:
  json-typestack --name User samples/*.json
  cat events.ndjson | json-typestack --name Event --only zod
`;

function fail(msg) {
  process.stderr.write(`json-typestack: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { name: 'Root', only: null, out: null, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === '--name') {
      opts.name = argv[++i];
      if (opts.name === undefined) fail('--name needs a value');
    } else if (a === '--only') {
      opts.only = argv[++i];
      if (!JTS_TARGETS.includes(opts.only)) {
        fail(`--only must be one of ${JTS_TARGETS.join(', ')}`);
      }
    } else if (a === '--out') {
      opts.out = argv[++i];
      if (opts.out === undefined) fail('--out needs a directory');
    } else if (a.startsWith('-') && a !== '-') {
      fail(`unknown option ${a}`);
    } else {
      opts.files.push(a);
    }
  }
  return opts;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    fail('no input files and nothing on stdin');
  }
  return '';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const samples = [];
  try {
    if (opts.files.length === 0) {
      samples.push(...jtsParseSamples(readStdin(), 'stdin'));
    } else {
      for (const f of opts.files) {
        samples.push(...jtsParseSamples(readFileSync(f, 'utf8'), f));
      }
    }
  } catch (e) {
    fail(e.message);
  }

  let result;
  try {
    result = jtsGenerate(samples, { name: opts.name });
  } catch (e) {
    fail(e.message);
  }

  if (samples.length === 1) {
    process.stderr.write(
      'json-typestack: only one sample given, so every present field is reported as required. ' +
        'Pass more samples to infer optionality.\n'
    );
  }

  if (opts.only) {
    process.stdout.write(result[opts.only]);
    return;
  }

  if (opts.out) {
    mkdirSync(opts.out, { recursive: true });
    const base = result.tableName;
    const files = [
      [`${base}.ts`, result.ts],
      [`${base}.zod.mjs`, result.zod],
      [`${base}.schema.json`, result.jsonschema],
      [`${base}.sql`, result.sql],
      [`${base}.fixtures.json`, result.fixtures],
    ];
    for (const [name, body] of files) {
      writeFileSync(join(opts.out, name), body);
      process.stdout.write(`wrote ${join(opts.out, name)}\n`);
    }
    return;
  }

  const blocks = [
    ['TypeScript', result.ts],
    ['Zod', result.zod],
    ['JSON Schema', result.jsonschema],
    ['Postgres', result.sql],
    ['Fixtures', result.fixtures],
  ];
  for (const [title, body] of blocks) {
    process.stdout.write(`${'='.repeat(20)} ${title} ${'='.repeat(20)}\n`);
    process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
    process.stdout.write('\n');
  }
}

main();
