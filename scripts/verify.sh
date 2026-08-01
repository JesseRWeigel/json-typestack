#!/usr/bin/env bash
# Full verification for json-typestack. Exit 0 only if every section really ran and passed.
#
# Nothing here is allowed to skip. A missing dependency fails with the command that fixes
# it, because a skipped check reports the same green as one that ran.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

# Paths get pasted into the README, so print them relative to $HOME. The backslash on the
# tilde matters: bash tilde-expands the replacement in ${var/#$HOME/~} and the unescaped
# form silently substitutes $HOME for $HOME.
rel() { printf '%s' "${1/#$HOME/\~}"; }

pass=0
fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
section() { printf '\n%s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

printf 'json-typestack verify, in %s\n' "$(rel "$ROOT")"

# ---------------------------------------------------------------------------------------
section "0. dependencies"
if [ ! -x node_modules/.bin/tsc ] || [ ! -d node_modules/zod ] || [ ! -d node_modules/ajv ] \
   || [ ! -d node_modules/@electric-sql/pglite ]; then
  printf '  installing dependencies (zod, ajv, typescript, pglite)\n'
  if ! npm install --no-audit --no-fund --loglevel=error >"$TMP/install.log" 2>&1; then
    bad "npm install failed; run 'npm install' in $(rel "$ROOT") and read the error"
    tail -15 "$TMP/install.log" | sed 's/^/        /'
    printf '\n%d passed, %d failed\nVERIFY FAILED\n' "$pass" "$fail"
    exit 1
  fi
fi
for dep in zod ajv typescript @electric-sql/pglite; do
  if [ -d "node_modules/$dep" ]; then
    ok "$dep present ($(node -p "require('./node_modules/$dep/package.json').version" 2>/dev/null || echo '?'))"
  else
    bad "$dep missing; run: npm install"
  fi
done

# ---------------------------------------------------------------------------------------
section "1. unit suite"
if npm test >"$TMP/unit.log" 2>&1; then
  UNIT_COUNT=$(grep -oE '^# pass [0-9]+|^ℹ pass [0-9]+' "$TMP/unit.log" | grep -oE '[0-9]+' | tail -1)
  UNIT_FAIL=$(grep -oE '^# fail [0-9]+|^ℹ fail [0-9]+' "$TMP/unit.log" | grep -oE '[0-9]+' | tail -1)
  if [ "${UNIT_COUNT:-0}" -gt 0 ] && [ "${UNIT_FAIL:-1}" -eq 0 ]; then
    ok "$UNIT_COUNT unit tests passed"
  else
    bad "unit suite reported pass=$UNIT_COUNT fail=$UNIT_FAIL"
  fi
else
  UNIT_COUNT=0
  bad "unit suite failed"
  grep -E '^(not ok|✖|  AssertionError)' "$TMP/unit.log" | head -20 | sed 's/^/        /'
fi

# ---------------------------------------------------------------------------------------
section "2. four-way agreement: TypeScript, Zod, JSON Schema and Postgres on the same samples"
if node scripts/agreement.mjs >"$TMP/agree.log" 2>&1; then
  sed 's/^/  /' "$TMP/agree.log" | grep -v '^  *$' | sed 's/^  /  /'
  ok "all four outputs agreed on every scenario"
else
  cat "$TMP/agree.log" | sed 's/^/        /'
  bad "the four outputs disagree"
fi

# ---------------------------------------------------------------------------------------
section "3. independent recount of optionality straight from the raw samples"
# Deliberately does not import src/: it counts key presence itself and reads the answer
# back out of the CLI's text output. Two derivations that share code can be wrong together.
if node scripts/recount.mjs >"$TMP/recount.log" 2>&1; then
  sed 's/^/  /' "$TMP/recount.log" | sed 's/^  //' | sed 's/^/  /'
  ok "the independent recount agrees with the generated artefacts"
else
  cat "$TMP/recount.log" | sed 's/^/        /'
  bad "the independent recount disagrees with the generated artefacts"
fi

# ---------------------------------------------------------------------------------------
section "4. determinism through the CLI"
cat >"$TMP/a.json" <<'JSON'
[{"id":1,"email":"a@example.com","nick":null,"tags":["x"],"addr":{"zip":"1"}},
 {"id":"two","nick":"n","tags":[],"addr":{"city":"NY","zip":"2"}},
 {"id":3,"email":"c@example.com","nick":null,"tags":["y","z"],"addr":{"zip":"3"}}]
JSON
# Same samples, every object's keys reversed. Byte-identical output is required.
node -e '
const fs = require("fs");
const flip = (v) => Array.isArray(v) ? v.map(flip)
  : (v && typeof v === "object")
    ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, flip(v[k])]))
    : v;
