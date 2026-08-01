# json-typestack

Paste several JSON samples of the same shape. Get a TypeScript interface, a Zod schema, a
JSON Schema, a Postgres `CREATE TABLE`, and example fixtures, with optionality inferred
from which fields are missing across the samples.

One sample cannot tell you whether a field is optional. Three samples can. That comparison
across samples is the whole point of the tool, and it is what makes the four outputs worth
generating together: given the same samples they accept the same documents and reject the
same documents.

```
npm install
node bin/json-typestack.js --name User samples.json
```

There is also a browser version at `docs/index.html`. It is one self-contained file with
no network access of any kind, and it runs the same generator: the verify script asserts
that the page and the CLI produce byte-identical output for the same input.

```
Usage:
  json-typestack [options] [file ...]

Options:
  --name <Name>     root type name (default: Root)
  --only <target>   print one of: ts, zod, jsonschema, sql, fixtures
  --out <dir>       write files into <dir> instead of printing
  -h, --help        this text
```

Each file holds a JSON object, a JSON array of objects, or NDJSON. With no file arguments
samples come from stdin. Samples from every file are pooled.

## What it infers

These three samples:

```json
[{"id":1,"email":"ada@example.com","nickname":null,"tags":["admin"],"address":{"zip":"1"}},
 {"id":"two","nickname":"bee","tags":[],"address":{"zip":"2","city":"NY"}},
 {"id":3,"email":"cy@example.com","nickname":null,"tags":["ops"],"address":{"zip":"3"}}]
```

produce this:

```ts
export interface User {
  address: UserAddress;
  email?: string;
  id: number | string;
  nickname: string | null;
  tags: string[];
}

export interface UserAddress {
  city?: string;
  zip: string;
}
```

```js
export const UserAddress = z.object({
  city: z.string().optional(),
  zip: z.string(),
});

export const User = z.object({
  address: UserAddress,
  email: z.string().optional(),
  id: z.union([z.number().int(), z.string()]),
  nickname: z.string().nullable(),
  tags: z.array(z.string()),
});
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "User",
  "type": "object",
  "properties": {
    "address": { "$ref": "#/$defs/UserAddress" },
    "email": { "type": "string" },
    "id": { "type": ["integer", "string"] },
    "nickname": { "type": ["string", "null"] },
    "tags": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["address", "id", "nickname", "tags"],
  "additionalProperties": true
}
```

```sql
CREATE TABLE "user" (
  "address" jsonb NOT NULL,
  "email" text, -- optional: absent from at least one sample
  "id" jsonb NOT NULL, -- mixed types across samples (integer | string); jsonb keeps them apart, text would not
  "nickname" text, -- always present, but null in at least one sample
  "tags" jsonb NOT NULL,
  CONSTRAINT "user_address_kind" CHECK ("address" IS NULL OR jsonb_typeof("address") = 'object'),
  CONSTRAINT "user_id_kind" CHECK ("id" IS NULL OR jsonb_typeof("id") IN ('number', 'string')),
  CONSTRAINT "user_tags_kind" CHECK ("tags" IS NULL OR jsonb_typeof("tags") = 'array')
);
```

## Optionality

A field is **optional** when it is absent from at least one of the objects it could have
appeared in.

| samples containing `email` | result |
|---|---|
| 2 of 3 | `email?: string`, `.optional()`, left out of `required`, nullable column |
| 3 of 3 | `email: string`, no `.optional()`, listed in `required`, `NOT NULL` |

The comparison is scoped to the object the field lives in, not to the top-level sample
count. If `address` appears in 2 of 3 samples and `address.city` appears in both of those,
`city` is **required**, because it was present every time an `address` existed. Array
elements are counted per element, so three line items across two samples give three
observations.

With a single sample every present field reads as required, and the CLI says so on stderr.

## Nullability

A field is **nullable** when its value was `null` in at least one sample. This is a
different fact from optionality and it is stored separately all the way through:

| in the samples | TypeScript | Zod | JSON Schema | Postgres |
|---|---|---|---|---|
| always present, never null | `a: string` | `z.string()` | in `required`, `"type":"string"` | `text NOT NULL` |
| absent from one sample | `a?: string` | `.optional()` | not in `required` | `text` |
| present every time, null once | `a: string \| null` | `.nullable()` | in `required`, `"type":["string","null"]` | `text` |
| both | `a?: string \| null` | `.nullable().optional()` | not in `required`, `"type":["string","null"]` | `text` |

