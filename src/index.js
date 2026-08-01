// Public entry point. One call takes samples in and returns all five outputs.
//
// The same function backs the CLI and the browser page in docs/index.html, which is why
// nothing in src/ imports anything from node: the page inlines these modules verbatim.

import { jtsInfer } from './model.js';
import { jtsRootTypeName, jtsBuildNames, jtsPgTableName } from './naming.js';
import { jtsEmitTypeScript } from './emit_ts.js';
import { jtsEmitZod } from './emit_zod.js';
import { jtsEmitJsonSchema, jtsBuildJsonSchema } from './emit_jsonschema.js';
import { jtsEmitPostgres } from './emit_sql.js';
import { jtsEmitFixtures, jtsBuildFixtures } from './emit_fixtures.js';

export const JTS_TARGETS = ['ts', 'zod', 'jsonschema', 'sql', 'fixtures'];

export function jtsGenerate(samples, options = {}) {
  const rootName = jtsRootTypeName(options.name ?? 'Root');
  const rootTs = jtsInfer(samples);
  const names = jtsBuildNames(rootTs, rootName);
  const opts = { rootName, sampleCount: samples.length };
  return {
    rootName,
    tableName: jtsPgTableName(rootName),
    sampleCount: samples.length,
    ts: jtsEmitTypeScript(rootTs, names, opts),
    zod: jtsEmitZod(rootTs, names, opts),
    jsonschema: jtsEmitJsonSchema(rootTs, names, opts),
    sql: jtsEmitPostgres(rootTs, names, opts),
    fixtures: jtsEmitFixtures(rootTs),
    jsonschemaObject: jtsBuildJsonSchema(rootTs, names, opts),
    fixturesObject: jtsBuildFixtures(rootTs),
    model: rootTs,
    names,
  };
}

// Parses one file's worth of text into a list of samples. Accepts a single JSON object,
// a JSON array of objects, or newline-delimited JSON.
export function jtsParseSamples(text, label = 'input') {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label}: empty input`);
  try {
    const v = JSON.parse(trimmed);
    return Array.isArray(v) ? v : [v];
  } catch (jsonErr) {
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error(`${label}: ${jsonErr.message}`);
    const out = [];
    lines.forEach((line, i) => {
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        throw new Error(`${label}: not valid JSON, and line ${i + 1} is not valid NDJSON either (${e.message})`);
      }
    });
    return out;
  }
}
