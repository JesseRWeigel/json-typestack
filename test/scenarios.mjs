// Scenarios for the four-way agreement check in scripts/agreement.mjs.
//
// Each scenario carries samples plus deliberately WRONG documents. Every wrong document
// declares, per output, whether that output must reject it. Declaring the expectation
// rather than asserting "everything rejects everything" is what lets the check fail in
// BOTH directions: a layer that starts accepting something it used to reject fails, and
// so does a layer that starts rejecting something it used to accept.
//
// The `pg: 'accept'` cases are not bugs being papered over. They are the real and
// documented limit of a SQL column: once a value is stored as text, "it was a JSON
// number" is not recoverable, so the DDL cannot enforce it. Pinning them here means the
// README's claim about that limit is tested rather than asserted.

export const SCENARIOS = [
  {
    id: 'user',
    typeName: 'User',
    note: 'optional email (2 of 3), nullable nick, widened id, nested object, array',
    samples: [
      { id: 1, nick: null, tags: ['a'], address: { zip: '1' }, email: 'a@example.com' },
      { id: 'two', nick: 'n', tags: [], address: { zip: '2', city: 'NY' } },
      { id: 3, nick: null, tags: ['b', 'c'], address: { zip: '3' }, email: 'c@example.com' },
    ],
    wrong: [
      {
        label: 'required field `id` is missing',
        value: { nick: null, tags: [], address: { zip: '1' } },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
      {
        label: 'required nested field `address.zip` is missing',
        value: { id: 1, nick: null, tags: [], address: { city: 'NY' } },
        expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'reject' },
        why: 'the nested object is one jsonb value; its inner shape is not a column',
      },
      {
        label: 'required field `nick` is absent rather than null',
        value: { id: 1, tags: [], address: { zip: '1' } },
        expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'reject' },
        why: 'an absent key and a null both arrive as SQL NULL, and nick is nullable',
      },
      {
        label: '`tags` is a string instead of an array',
        value: { id: 1, nick: null, tags: 'a', address: { zip: '1' } },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
      {
        label: '`id` is a boolean, which is outside the inferred union',
        value: { id: true, nick: null, tags: [], address: { zip: '1' } },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
      {
        label: '`address` is a scalar instead of an object',
        value: { id: 1, nick: null, tags: [], address: 5 },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
      {
        label: '`email` is a number where a string was inferred',
        value: { id: 1, nick: null, tags: [], address: { zip: '1' }, email: 7 },
        expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'reject' },
        why: 'the number 7 is a legal text value; Postgres cannot tell it was JSON number',
      },
      {
        label: '`tags` holds a number where strings were inferred',
        value: { id: 1, nick: null, tags: [1], address: { zip: '1' } },
        expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'reject' },
        why: 'the array is one jsonb value and the CHECK only pins the container kind',
      },
      {
        label: 'an extra key nobody asked for',
        value: { id: 1, nick: null, tags: [], address: { zip: '1' }, surprise: true },
        expect: { zod: 'accept', ajv: 'accept', pg: 'accept', ts: 'reject' },
        why: 'objects are non-strict everywhere except a TypeScript object literal, which excess-property-checks',
      },
    ],
  },
  {
    id: 'nullvsopt',
    typeName: 'Flags',
    note: 'the optional / nullable / both / neither quartet',
    samples: [
      { keep: 'x', opt: 'a', nul: 'a', both: 'a' },
      { keep: 'x', nul: null, both: null },
      { keep: 'x', opt: 'c', nul: 'c' },
    ],
    wrong: [
      {
        label: 'the nullable key is absent, which nullable does not permit',
        value: { keep: 'x', opt: 'a', both: 'a' },
        expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'reject' },
        why: 'absent and null are the same SQL NULL',
      },
      {
        label: 'the optional key is null, which optional does not permit',
        value: { keep: 'x', opt: null, nul: 'a', both: 'a' },
        expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'reject' },
        why: 'the column is nullable because the key is optional',
      },
      {
        label: 'the always-present non-null key is null',
        value: { keep: null, opt: 'a', nul: 'a', both: 'a' },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
      {
        label: 'the always-present non-null key is absent',
        value: { opt: 'a', nul: 'a', both: 'a' },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
    ],
  },
  {
    id: 'awkward',
    typeName: 'Awkward',
    note: 'keys that are illegal identifiers in at least one of the four targets',
    samples: [
      { '2fa': true, 'my-field': 'x', class: 1, '': 'e', SELECT: 'v', 'a b': 1 },
      { '2fa': false, 'my-field': 'y', class: 2, '': 'f', SELECT: 'w', 'a b': 2, extra: null },
    ],
    wrong: [
      {
        label: 'the `2fa` key holds a string instead of a boolean',
        value: { '2fa': 'yes', 'my-field': 'x', class: 1, '': 'e', SELECT: 'v', 'a b': 1 },
        expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'reject' },
        why: "Postgres boolean input accepts the text 'yes'",
      },
      {
        label: 'the empty-string key is missing',
        value: { '2fa': true, 'my-field': 'x', class: 1, SELECT: 'v', 'a b': 1 },
        expect: { zod: 'reject', ajv: 'accept', pg: 'reject', ts: 'reject' },
        why:
          'ajv 8.20 does not enforce an empty string listed in `required`, so the JSON ' +
          'Schema is correct but this particular validator does not act on it. ' +
          'test/ajv_limits.test.js pins that behaviour, so this expectation flips the ' +
          'day ajv fixes it.',
      },
      {
        label: 'the `class` key holds a string instead of an integer',
        value: { '2fa': true, 'my-field': 'x', class: 'one', '': 'e', SELECT: 'v', 'a b': 1 },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
    ],
  },
  {
    id: 'nested',
    typeName: 'Order',
    note: 'arrays of objects, arrays of mixed scalars, three levels deep',
    samples: [
      {
        ref: 'A1',
        lines: [{ sku: 'x', qty: 1 }, { sku: 'y', qty: 2, note: 'gift' }],
        meta: { source: { channel: 'web' } },
        mixed: [1, 'a'],
      },
      {
        ref: 'A2',
        lines: [{ sku: 'z', qty: 3 }],
        meta: { source: { channel: 'app', agent: 'ios' } },
        mixed: [true],
      },
    ],
    wrong: [
      {
        label: 'a line item is missing its required `qty`',
        value: { ref: 'A3', lines: [{ sku: 'x' }], meta: { source: { channel: 'web' } }, mixed: [] },
        expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'reject' },
        why: 'lines is one jsonb value',
      },
      {
        label: '`lines` is an object instead of an array',
        value: { ref: 'A3', lines: { sku: 'x', qty: 1 }, meta: { source: { channel: 'web' } }, mixed: [] },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
      {
        label: '`meta.source.channel` is missing three levels down',
        value: { ref: 'A3', lines: [], meta: { source: {} }, mixed: [] },
        expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'reject' },
        why: 'meta is one jsonb value',
      },
      {
        label: '`ref` is missing',
        value: { lines: [], meta: { source: { channel: 'web' } }, mixed: [] },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
      {
        label: 'a line `qty` is 1.5 where every sample had a whole number',
        value: {
          ref: 'A3',
          lines: [{ sku: 'x', qty: 1.5 }],
          meta: { source: { channel: 'web' } },
          mixed: [],
        },
        expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'accept' },
        why: 'TypeScript has one number type, so 1.5 is a valid `number`; Zod and JSON Schema keep the integer constraint',
      },
    ],
  },
  {
    id: 'edges',
    typeName: 'Edges',
    note: 'always-empty array, always-empty object, only-null field, float and int mix',
    samples: [
      { xs: [], meta: {}, nothing: null, n: 1, big: 2147483648 },
      { xs: [], meta: {}, nothing: null, n: 1.5, big: 2147483649 },
    ],
    wrong: [
      {
        label: '`n` is a string where a number was inferred',
        value: { xs: [], meta: {}, nothing: null, n: 'x', big: 1 },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
      {
        label: '`nothing` holds a value where only null was ever seen',
        value: { xs: [], meta: {}, nothing: 'surprise', n: 1, big: 1 },
        expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'reject' },
        why: 'the column fell back to text, which accepts a string',
      },
      {
        label: '`meta` is an array where an object was inferred',
        value: { xs: [], meta: [], nothing: null, n: 1, big: 1 },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
      {
        label: '`xs` is missing',
        value: { meta: {}, nothing: null, n: 1, big: 1 },
        expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      },
    ],
  },
];