Three of the four outputs keep optional and nullable apart. Postgres cannot: a row has no
way to say "this column is absent", so both become a nullable column. The DDL carries a
comment on every such column saying which of the two it was.

A field that was only ever `null` gets the type `null` rather than being dropped.

## Widening

Types are merged across samples, never overwritten. `{"id": 1}` and `{"id": "x"}` give
`number | string`, and the same union comes out whichever sample arrives first.

- integers only produce `integer` in JSON Schema and `z.number().int()` in Zod
- one non-integer anywhere widens the whole field to `number`
- an array of mixed element types gives a union element type, never `any[]`
- an array that was always empty gives `unknown[]`, since there is nothing to infer from
- a field that is sometimes an object and sometimes a scalar keeps both branches

Union member order is fixed (boolean, number, string, array, object, then `null` last), so
the output does not depend on the order values were seen in.

## Nested types and naming

Every nested object gets its own named type, named after the path to it, never after its
contents:

| position | name |
|---|---|
| root | `User` |
| `address` | `UserAddress` |
| `address.geo` | `UserAddressGeo` |
| `orders` (an array of objects) | `UserOrdersItem` |
| `orders[].lineItems[]` | `UserOrdersItemLineItemsItem` |

Each object-key step contributes `PascalCase(key)`; each step through an array contributes
the literal `Item`. Two different paths can sanitise to the same name (`foo-bar` and
`foo_bar` both give `FooBar`), so collisions get `2`, `3`, ... appended in traversal order,
which is depth first over codepoint-sorted keys. An object that is empty in every sample
becomes `Record<string, unknown>` rather than an empty interface, because an empty
interface in TypeScript accepts almost anything.

## Illegal identifiers

A JSON key can be `2fa`, `my-field`, `class`, `SELECT`, `a b`, `a"b` or the empty string.
Each target has different rules.

- **TypeScript and Zod**: keys that are not plain ASCII identifiers are quoted
  (`"2fa": boolean`). Reserved words such as `class` are legal property names and are left
  alone. Non-ASCII keys such as `ключ` are quoted too, conservatively; they are legal
  unquoted in TypeScript, but quoting them is always correct.
- **JSON Schema**: keys are strings, so every key is carried through verbatim.
- **Postgres**: every identifier in the generated DDL is double quoted, which means the
  column name is the JSON key exactly, case and punctuation included. `"2fa"`,
  `"my-field"`, `"class"`, `"SELECT"`, `"a b"` and `"a""b"` are all legal that way. Two
  kinds of key cannot be carried through:
  - the **empty string**, which Postgres rejects as a zero-length delimited identifier. It
    becomes `"column"`, and the DDL says so on that line.
  - a key **longer than 63 bytes**, which Postgres truncates silently. It is truncated on
    a byte budget (not a character count, so multi-byte keys stay valid UTF-8), and any
    collision that truncation causes gets `2`, `3`, ... appended.
  - a key containing a **control character**. A newline or a tab inside a quoted
    identifier is legal Postgres and it splits the DDL across lines, which breaks every
    tool that reads it line by line. Control characters become `_`. A key holding
    **U+0000** is worse than that: Postgres rejects it in both `text` and `jsonb`, so no
    statement can name it and no document containing it can be cast to jsonb. The DDL
    carries a `WARNING` naming that key and saying its column cannot be loaded.

  Constraint names hit the same 63-byte ceiling, so they go through the same
  de-duplicating path. Two columns whose names differ only past byte 63 would otherwise
  produce two identically named CHECK constraints, and Postgres rejects the whole
  `CREATE TABLE` with "already exists".

  String literals in the load statement escape control characters through Postgres's
  `E'...'` form, so a key with a newline in it does not split the statement either.

  When a column is renamed, `jsonb_populate_record` would look for the column name and
  never find the original key, so the load statement in the DDL header rewrites those keys
  first. This was a real bug that the agreement check found: every renamed column silently
  arrived NULL.

## Postgres mapping decisions

Every one of these is a choice, so each is listed with the reason.

