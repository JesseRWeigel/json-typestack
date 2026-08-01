// Inlines src/*.js into docs/index.html.
//
// The page has to be self contained (no CDN, no fetch, no separate .js file), and it also
// has to produce the same bytes as the CLI. Copying the logic into the page by hand would
// guarantee drift, so the page carries the real modules, concatenated.
//
// verify.sh re-runs this and fails if docs/index.html changes, which is what stops the
// page going stale against src/.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'docs', 'index.html');

// Dependency order. model and naming define what the emitters use.
const MODULES = [
  'model.js',
  'naming.js',
  'emit_ts.js',
  'emit_zod.js',
  'emit_jsonschema.js',
  'emit_sql.js',
  'emit_fixtures.js',
  'index.js',
];

const START = '/* JTS-CORE-START */';
const END = '/* JTS-CORE-END */';

function strip(source, file) {
  const out = [];
  for (const line of source.split('\n')) {
    if (/^import\s/.test(line)) {
      if (!line.includes(';')) {
        throw new Error(`${file}: multi-line import, which the inliner cannot strip`);
      }
      continue;
    }
    out.push(line.replace(/^export (?=(const|function|class|let|var) )/, ''));
  }
  const text = out.join('\n');
  if (/^\s*export\b/m.test(text)) {
    throw new Error(`${file}: an export survived stripping, so the page would not parse`);
  }
  if (text.includes('</script')) {
    throw new Error(`${file}: contains a literal </script, which would end the page's script tag`);
  }
  return text;
}

const parts = [
  '// Inlined from src/ by scripts/build-docs.mjs. Do not edit this block; edit src/.',
];
for (const m of MODULES) {
  parts.push(`// ---- src/${m} ${'-'.repeat(Math.max(0, 60 - m.length))}`);
  parts.push(strip(readFileSync(join(ROOT, 'src', m), 'utf8'), `src/${m}`));
}

const body = parts.join('\n').trimEnd();

// Everything lands in one script scope, so two modules declaring the same top-level name
// would be a SyntaxError that only shows up in a browser. Catch it here instead.
const seen = new Map();
for (const [, kind, name] of body.matchAll(/^(const|let|function|class)\s+([A-Za-z0-9_$]+)/gm)) {
  if (seen.has(name)) {
    throw new Error(
      `duplicate top-level declaration "${name}" (${seen.get(name)} and ${kind}); ` +
        'the inlined page would not parse'
    );
  }
  seen.set(name, kind);
}

const page = readFileSync(PAGE, 'utf8');
const startAt = page.indexOf(START);
const endAt = page.indexOf(END);
if (startAt === -1 || endAt === -1 || endAt < startAt) {
  throw new Error(`docs/index.html is missing the ${START} / ${END} markers`);
}
const next = `${page.slice(0, startAt + START.length)}\n${body}\n${page.slice(endAt)}`;

if (next === page) {
  process.stdout.write('docs/index.html already up to date\n');
} else {
  writeFileSync(PAGE, next);
  process.stdout.write(`docs/index.html rebuilt (${body.length} bytes of inlined core)\n`);
}
