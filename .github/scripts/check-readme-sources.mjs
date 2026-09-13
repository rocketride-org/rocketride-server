#!/usr/bin/env node
// =============================================================================
// README source gate
//
// Four artifacts publish a README to a registry — npm (`rocketride`), PyPI
// (`rocketride`), PyPI (`rocketride-mcp`), and the VS Code Marketplace plus
// OpenVSX. None of them stores its README in git: each package's
// scripts/tasks.js copies one in from docs/ at build time, which is why those
// directories have no README.md.
//
// That copy is silent when it goes wrong. If a README_SRC path is renamed on
// one side only, the build copies nothing (or the wrong file) and every check
// stays green while the registry page goes stale — and a registry README cannot
// be corrected without publishing a new version, so the mistake is live until
// the next release of that artifact.
//
// This gate makes the three failure modes loud:
//
//   1. a README_SRC pointing at a file that does not exist
//   2. a README.md committed into a package directory, shadowing the generated
//      one — whichever wins is then decided by build order, not intent
//   3. a relative link or image in a source README
//
// (3) needs saying because it is invisible in review: each registry resolves
// relative paths against ITSELF, not against GitHub. A README that renders
// perfectly in the repo can render broken on npm, PyPI and the Marketplace
// simultaneously, and the VS Code packer needs --baseContentUrl to have any
// chance at all. Absolute URLs are the only form that works in all five places.
//
// Run: node .github/scripts/check-readme-sources.mjs
// =============================================================================

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve, basename } from 'node:path';

// The repo root by default. README_GATE_ROOT overrides it so the regression
// test can point the gate at a fixture tree — a gate with no test of its own is
// the thing it was written to prevent, one level up.
const ROOT = process.env.README_GATE_ROOT
  ? resolve(process.env.README_GATE_ROOT)
  : resolve(import.meta.dirname, '..', '..');
const problems = [];

/** Directories that may contain a package with a generated README. */
function findTaskFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findTaskFiles(full, found);
    else if (entry.name === 'tasks.js') found.push(full);
  }
  return found;
}

// -- 1 + 2: every README_SRC resolves, and nothing shadows the generated file --
const taskFiles = findTaskFiles(ROOT).filter((f) =>
  readFileSync(f, 'utf8').includes('README_SRC')
);

if (taskFiles.length === 0) {
  // Fail rather than pass vacuously. An empty match means the convention moved
  // and this gate silently stopped checking anything — the exact class of
  // failure it exists to prevent.
  problems.push(
    'no tasks.js references README_SRC at all — the copy convention has moved ' +
      'and this gate is no longer checking anything. Update it or delete it.'
  );
}

const sources = new Set();

for (const taskFile of taskFiles) {
  const src = readFileSync(taskFile, 'utf8');
  const rel = relative(ROOT, taskFile);

  // const README_SRC = path.join(DOCS_DIR, 'README-x.md')
  const m = src.match(/README_SRC\s*=\s*path\.join\(\s*DOCS_DIR\s*,\s*['"]([^'"]+)['"]/);
  if (!m) {
    problems.push(
      `${rel}: mentions README_SRC but not in the expected ` +
        `path.join(DOCS_DIR, '...') form — this gate cannot verify it`
    );
    continue;
  }

  const docFile = join(ROOT, 'docs', m[1]);
  if (!existsSync(docFile)) {
    problems.push(`${rel}: README_SRC -> docs/${m[1]} does not exist`);
  } else {
    sources.add(docFile);
  }

  // scripts/tasks.js -> the package root two levels up
  const pkgDir = dirname(dirname(taskFile));
  for (const name of ['README.md', 'readme.md']) {
    if (existsSync(join(pkgDir, name))) {
      problems.push(
        `${relative(ROOT, join(pkgDir, name))}: committed, but this package's ` +
          `README is generated from docs/${m[1]} — delete the committed copy`
      );
    }
  }
}

// -- 3: no relative links or images in any source README ----------------------
// Anchors, mailto: and absolute URLs are fine everywhere. Anything else is a
// path, and a path resolves differently on each registry.
const LINK = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const ABSOLUTE = /^(https?:\/\/|mailto:|#)/;

for (const docFile of [...sources].sort()) {
  const text = readFileSync(docFile, 'utf8');
  const rel = relative(ROOT, docFile);
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    for (const match of line.matchAll(LINK)) {
      const [, bang, target] = match;
      if (ABSOLUTE.test(target)) continue;
      problems.push(
        `${rel}:${i + 1}: ${bang ? 'image' : 'link'} target "${target}" is ` +
          `relative — registries resolve it against themselves, not GitHub. ` +
          `Use an absolute URL.`
      );
    }
  });

  // Reference-style definitions: `[label]: ./path` on its own line, used far
  // from the `[text][label]` that consumes it. The inline LINK pattern above
  // cannot see these at all, so without this they were the one relative-link
  // form the gate silently allowed — the exact class it exists to catch.
  // Requires start-of-line so a `[x]: y` inside prose or a code fence is not
  // mistaken for a definition.
  lines.forEach((line, i) => {
    const match = line.match(/^\s{0,3}\[[^\]^]+\]:\s*(\S+)/);
    if (match && !ABSOLUTE.test(match[1])) {
      problems.push(
        `${rel}:${i + 1}: reference-style link target "${match[1]}" is ` +
          `relative — registries resolve it against themselves, not GitHub. ` +
          `Use an absolute URL.`
      );
    }
  });

  // Bare <img src="..."> too — HTML is common in badge rows and PyPI sanitises
  // it inconsistently, but a relative src is broken everywhere regardless.
  for (const match of text.matchAll(/<img\s[^>]*src=["']([^"']+)["']/gi)) {
    if (!ABSOLUTE.test(match[1])) {
      problems.push(
        `${rel}: <img src="${match[1]}"> is relative — use an absolute URL`
      );
    }
  }

  // <a href="..."> for the same reason as <img>. Badge rows routinely wrap an
  // image in a link, so a repo can pass the <img> check and still ship a
  // relative anchor beside it.
  for (const match of text.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi)) {
    if (!ABSOLUTE.test(match[1])) {
      problems.push(
        `${rel}: <a href="${match[1]}"> is relative — use an absolute URL`
      );
    }
  }
}

// -- report -------------------------------------------------------------------
const checked = [...sources].map((f) => `docs/${basename(f)}`).sort();

if (problems.length > 0) {
  console.error(`README source gate FAILED (${problems.length} problem(s)):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\nChecked ${taskFiles.length} copy step(s) and ${checked.length} source file(s).`
  );
  process.exit(1);
}

console.log(
  `README source gate OK — ${taskFiles.length} copy step(s), ` +
    `${checked.length} source(s): ${checked.join(', ')}`
);