| inferred type | column | why |
|---|---|---|
| string | `text` | The samples cannot tell you a real maximum length, and a `varchar(n)` guessed from them would reject the first longer value. In Postgres `text` and `varchar` perform identically. |
| integer, within int32 | `integer` | Smallest type that holds every observed value. |
| integer, beyond int32, within the JS safe range | `bigint` | Noted in a comment on the column. |
| integer beyond the safe integer range | `numeric` | `JSON.parse` has already lost precision at that magnitude; `numeric` at least does not lose more. |
| any non-integer number | `double precision` | JSON numbers are IEEE 754 doubles once parsed. Use `numeric` by hand if the values are money. |
| boolean | `boolean` | |
| object | `jsonb` | No child table is invented. Samples cannot show a key, a cardinality, or a join, so a generated `user_address` table with a guessed foreign key would be fiction. |
| array | `jsonb` | Not `text[]`: array elements can be heterogeneous or objects, and a homogeneous array today is not one tomorrow. |
| a union of scalar types | `jsonb` | Not `text`: text would lose the difference between the number `1` and the string `"1"`, which is exactly the distinction the union exists to record. |
| only null observed | `text`, nullable | There is nothing to go on. Flagged in a comment. |

Other decisions:

- **Nullability.** A column is `NOT NULL` only when the field was present in every sample
  and never null. Optional and nullable both map to a nullable column, as described above.
- **Every jsonb column carries a `CHECK` on `jsonb_typeof`**, so the container kind is
  enforced rather than merely documented. An object column rejects an array, an array
  column rejects an object, and a `number | string` column rejects a boolean. Where the
  field is nullable the check also allows JSON `null`, which is a jsonb value distinct
  from SQL `NULL`.
- **Identifiers are always double quoted**, which is what makes reserved words and
  punctuation work, and what lets the column name equal the JSON key.
- **The table name** is the lower snake_case of the root type name: `--name UserProfile`
  gives `"user_profile"`.
- **No primary key is inferred.** Samples cannot show which field is unique.
- **A load statement is printed in the DDL header**, and it is the statement the agreement
  check actually uses, so the header cannot drift away from being correct.
- **More than 1600 columns** cannot exist in a Postgres table, so a wider object emits a
  `WARNING` comment in the DDL saying the table will be rejected.

## Fixtures

Three come out of every run, and all three are checked against the generated schemas:

- `minimal`: only the required keys, no nulls
- `full`: every key present
- `nulls`: every key present, null wherever null is allowed

A generator that emits fixtures its own schema rejects is a common bug, so verify runs all
three through Zod, ajv and Postgres.

## How this is checked

The four outputs agreeing is the strongest available check, so the verify is built around
it, using real implementations rather than re-implementations:

| output | checked with |
|---|---|
| Zod | the actual `zod` package, importing the generated `.mjs` |
| JSON Schema | `ajv`, a third-party validator that shares no code with the generator |
| Postgres | `pglite`, a real Postgres compiled to WASM, running the generated DDL |
| TypeScript | the actual `tsc --strict`, compiling the generated interfaces plus typed fixtures |

Seven scenarios carry 16 input samples and 31 deliberately wrong documents. Each wrong
document declares, per output, whether that output must reject it, so the check fails in
both directions: a layer that starts accepting something it used to reject fails, and so
does one that starts rejecting something it used to accept. Of the 31, Zod must reject 30,
JSON Schema 28, TypeScript 30 and Postgres 18; every "must accept" is pinned with the
reason it cannot reject.

Separately, `scripts/recount.mjs` derives optionality a third time. It counts key presence
straight from the raw samples with a loop that imports nothing from `src/`, then reads the
answer back out of the CLI's **text** output. Two derivations that share code can be wrong
together; this one shares only the sample data.

### What the check found

Three real defects, each caught by running the artefacts rather than reading them:

1. **A renamed column silently arrived NULL.** The DDL header told you to load with
   `jsonb_populate_record`, which looks for the COLUMN name. A column renamed from the
   empty-string key therefore never matched anything, and pglite failed the insert on a
   NOT NULL violation. The load statement now rewrites renamed keys, and the agreement
   check runs the statement the tool itself printed.
2. **Two long keys produced two identical CHECK constraint names.** Truncating to 63 bytes
   collapsed them, and Postgres rejected the whole `CREATE TABLE`. Constraint names now go
   through the same de-duplicating path as column names.
3. **A control character in a key broke the DDL.** A newline split a quoted identifier
   across two lines; a NUL made the server reject the statement with "invalid message
   format". Both are handled, and U+0000 is reported as unloadable rather than emitted.

While fixing the third of those, the fix itself embedded a literal NUL byte in
`src/naming.js`. `scripts/hygiene.py` caught it on the next run, which is the whole reason
that check reads files as bytes in Python rather than shelling out to `grep`.

### Attacking the verify

