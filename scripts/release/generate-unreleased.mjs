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
 * Fill the CHANGELOG "[Unreleased]" section from commit history.
 *
 * Why this exists: `[Unreleased]` is maintained by hand, and in practice nobody
 * maintains it. In July 2026 the v3.4.0 cut came out **empty** — nothing had been
 * added since 8 June — which would have shipped blank GitHub Release notes for
 * all five packages across 445 commits of real work. Release notes that depend on
 * discipline are release notes that end up empty.
 *
 * Run this immediately BEFORE `cut-changelog.mjs` in the version-bump PR:
 *
 *   node scripts/release/generate-unreleased.mjs origin/main origin/stage
 *   node scripts/release/cut-changelog.mjs
 *
 * Conventional-commit prefixes map to Keep a Changelog sections:
 *   feat                      -> Added
 *   fix                       -> Fixed
 *   perf / refactor / style   -> Changed
 * Everything else (chore, docs, ci, test, build) is counted, not listed — the
 * notes are for people consuming the packages, not for the commit log.
 *
 * Anything already written under [Unreleased] by hand is preserved: generated
 * entries are appended below it, never on top of it. Curated prose beats
 * generated prose, so we never throw it away.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CHANGELOG = 'CHANGELOG.md';

const [, , fromRef = 'origin/main', toRef = 'origin/stage'] = process.argv;

const SECTION_FOR = {
  feat: 'Added',
  fix: 'Fixed',
  perf: 'Changed',
  refactor: 'Changed',
  style: 'Changed',
};
const ORDER = ['Added', 'Fixed', 'Changed'];

function subjects(from, to) {
  const out = execFileSync(
    'git',
    ['log', '--no-merges', '--format=%s', `${from}..${to}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\n').filter(Boolean);
}

function build(lines) {
  const groups = new Map(ORDER.map((s) => [s, []]));
  const counts = new Map();
  const seen = new Set();

  for (const raw of lines) {
    // Drop the trailing "(#1234)" GitHub adds on squash merges.
    const subject = raw.replace(/\s*\(#\d+\)\s*$/, '').trim();
    const m = subject.match(/^(\w+)(\(([^)]*)\))?!?:\s*(.+)$/);
    if (!m) {
      counts.set('uncategorised', (counts.get('uncategorised') ?? 0) + 1);
      continue;
    }
    const [, type, , scope, rest] = m;
    const kind = type.toLowerCase();
    counts.set(kind, (counts.get(kind) ?? 0) + 1);

    const section = SECTION_FOR[kind];
    if (!section) continue;

    const text = rest.charAt(0).toUpperCase() + rest.slice(1);
    const entry = scope ? `- **${scope}** — ${text}` : `- ${text}`;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue; // the same fix cherry-picked twice reads as noise
    seen.add(key);
    groups.get(section).push(entry);
  }

  const parts = [];
  for (const section of ORDER) {
    const items = groups.get(section);
    if (!items.length) continue;
    items.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    parts.push(`### ${section}`, '', ...items, '');
  }

  const omitted = ['chore', 'docs', 'ci', 'test', 'build', 'uncategorised']
    .map((k) => [k, counts.get(k) ?? 0])
    .filter(([, n]) => n > 0);

  if (omitted.length) {
    parts.push(
      '### Maintenance',
      '',
      `- ${omitted.map(([k, n]) => `${n} ${k}`).join(', ')} commits are omitted from the list above.`,
      '',
    );
  }

  return { body: parts.join('\n'), counts, groups };
}

const changelog = readFileSync(CHANGELOG, 'utf8');
const header = changelog.match(/^## \[Unreleased\].*$/m);
if (!header) {
  console.error('No "## [Unreleased]" heading in CHANGELOG.md — nothing to fill.');
  process.exit(1);
}

const start = header.index + header[0].length;
const nextHeading = changelog.slice(start).search(/^## \[/m);
const end = nextHeading === -1 ? changelog.length : start + nextHeading;
const existing = changelog.slice(start, end).trim();

const lines = subjects(fromRef, toRef);
if (!lines.length) {
  console.error(`No commits in ${fromRef}..${toRef} — leaving CHANGELOG untouched.`);
  process.exit(0);
}

const { body, counts, groups } = build(lines);
if (!body.trim()) {
  console.error('No user-facing commits (feat/fix/perf/refactor/style) — leaving CHANGELOG untouched.');
  process.exit(0);
}

const kept = existing ? `${existing}\n\n` : '';
const updated =
  changelog.slice(0, start) + '\n\n' + kept + body.trimEnd() + '\n\n' + changelog.slice(end);

writeFileSync(CHANGELOG, updated);

const n = (s) => groups.get(s).length;
console.log(
  `Filled [Unreleased] from ${fromRef}..${toRef}: ` +
    `${n('Added')} Added, ${n('Fixed')} Fixed, ${n('Changed')} Changed ` +
    `(${lines.length} commits scanned).`,
);
if (existing) console.log('Existing hand-written entries were preserved above the generated ones.');
