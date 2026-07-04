// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Cut the CHANGELOG "[Unreleased]" section into a dated, versioned section and
 * open a fresh, empty "[Unreleased]" above it.
 *
 * Run this in the version-bump pull request (the same PR that bumps
 * package.json / pyproject.toml versions) so the cut rides the normal
 * develop -> stage -> main promotion. Do NOT auto-commit a cut to `main` from
 * CI: the release workflow triggers on push-to-main and would re-fire, and
 * main's CHANGELOG would diverge from develop and conflict on the next merge.
 *
 * The version label is the **server** (root package.json) version, since this
 * is the rocketride-server monorepo and all five packages ship as one
 * synchronized release train sharing this CHANGELOG. The release workflow's
 * "Set release body" step emits this section as the GitHub Release notes for
 * every package in the train (see .github/workflows/_release.yaml and
 * RELEASE.md -> "Release Notes").
 *
 * Usage:
 *   node scripts/release/cut-changelog.mjs [version] [date]
 *
 *   version  semver to label the cut section (default: root package.json .version)
 *   date     ISO date YYYY-MM-DD for the section header (default: today, UTC)
 *
 * Examples:
 *   node scripts/release/cut-changelog.mjs            # cut at the current root version, today
 *   node scripts/release/cut-changelog.mjs 3.2.0      # cut as [3.2.0] - <today>
 *   node scripts/release/cut-changelog.mjs 3.2.0 2026-06-05
 *
 * Exit codes: 0 ok, 1 nothing to cut / already cut / bad version, 2 bad usage.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const changelogPath = resolve(repoRoot, 'CHANGELOG.md');

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  // Print the leading JSDoc usage block and exit cleanly.
  console.log(
    'Usage: node scripts/release/cut-changelog.mjs [version] [date]\n' +
      '  Archive [Unreleased] as a dated, versioned CHANGELOG section and open a fresh [Unreleased].\n' +
      '  version  semver label (default: root package.json .version)\n' +
      '  date     ISO YYYY-MM-DD (default: today, UTC)',
  );
  process.exit(0);
}

const version =
  argv[0] ?? JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+([-+].+)?$/.test(version)) {
  fail(1, `Refusing to cut: "${version}" is not a semver version.`);
}

const date = argv[1] ?? new Date().toISOString().slice(0, 10);
// Shape AND validity: reject impossible dates like 2026-13-40 or 2026-02-30.
// For ISO-8601 strings JS yields an Invalid Date (NaN) on out-of-range parts;
// the round-trip also catches any silent normalization. `||` short-circuits,
// so toISOString() never runs on a NaN date.
const parsedDate = new Date(`${date}T00:00:00Z`);
if (
  !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
  Number.isNaN(parsedDate.getTime()) ||
  parsedDate.toISOString().slice(0, 10) !== date
) {
  fail(2, `Invalid date "${date}" — expected a real ISO date (YYYY-MM-DD).`);
}

const original = readFileSync(changelogPath, 'utf8');
const lines = original.split('\n');

const unreleasedIdx = lines.findIndex((line) => /^## \[Unreleased\b/.test(line));
if (unreleasedIdx === -1) {
  fail(1, 'No "## [Unreleased]" section found in CHANGELOG.md — nothing to cut.');
}

const versionHeader = new RegExp(`^## \\[${version.replace(/[.+]/g, '\\$&')}\\]`);
if (lines.some((line) => versionHeader.test(line))) {
  fail(1, `CHANGELOG.md already has a "## [${version}]" section — already cut for this version?`);
}

// Replace the single "## [Unreleased] ..." header line with a fresh empty
// Unreleased header, a blank line, then the dated version header. Everything
// that followed the old Unreleased header stays put — it becomes the body of
// the newly-dated version section.
lines.splice(
  unreleasedIdx,
  1,
  `## [Unreleased] — since ${date}`,
  '',
  `## [${version}] - ${date}`,
);

writeFileSync(changelogPath, lines.join('\n'));
console.log(`Cut [Unreleased] -> [${version}] - ${date}; opened a fresh [Unreleased].`);