Two sabotages were applied, and each was confirmed to change real output before the verify
was run.

**1. Optionality always returns required** (`jtsIsOptional` returns `false`). The generated
TypeScript changed from `email?: string` to `email: string`. Verify exited **1** with six
failing sections: the unit suite, the four-way agreement (input samples stopped validating
against the schemas generated from them), the independent recount, the docs freshness
check, the browser check, and the README count check.

**2. The Zod emitter drops all constraints** (`jtsZodType` returns `z.any()` and every key
gets `.optional()`). The generated schema changed from `id: z.number().int()` to
`id: z.any().optional()`, and the loaded schema then accepted `{}` and
`{"id": {"deeply": ["wrong"]}}`. Verify exited **1**, with "wrong documents where Zod
matched the declared expectation" dropping from 25/25 to 1/25.

## Status

Real output of `bash scripts/verify.sh`, run from a clean shell:

```
json-typestack verify, in ~/Projects/thousand/projects/json-typestack

0. dependencies
  ok    zod present (4.4.3)
  ok    ajv present (8.20.0)
  ok    typescript present (7.0.2)
  ok    @electric-sql/pglite present (0.5.4)

1. unit suite
  ok    61 unit tests passed

2. four-way agreement: TypeScript, Zod, JSON Schema and Postgres on the same samples
    input samples accepted by the generated Zod schema                           16/16
    input samples accepted by the generated JSON Schema (ajv)                    16/16
    input samples accepted by the generated Postgres DDL (pglite)                16/16
    generated fixtures accepted by the generated Zod schema                      21/21
    generated fixtures accepted by the generated JSON Schema                     21/21
    generated fixtures accepted by the generated Postgres DDL                    21/21
    wrong documents where Zod matched the declared expectation                   31/31
    wrong documents where JSON Schema matched the declared expectation           31/31
    wrong documents where Postgres matched the declared expectation              31/31
    wrong documents where tsc matched the declared expectation                   31/31
    scenarios whose generated TypeScript + fixtures compiled under tsc --strict  7/7
  AGREEMENT OK
  ok    all four outputs agreed on every scenario

3. independent recount of optionality straight from the raw samples
    34 top-level fields recounted from raw samples across 7 scenarios
    RECOUNT OK: optional, required and NOT NULL all match an independent count
  ok    the independent recount agrees with the generated artefacts

4. determinism through the CLI
  ok    the key-order permutation really did reorder the input keys
  ok    two runs on the same samples are byte-identical (3151 bytes)
  ok    permuting key order in the input changes nothing in the output
  ok    reversing the sample order changes nothing in the output

5. shapes that break naive generators
  ok    empty array (1274 bytes of output)
  ok    empty object (1338 bytes of output)
  ok    empty root object (1187 bytes of output)
  ok    null everywhere (1206 bytes of output)
  ok    150 levels of nesting produced 151 interfaces
  ok    a 5000-key object generated in 87ms and warned about the 1600-column limit

6. the page is built from src/ and is not stale
  ok    docs/index.html matches the current src/ (48790 bytes)

7. the page in a real browser
    playwright-core from ~/Projects/thousand/projects/a11y-sweep/node_modules/playwright-core
    ok    port 40997 is serving this project's page (48790 bytes)
    ok    page identity is "json-typestack"
    ok    the inline script ran and exposed the generator
    ok    the default example rendered 196 characters of TypeScript
    ok    the summary line rendered five facts
    ok    all 5 outputs are byte-identical to the CLI
    ok    typing new samples re-generated the output, and b is optional in 1 of 2
    ok    invalid JSON reports an error instead of stale output
    ok    the panels are cleared when the input cannot be parsed
    ok    no element escapes the page at 390px
    ok    no horizontal body scroll at 390px (scrollWidth 390, client 390)
    ok    wide code blocks scroll inside their own container
    ok    no element escapes the page at 768px
    ok    no horizontal body scroll at 768px (scrollWidth 768, client 768)
    ok    no element escapes the page at 1280px
    ok    no horizontal body scroll at 1280px (scrollWidth 1280, client 1280)
    ok    data-theme="dark" overrides the light system preference (rgb(247, 247, 245) to rgb(20, 22, 26))
    ok    data-theme="light" matches the light system rendering
    ok    data-theme="light" overrides the dark system preference (rgb(20, 22, 26) to rgb(247, 247, 245))
    ok    data-theme="dark" matches the dark system rendering
    ok    the theme button switches the page to dark
    ok    no page errors or console errors
    22 passed, 0 failed
  ok    22 passed browser assertions

8. hygiene of committed files
    29 tracked files scanned, 218704 bytes, 0 with NUL bytes
    7 detectors self-tested against synthetic samples
    NUL detection confirmed on a synthetic sample
    the AWS pattern stays case-sensitive, so base64 does not false-positive
  ok    no secrets, no absolute home paths, no NUL bytes, no oversized files

9. the README describes this project as it is now
  ok    README.md exists
  ok    README has a Status section
  ok    README has a Limitations section
  ok    README Status carries this script's success line
  ok    README's claim of 61 unit tests matches this run
  ok    README carries no unfinished markers

26 passed, 0 failed
VERIFY OK
```

