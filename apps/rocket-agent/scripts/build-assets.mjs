import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
// docs/agents/ is the repo's agent-facing documentation (see docs/agents/README.md):
//   context/  — the ROCKETRIDE_*.md reference set that ships to every workspace
//   skills/   — the hand-curated pipeline-builder skill set
const srcDocs = join(repo, 'docs', 'agents', 'context');
const srcSkills = join(repo, 'docs', 'agents', 'skills');
const out = join(app, 'assets');

// Every ROCKETRIDE_*.md at the context root (not stubs/) — the same set the VS Code
// extension installs into a workspace's .rocketride/docs/, so the agent and a human
// developer read identical references.
const DOCS = readdirSync(srcDocs).filter((f) => /^ROCKETRIDE_.*\.md$/.test(f)).sort();

// Start from an empty assets/ so a renamed or removed source never lingers as a stale copy.
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'docs'), { recursive: true });
mkdirSync(join(out, 'agent'), { recursive: true });
for (const doc of DOCS) cpSync(join(srcDocs, doc), join(out, 'docs', doc));
cpSync(join(app, 'assets-src', 'rr-builder.md'), join(out, 'agent', 'rr-builder.md'));

// Layer-3 lifecycle skill corpus (seeded into every session workspace by seedWorkspace, read by
// enter_phase via phaseBody). Bundled whole — SKILL.md plus each skill's own reference docs and
// examples/*.pipe — so relative references inside a SKILL.md resolve once seeded.
cpSync(srcSkills, join(out, 'skills'), { recursive: true });

// AGENTS.md is auto-loaded into EVERY turn's context, so it MUST stay lean. It used to
// concatenate the full pipeline guide (~17k tokens), which made every request
// huge and slow. Those now live only in docs/ (copied above) for the agent to read on demand;
// AGENTS.md is just the preamble that points at them.
writeFileSync(join(out, 'AGENTS.md'), readFileSync(join(app, 'assets-src', 'agents-preamble.md'), 'utf8'));
console.log(`[build-assets] wrote ${out}`);
