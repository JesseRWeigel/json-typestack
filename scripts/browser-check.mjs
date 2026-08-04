// Load docs/index.html in a real Chromium and assert on what the browser actually did.
//
// The page generates client side from the same modules the CLI uses, so the strongest
// available check is: run the CLI, run the page, and require the five outputs to be
// byte-identical. A page whose inline script failed to parse produces empty panels and
// fails that immediately, which unit tests importing the modules directly cannot catch.
//
// Two other traps this avoids. The shared Playwright browser can be navigated away by a
// concurrent agent, so this launches its own Chromium and re-asserts document.title inside
// every evaluation. A stale server on a fixed port silently serves a different project, so
// this binds to port 0 and asserts on served CONTENT rather than a status code.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pageFile = join(root, 'docs', 'index.html');
const TITLE = 'json-typestack';

// --- resolve playwright-core --------------------------------------------------------
// In order: an explicit override, this repo, the bare name, and only then the sibling
// project that happens to have it installed. The sibling path is built from homedir() so
// no absolute /home/<user> path is committed, and it is LAST so a fresh clone that has
// its own copy never silently depends on a directory outside itself.
const require = createRequire(join(root, 'package.json'));
const candidates = [
  process.env.PLAYWRIGHT_CORE,
  join(root, 'node_modules', 'playwright-core'),
  'playwright-core',
  join(root, '..', 'a11y-sweep', 'node_modules', 'playwright-core'),
].filter(Boolean);

let chromium = null;
let resolvedFrom = null;
for (const candidate of candidates) {
  try {
    ({ chromium } = require(candidate));
    resolvedFrom = candidate;
    break;
  } catch {
    /* try the next location */
  }
}
if (!chromium) {
  console.error('playwright-core could not be resolved from any of:');
  for (const c of candidates) console.error(`  ${c.replace(homedir(), '~')}`);
  console.error('');
  console.error('This check cannot be skipped, because a page can fail entirely while every');
  console.error('unit test passes. Install it and the browser binary with:');
  console.error('  npm install --no-save playwright-core && npx playwright install chromium');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (msg) => {
  console.log(`  ok    ${msg}`);
  pass += 1;
};
const bad = (msg) => {
  console.log(`  FAIL  ${msg}`);
  fail += 1;
};

console.log(`  playwright-core from ${String(resolvedFrom).replace(homedir(), '~')}`);

// --- what the CLI produces for a fixed input -----------------------------------------
const SAMPLES = [
  { id: 1, email: 'ada@example.com', nickname: null, tags: ['admin'], address: { zip: '1' } },
  { id: 'two', nickname: 'bee', tags: [], address: { zip: '2', city: 'NY' } },
  { id: 3, email: 'cy@example.com', nickname: null, tags: ['ops'], address: { zip: '3' } },
];
const SAMPLE_TEXT = JSON.stringify(SAMPLES, null, 2);
const TARGETS = ['ts', 'zod', 'jsonschema', 'sql', 'fixtures'];

const work = mkdtempSync(join(tmpdir(), 'jts-browser-'));
const samplePath = join(work, 'samples.json');
writeFileSync(samplePath, SAMPLE_TEXT);
const cli = {};
for (const t of TARGETS) {
  const r = spawnSync(
    process.execPath,
    [join(root, 'bin', 'json-typestack.js'), '--name', 'User', '--only', t, samplePath],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) {
    console.error(`the CLI failed for --only ${t}: ${r.stderr}`);
    process.exit(1);
  }
  cli[t] = r.stdout;
}

// --- serve the page on a port we know is free ----------------------------------------
const html = readFileSync(pageFile, 'utf8');
const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/`;

const served = await fetch(url).then((r) => r.text());
if (served.includes(`<title>${TITLE}</title>`) && served.includes('JTS-CORE-START')) {
  ok(`port ${port} is serving this project's page (${served.length} bytes)`);
} else {
  bad('the local server is not serving this project page');
}