## Limitations

- **Postgres enforces less than the other three, and the gap is documented rather than
  hidden.** Once a value is stored as `text`, "it was a JSON number" is not recoverable,
  so a `text` column accepts the number `7` where the samples only ever held strings.
  Postgres `boolean` input accepts the text `'yes'`. A nested object is one `jsonb` value,
  so its inner required keys are not enforced by the table. 13 of the 31 wrong documents
  in the agreement suite are accepted by Postgres for reasons like these, and each one is
  pinned with its reason in `test/scenarios.mjs`, so the check fails if the behaviour ever
  changes in either direction.
- **A JSON key containing U+0000 cannot round-trip through Postgres.** Neither `text` nor
  `jsonb` can hold that character, so the column is created and the DDL carries a `WARNING`
  saying it cannot be loaded from the source documents. The other three outputs handle the
  key normally.
- **`ajv` 8.20 does not enforce an empty string listed in `required`.** The generated JSON
  Schema is correct; this particular validator ignores that one entry. The behaviour is
  pinned in `test/ajv_limits.test.js` so the expectation flips the day ajv fixes it.
- **TypeScript has one number type**, so a value of `1.5` is a valid `number` even where
  every sample held whole numbers. Zod and JSON Schema keep the integer constraint, so
  those two reject it and TypeScript does not. That divergence is pinned as an
  expectation rather than smoothed over.
- **TypeScript object literals are excess-property-checked**, so an extra key fails `tsc`
  while Zod, JSON Schema and Postgres all accept it. Also pinned.
- **No formats are inferred.** A string that looks like a date, a UUID or an email stays a
  plain string. Guessing `format: "date-time"` from samples produces false positives on
  the first value that is not one.
- **No enums, no ranges, no string lengths.** Nothing constrains the value space beyond
  its type. A field whose three samples are `"a"`, `"b"`, `"a"` is a `string`, not an enum,
  because three samples are not evidence of a closed set.
- **No child tables.** A nested object stays `jsonb`. Normalising would require inventing a
  key and a cardinality that the samples do not contain.
- **Large integers lose precision before the tool sees them**, because `JSON.parse` maps
  them to doubles. A value beyond the safe integer range gets a `numeric` column, which
  stops the loss getting worse but cannot undo it.
- **Nesting is capped at 200 levels** and fails with a clear message rather than
  overflowing the stack.
- **The browser check proves the page and the CLI agree, not that both are right.** Page
  correctness rides on the same agreement suite that covers the CLI, since the page inlines
  the same modules.
- **`playwright-core` is not a dependency of this project.** The browser check resolves it
  from `PLAYWRIGHT_CORE`, then this repo, then the bare package name, and only then from a
  sibling project. If none of those exist it fails with the install command rather than
  skipping.

## Layout

```
bin/json-typestack.js      CLI
src/model.js               sample folding, presence counts, canonical member order
src/naming.js              type names, JS identifier rules, Postgres identifier rules
src/emit_ts.js             TypeScript
src/emit_zod.js            Zod
src/emit_jsonschema.js     JSON Schema 2020-12
src/emit_sql.js            Postgres DDL and its load statement
src/emit_fixtures.js       minimal / full / nulls fixtures
docs/index.html            the same generator, inlined, self contained
scripts/verify.sh          everything below, exits 0 only on real success
scripts/agreement.mjs      the four-way check against zod, ajv, pglite and tsc
scripts/recount.mjs        optionality re-derived from raw samples, sharing no code
scripts/build-docs.mjs     inlines src/ into docs/index.html
scripts/browser-check.mjs  loads the page in Chromium and compares it with the CLI
scripts/hygiene.py         secrets, home paths, NUL bytes, file sizes
```

## License

MIT
