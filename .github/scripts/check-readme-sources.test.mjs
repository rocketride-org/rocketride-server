#!/usr/bin/env node
// =============================================================================
// Regression test for the README source gate.
//
// A gate with no test of its own is the failure it was written to prevent, one
// level up: it can stop detecting anything and stay green while doing it. That
// is not hypothetical here — as first written, this gate ran in CI, reported
// failure correctly, and could not block a merge, because the job was never
// added to `ci-ok.needs`. The check worked; the wiring did not.
//
// Each case builds a throwaway repo tree, points the gate at it via
// README_GATE_ROOT, and asserts on the EXIT CODE — which is the only thing CI
// reads. Asserting on stdout alone would pass a script that prints complaints
// and exits 0.
//
// Dependency-free: node:test + node:assert, matching the gate itself.
// Run: node --test .github/scripts/
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const GATE = join(import.meta.dirname, 'check-readme-sources.mjs');

/** Write a file, creating parents. */
function put(root, relPath, contents) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/**
 * Build a fixture tree and run the gate against it.
 * Returns { code, out } — `code` is what CI acts on.
 */
function runGate(files) {
  const root = mkdtempSync(join(tmpdir(), 'readme-gate-'));
  try {
    for (const [p, c] of Object.entries(files)) put(root, p, c);
    const res = spawnSync(process.execPath, [GATE], {
      env: { ...process.env, README_GATE_ROOT: root },
      encoding: 'utf8',
    });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A tree that should pass: one tasks.js, a real source, no relative links. */
function healthy(extraReadme = '') {
  return {
    'packages/thing/scripts/tasks.js':
      "const README_SRC = path.join(DOCS_DIR, 'README-thing.md');\n",
    'docs/README-thing.md':
      `# Thing\n\n[docs](https://rocketride.ai/docs)\n![badge](https://img.shields.io/x.svg)\n${extraReadme}`,
  };
}

test('healthy tree passes', () => {
  const { code } = runGate(healthy());
  assert.equal(code, 0);
});

test('README_SRC pointing at a missing file fails', () => {
  const { code, out } = runGate({
    'packages/thing/scripts/tasks.js':
      "const README_SRC = path.join(DOCS_DIR, 'README-renamed.md');\n",
    'docs/README-thing.md': '# Thing\n',
  });
  assert.notEqual(code, 0);
  assert.match(out, /README-renamed\.md/);
});

test('a committed README.md shadowing the generated one fails', () => {
  const files = healthy();
  files['packages/thing/README.md'] = '# stale hand-written copy\n';
  const { code, out } = runGate(files);
  assert.notEqual(code, 0);
  assert.match(out, /README\.md/);
});

test('no tasks.js references README_SRC at all — fails rather than passing vacuously', () => {
  // The convention moved and the gate is checking nothing. Silence here would
  // be the worst outcome: a green check that inspects zero files.
  const { code, out } = runGate({ 'docs/README-thing.md': '# Thing\n' });
  assert.notEqual(code, 0);
  assert.match(out, /no tasks\.js references README_SRC/);
});

test('an inline relative link fails', () => {
  const { code, out } = runGate(healthy('\n[guide](./guide.md)\n'));
  assert.notEqual(code, 0);
  assert.match(out, /\.\/guide\.md/);
});

test('a relative <img src> fails', () => {
  const { code, out } = runGate(healthy('\n<img src="./logo.png">\n'));
  assert.notEqual(code, 0);
  assert.match(out, /logo\.png/);
});

// --- the two forms that used to slip past -----------------------------------

test('a reference-style relative link fails', () => {
  // `[guide]: ./guide.md` sits far from the `[text][guide]` that uses it, so
  // the inline-link pattern never sees it. This was the one relative form the
  // gate allowed, which is precisely the class it exists to catch.
  const { code, out } = runGate(healthy('\nSee [the guide][guide].\n\n[guide]: ./guide.md\n'));
  assert.notEqual(code, 0);
  assert.match(out, /reference-style/);
  assert.match(out, /\.\/guide\.md/);
});

test('a relative <a href> fails', () => {
  // Badge rows wrap an image in a link, so a README could pass the <img> check
  // and still ship a relative anchor beside it.
  const { code, out } = runGate(healthy('\n<a href="./docs/x.md"><img src="https://img.shields.io/x.svg"></a>\n'));
  assert.notEqual(code, 0);
  assert.match(out, /<a href/);
});

test('absolute reference-style links and anchors still pass', () => {
  // The complement of the two cases above. Without this, tightening the
  // patterns until everything fails would look like success.
  const { code } = runGate(
    healthy(
      '\n[site]: https://rocketride.ai\n[mail]: mailto:hi@rocketride.ai\n[top]: #heading\n' +
        '<a href="https://rocketride.ai">home</a>\n'
    )
  );
  assert.equal(code, 0);
});
