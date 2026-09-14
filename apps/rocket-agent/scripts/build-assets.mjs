import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const srcDocs = join(repo, 'docs', 'agents');
const out = join(app, 'assets');

const DOCS = [
	'ROCKETRIDE_QUICKSTART.md',
	'ROCKETRIDE_PIPELINE_RULES.md',
	'ROCKETRIDE_COMPONENT_REFERENCE.md',
	'ROCKETRIDE_COMMON_MISTAKES.md',
	'ROCKETRIDE_OBSERVABILITY.md',
];

mkdirSync(join(out, 'docs'), { recursive: true });
mkdirSync(join(out, 'agent'), { recursive: true });
for (const doc of DOCS) cpSync(join(srcDocs, doc), join(out, 'docs', doc));
cpSync(join(app, 'assets-src', 'rr-builder.md'), join(out, 'agent', 'rr-builder.md'));

// Layer-3 lifecycle skill corpus (seeded into every session workspace by seedWorkspace, read by
// enter_phase via phaseBody). Bundled whole — SKILL.md plus each skill's own reference docs and
// examples/*.pipe — so relative references inside a SKILL.md resolve once seeded.
cpSync(join(app, 'assets-src', 'skills'), join(out, 'skills'), { recursive: true });

// AGENTS.md is auto-loaded into EVERY turn's context, so it MUST stay lean. It used to
// concatenate the full PIPELINE_RULES + COMMON_MISTAKES (~17k tokens), which made every request
// huge and slow. Those now live only in docs/ (copied above) for the agent to read on demand;
// AGENTS.md is just the preamble that points at them.
writeFileSync(join(out, 'AGENTS.md'), readFileSync(join(app, 'assets-src', 'agents-preamble.md'), 'utf8'));
console.log(`[build-assets] wrote ${out}`);