const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
fs.writeFileSync(process.argv[2], JSON.stringify(flip(src)));
' "$TMP/a.json" "$TMP/b.json"
if ! cmp -s <(node -e 'console.log(JSON.stringify(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0])))' "$TMP/a.json") \
            <(node -e 'console.log(JSON.stringify(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0])))' "$TMP/b.json"); then
  ok "the key-order permutation really did reorder the input keys"
else
  bad "the permuted input has the same key order, so the determinism check below proves nothing"
fi
node bin/json-typestack.js --name User "$TMP/a.json" >"$TMP/out1.txt" 2>/dev/null
node bin/json-typestack.js --name User "$TMP/a.json" >"$TMP/out2.txt" 2>/dev/null
node bin/json-typestack.js --name User "$TMP/b.json" >"$TMP/out3.txt" 2>/dev/null
if cmp -s "$TMP/out1.txt" "$TMP/out2.txt"; then
  ok "two runs on the same samples are byte-identical ($(wc -c <"$TMP/out1.txt") bytes)"
else
  bad "two runs on the same samples differ"
fi
if cmp -s "$TMP/out1.txt" "$TMP/out3.txt"; then
  ok "permuting key order in the input changes nothing in the output"
else
  bad "output depends on key order in the input"
  diff "$TMP/out1.txt" "$TMP/out3.txt" | head -10 | sed 's/^/        /'
fi
# And reversing the SAMPLE order must not change it either.
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).reverse()))' "$TMP/a.json" "$TMP/c.json"
node bin/json-typestack.js --name User "$TMP/c.json" >"$TMP/out4.txt" 2>/dev/null
if cmp -s "$TMP/out1.txt" "$TMP/out4.txt"; then
  ok "reversing the sample order changes nothing in the output"
else
  bad "output depends on the order the samples arrive in"
fi

# ---------------------------------------------------------------------------------------
section "5. shapes that break naive generators"
run_shape() {
  local label="$1" json="$2"
  printf '%s' "$json" >"$TMP/shape.json"
  if out=$(node bin/json-typestack.js --name S "$TMP/shape.json" 2>&1) && [ -n "$out" ]; then
    ok "$label (${#out} bytes of output)"
  else
    bad "$label crashed: $(printf '%s' "$out" | head -3)"
  fi
}
run_shape "empty array"                '[{"xs":[]},{"xs":[]}]'
run_shape "empty object"               '[{"o":{}},{"o":{}}]'
run_shape "empty root object"          '[{},{}]'
run_shape "null everywhere"            '[{"a":null},{"a":null}]'
node -e '
let d = {leaf: 1};
for (let i = 0; i < 150; i++) d = {n: d};
require("fs").writeFileSync(process.argv[1], JSON.stringify([d]));
' "$TMP/deep.json"
if out=$(node bin/json-typestack.js --name Deep "$TMP/deep.json" 2>&1) \
   && [ "$(grep -c 'export interface' <<<"$out")" -eq 151 ]; then
  ok "150 levels of nesting produced 151 interfaces"
else
  bad "deep nesting: $(printf '%s' "$out" | head -3)"