// --- drive a real browser -------------------------------------------------------------
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.goto(url, { waitUntil: 'load' });

  // The script has to have RUN, not merely be present in the file.
  const booted = await page.evaluate((t) => ({
    title: document.title,
    hasHook: typeof window.__jtsGenerate === 'function',
    panelHasText: (document.getElementById('out-ts').textContent || '').length,
    factCount: document.querySelectorAll('#facts li').length,
    identity: document.title === t,
  }), TITLE);
  if (!booted.identity) bad(`page identity: expected "${TITLE}", got "${booted.title}"`);
  else ok(`page identity is "${booted.title}"`);
  if (booted.hasHook) ok('the inline script ran and exposed the generator');
  else bad('window.__jtsGenerate is missing, so the inline script did not run');
  if (booted.panelHasText > 100) ok(`the default example rendered ${booted.panelHasText} characters of TypeScript`);
  else bad(`the TypeScript panel holds only ${booted.panelHasText} characters`);
  if (booted.factCount === 5) ok('the summary line rendered five facts');
  else bad(`expected five summary facts, saw ${booted.factCount}`);

  // The whole point: the page must agree with the CLI byte for byte.
  const fromPage = await page.evaluate(
    ([text, title]) => {
      if (document.title !== title) throw new Error(`wrong page: ${document.title}`);
      return window.__jtsGenerate(text, 'User');
    },
    [SAMPLE_TEXT, TITLE]
  );
  let mismatches = 0;
  for (const t of TARGETS) {
    if (fromPage[t] === cli[t]) continue;
    mismatches += 1;
    bad(`page and CLI disagree on the ${t} output`);
    const a = (cli[t] || '').split('\n');
    const b = (fromPage[t] || '').split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        console.log(`        line ${i + 1} cli:  ${JSON.stringify(a[i])}`);
        console.log(`        line ${i + 1} page: ${JSON.stringify(b[i])}`);
        break;
      }
    }
  }
  if (mismatches === 0) ok(`all ${TARGETS.length} outputs are byte-identical to the CLI`);

  // Typing into the textarea must drive the same path the hook does.
  await page.fill('#input', JSON.stringify([{ a: 1 }, { a: 1, b: 2 }], null, 2));
  await page.waitForFunction(
    () => (document.getElementById('out-ts').textContent || '').includes('b?:'),
    null,
    { timeout: 5000 }
  ).then(
    () => ok('typing new samples re-generated the output, and b is optional in 1 of 2'),
    () => bad('typing new samples did not update the output')
  );

  // An input that cannot parse must say so rather than showing stale output.
  await page.fill('#input', '{not json');
  await page.waitForFunction(
    () => document.getElementById('status').className.includes('bad'),
    null,
    { timeout: 5000 }
  ).then(
    () => ok('invalid JSON reports an error instead of stale output'),
    () => bad('invalid JSON did not surface an error')
  );
  const cleared = await page.evaluate(() => document.getElementById('out-ts').textContent);
  if (cleared === '') ok('the panels are cleared when the input cannot be parsed');
  else bad('stale output survived an unparseable input');

  // --- overflow at a narrow viewport --------------------------------------------------
  for (const width of [390, 768, 1280]) {
    const p = await browser.newPage({ viewport: { width, height: 900 } });
    await p.goto(url, { waitUntil: 'load' });
    const overflow = await p.evaluate((t) => {
      if (document.title !== t) throw new Error(`wrong page: ${document.title}`);
      const docWidth = document.documentElement.clientWidth;
      const inScroller = (el) => {
        for (let node = el.parentElement; node; node = node.parentElement) {
          const s = getComputedStyle(node);
          if (s.overflowX === 'auto' || s.overflowX === 'scroll') return true;
        }
        return false;
      };
      const offenders = [];
      for (const el of document.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > docWidth + 1 && !inScroller(el)) {
          offenders.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} right=${Math.round(r.right)} doc=${docWidth}`);
        }
      }
      return {
        offenders,
        bodyScroll: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        hidden: getComputedStyle(document.body).overflowX,
        preScrolls: (() => {
          const pre = document.getElementById('out-sql');
          return getComputedStyle(pre).overflowX;
        })(),
      };
    }, TITLE);
    if (overflow.hidden === 'hidden') {
      bad(`body overflow-x is hidden at ${width}px, which would mask real overflow`);
    }
    if (overflow.offenders.length === 0) ok(`no element escapes the page at ${width}px`);
    else bad(`${overflow.offenders.length} element(s) overflow at ${width}px: ${overflow.offenders.join(', ')}`);
    if (overflow.bodyScroll <= overflow.clientWidth + 1) {
      ok(`no horizontal body scroll at ${width}px (scrollWidth ${overflow.bodyScroll}, client ${overflow.clientWidth})`);
    } else {
      bad(`horizontal body scroll at ${width}px: scrollWidth ${overflow.bodyScroll} > client ${overflow.clientWidth}`);
    }
    if (width === 390) {
      if (overflow.preScrolls === 'auto' || overflow.preScrolls === 'scroll') {
        ok('wide code blocks scroll inside their own container');
      } else {
        bad(`code blocks have overflow-x: ${overflow.preScrolls}`);
      }
    }
    await p.close();
  }

  // --- theme, both directions ----------------------------------------------------------
  for (const scheme of ['light', 'dark']) {
    const p = await browser.newPage({ viewport: { width: 900, height: 800 }, colorScheme: scheme });
    await p.goto(url, { waitUntil: 'load' });
    const read = () =>
      p.evaluate((t) => {
        if (document.title !== t) throw new Error(`wrong page: ${document.title}`);
        return {
          bg: getComputedStyle(document.body).backgroundColor,
          attr: document.documentElement.getAttribute('data-theme'),
        };
      }, TITLE);

    const system = await read();
    // Force the OPPOSITE of the system preference and check the attribute wins.
    const opposite = scheme === 'dark' ? 'light' : 'dark';
    await p.evaluate((v) => document.documentElement.setAttribute('data-theme', v), opposite);
    const forced = await read();
    if (forced.bg !== system.bg) {
      ok(`data-theme="${opposite}" overrides the ${scheme} system preference (${system.bg} to ${forced.bg})`);
    } else {
      bad(`data-theme="${opposite}" did not change anything under the ${scheme} system preference`);
    }
    // And back the other way.
    await p.evaluate((v) => document.documentElement.setAttribute('data-theme', v), scheme);
    const back = await read();
    if (back.bg === system.bg) ok(`data-theme="${scheme}" matches the ${scheme} system rendering`);
    else bad(`data-theme="${scheme}" gave ${back.bg}, system ${scheme} gives ${system.bg}`);
    await p.close();
  }

  // The toggle button has to actually do it, not just the attribute by hand.
  {
    const p = await browser.newPage({ viewport: { width: 900, height: 800 }, colorScheme: 'light' });
    await p.goto(url, { waitUntil: 'load' });
    const before = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await p.click('#theme');
    const after = await p.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      attr: document.documentElement.getAttribute('data-theme'),
    }));
    if (after.bg !== before && after.attr === 'dark') ok('the theme button switches the page to dark');
    else bad(`the theme button did nothing (attr=${after.attr}, ${before} to ${after.bg})`);
    await p.close();
  }

  if (consoleErrors.length === 0) ok('no page errors or console errors');
  else bad(`page reported errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