// Two keys that differ only past byte 63. Both the column names AND the constraint names
// truncate to the same identifier, and Postgres rejects the whole CREATE TABLE with
// "already exists". pglite running this DDL is what caught it.
const LONG_A = 'k'.repeat(70) + 'A';
const LONG_B = 'k'.repeat(70) + 'B';

SCENARIOS.push({
  id: 'longkeys',
  typeName: 'Long',
  note: 'keys past the 63-byte Postgres identifier limit, plus the empty-string key',
  samples: [
    { [LONG_A]: { x: 1 }, [LONG_B]: 'b', '': 1, ok: true },
    { [LONG_A]: { x: 2 }, [LONG_B]: 'c', '': 2, ok: false },
  ],
  wrong: [
    {
      label: 'a truncated-name column is missing its value',
      value: { [LONG_B]: 'b', '': 1, ok: true },
      expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
    },
    {
      label: 'the empty-string key is missing',
      value: { [LONG_A]: { x: 1 }, [LONG_B]: 'b', ok: true },
      expect: { zod: 'reject', ajv: 'accept', pg: 'reject', ts: 'reject' },
      why: 'the ajv limitation pinned in test/ajv_limits.test.js',
    },
    {
      label: 'a truncated-name column holds an array where an object was inferred',
      value: { [LONG_A]: [], [LONG_B]: 'b', '': 1, ok: true },
      expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
    },
  ],
});