fi
node -e '
const o = {};
for (let i = 0; i < 5000; i++) o["key_" + i] = i;
require("fs").writeFileSync(process.argv[1], JSON.stringify([o, o]));
' "$TMP/wide.json"
start=$(date +%s%N)
# grep -q closes the pipe on its first match, which sends SIGPIPE upstream, and with
# `set -o pipefail` that turns the whole pipeline into exit 141. Use a here-string.
if out=$(node bin/json-typestack.js --name Wide "$TMP/wide.json" 2>&1) \
   && grep -q 'WARNING: 5000 columns' <<<"$out"; then
  ok "a 5000-key object generated in $(( ($(date +%s%N) - start) / 1000000 ))ms and warned about the 1600-column limit"
else
  bad "5000-key object: $(printf '%s' "$out" | head -3)"
fi

# ---------------------------------------------------------------------------------------
section "6. the page is built from src/ and is not stale"
if node scripts/build-docs.mjs >"$TMP/docs.log" 2>&1; then
  if grep -q 'already up to date' "$TMP/docs.log"; then
    ok "docs/index.html matches the current src/ ($(wc -c <docs/index.html) bytes)"
  else
    bad "docs/index.html was stale; it has just been rebuilt, review and commit it"
  fi
else
  bad "the docs build failed"
  sed 's/^/        /' "$TMP/docs.log"
fi

# ---------------------------------------------------------------------------------------
section "7. the page in a real browser"
if node scripts/browser-check.mjs >"$TMP/browser.log" 2>&1; then
  sed 's/^/  /' "$TMP/browser.log"
  ok "$(grep -oE '[0-9]+ passed' "$TMP/browser.log" | tail -1) browser assertions"
else
  sed 's/^/  /' "$TMP/browser.log"
  bad "the browser check failed; playwright-core resolution and the page assertions are above"
fi

# ---------------------------------------------------------------------------------------
section "8. hygiene of committed files"
git ls-files -z >"$TMP/tracked" 2>/dev/null || : >"$TMP/tracked"
if [ -s "$TMP/tracked" ]; then
  if python3 scripts/hygiene.py >"$TMP/hyg.log" 2>&1; then
    sed 's/^/  /' "$TMP/hyg.log"
    ok "no secrets, no absolute home paths, no NUL bytes, no oversized files"
  else
    sed 's/^/        /' "$TMP/hyg.log"
    bad "hygiene scan found something"
  fi
else
  bad "git ls-files returned nothing, so the hygiene scan had no input"
fi

# ---------------------------------------------------------------------------------------
section "9. the README describes this project as it is now"
README="README.md"
if [ ! -f "$README" ]; then
  bad "README.md is missing"
else
  ok "README.md exists ($(wc -l <"$README") lines)"
  if grep -q '^## Status' "$README"; then ok "README has a Status section"; else bad "README has no ## Status section"; fi
  if grep -q '^## Limitations' "$README"; then ok "README has a Limitations section"; else bad "README has no ## Limitations section"; fi
  if grep -q 'VERIFY OK' "$README"; then
    ok "README Status carries this script's success line"
  else
    bad "README Status does not contain 'VERIFY OK', so it is not real pasted output"
  fi
  # A pasted count goes stale the moment a test is added, so assert it still matches.
  if [ "${UNIT_COUNT:-0}" -gt 0 ] && grep -q "$UNIT_COUNT unit tests" "$README"; then
    ok "README's claim of $UNIT_COUNT unit tests matches this run"
  else
    bad "README does not say '$UNIT_COUNT unit tests'; the count in it is stale"
  fi
  if grep -q 'TODO' "$README"; then bad "README still contains a TODO"; else ok "README has no TODO left in it"; fi
fi

# ---------------------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" -ne 0 ]; then
  printf 'VERIFY FAILED\n'
  exit 1
fi
printf 'VERIFY OK\n'