// Keys carrying control characters. A raw newline inside a quoted Postgres identifier is
// legal but splits the DDL across lines, and a raw newline inside a SQL literal splits the
// load statement, so both go through an escaping path. pglite executing this is the check.
const NL_KEY = 'a' + '\n' + 'b';
const TAB_KEY = 'tab' + '\t' + 'here';
const BS_KEY = 'back' + '\\' + 'slash';

SCENARIOS.push({
  id: 'ctrlkeys',
  typeName: 'Ctrl',
  note: 'keys with newline, tab, apostrophe and backslash in them',
  samples: [
    { [NL_KEY]: 1, [TAB_KEY]: 'x', "q'uote": true, [BS_KEY]: 1, ok: 'a' },
    { [NL_KEY]: 2, [TAB_KEY]: 'y', "q'uote": false, [BS_KEY]: 2, ok: 'b' },
  ],
  wrong: [
    {
      label: 'the newline-keyed field is missing',
      value: { [TAB_KEY]: 'x', "q'uote": true, [BS_KEY]: 1, ok: 'a' },
      expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
    },
    {
      label: 'the apostrophe-keyed field holds a string instead of a boolean',
      value: { [NL_KEY]: 1, [TAB_KEY]: 'x', "q'uote": 'nope', [BS_KEY]: 1, ok: 'a' },
      expect: { zod: 'reject', ajv: 'reject', pg: 'reject', ts: 'reject' },
      why:
        "Postgres boolean input accepts 'yes', 't', '1' and friends, which is why the " +
        "awkward scenario pins one of those as accepted, but 'nope' is not one of them",
    },
    {
      label: 'the tab-keyed field holds a number where a string was inferred',
      value: { [NL_KEY]: 1, [TAB_KEY]: 7, "q'uote": true, [BS_KEY]: 1, ok: 'a' },
      expect: { zod: 'reject', ajv: 'reject', pg: 'accept', ts: 'reject' },
      why: 'a text column accepts any scalar in its textual form',
    },
  ],
});
