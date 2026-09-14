/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ServiceSummaryLite, StoreFs } from './types';

const run = promisify(execFile);
/** Store-relative root every project pipe lives under (`.projects/<dir>/<file>.pipe`). Exported so callers reading a single store path (e.g. `describePipeShape` in session.ts) prefix it the same way this file does. */
export const PROJECT_DIR = '.projects';

const GIT_ENV = {
	GIT_AUTHOR_NAME: 'Rocket Agent',
	GIT_AUTHOR_EMAIL: 'agent@rocketride.ai',
	GIT_COMMITTER_NAME: 'Rocket Agent',
	GIT_COMMITTER_EMAIL: 'agent@rocketride.ai',
	// No global/user config: snapshot behavior must not vary by host.
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_SYSTEM: '/dev/null',
};

// Only what the git binary itself needs to run (resolve its own path, find scratch
// space). Everything else in this (server) process's env — inference keys, vault
// URLs, encryption keys — is deliberately withheld from the child process.
const SAFE_ENV_PASSTHROUGH = ['PATH', 'HOME', 'SYSTEMROOT', 'TEMP', 'TMP'] as const;

function gitEnv(): NodeJS.ProcessEnv {
	const passthrough: NodeJS.ProcessEnv = {};
	for (const key of SAFE_ENV_PASSTHROUGH) {
		const value = process.env[key];
		if (value !== undefined) passthrough[key] = value;
	}
	return { ...passthrough, ...GIT_ENV };
}

async function git(workspaceDir: string, args: string[]): Promise<string> {
	// GIT_CEILING_DIRECTORIES pins repository discovery to the workspace itself: a workspace that
	// has no .git yet (or lost it) must fail loudly, never fall through to an enclosing checkout.
	// Without it, `add -A` + `commit` from such a workspace once landed in the repo that happened
	// to contain the temp dir (2026-09-14).
	const env = { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(workspaceDir)) };
	const { stdout } = await run('git', args, { cwd: workspaceDir, env });
	return stdout;
}

/** Pipeline file extensions mirrored between the project store and the workspace. Kept in lockstep
 *  with the UI's `PIPELINE_EXTENSIONS` (rocket-ui/src/utils/projectStore.ts) so both spellings a user
 *  or the agent can write are mirrored — the old flat mirror only handled bare `.pipe`. */
export const PIPE_EXTS = ['.pipe', '.pipe.json'] as const;

/** Whether a store/workspace path names a pipeline file (carries one of {@link PIPE_EXTS}). */
export function isPipePath(p: string): boolean {
	return PIPE_EXTS.some((ext) => p.endsWith(ext));
}

/**
 * Every pipeline file under the project store (`.projects/`), as paths RELATIVE to PROJECT_DIR
 * (e.g. `qa.pipe`, `examples/test.pipe`) — walked recursively via `store.fsListDir`. This is how a
 * new session's workspace mirrors the user's whole cwd (all prior pipes + nested folders), not just
 * the one opened pipe. Best-effort per directory: a listing error for one subtree is swallowed so
 * the rest still seed. Returns `[]` when the store can't list (stub store without `fsListDir`).
 */
export async function listStorePipes(store: StoreFs): Promise<string[]> {
	if (!store.fsListDir) return [];
	const out: string[] = [];
	const walk = async (rel: string): Promise<void> => {
		const storePath = rel ? `${PROJECT_DIR}/${rel}` : PROJECT_DIR;
		let entries: Array<{ name: string; type: 'file' | 'dir' }>;
		try {
			({ entries } = await store.fsListDir!(storePath));
		} catch {
			return; // unreadable subtree — skip, never abort the whole walk
		}
		for (const e of entries) {
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.type === 'dir') await walk(childRel);
			else if (e.type === 'file' && isPipePath(e.name)) out.push(childRel);
		}
	};
	await walk('');
	return out;
}

export interface SeedOpts {
	workspaceDir: string;
	pipePath: string;      // project-store-relative, e.g. 'demo/qa.pipe' — the OPENED pipe (shape-hint anchor)
	store: StoreFs;
	docsDir: string;       // built assets/docs
	assetsDir: string;     // built assets root (AGENTS.md, agent/rr-builder.md)
}

export async function seedWorkspace(opts: SeedOpts): Promise<{ pipeFile: string }> {
	await fsp.mkdir(opts.workspaceDir, { recursive: true });
	// 1. Mirror EVERY pipeline file in the project store into the workspace, PRESERVING subfolders,
	//    byte-identical (string IO, no JSON round-trip). The workspace is a faithful picture of the
	//    user's cwd, so the agent sees (and can edit) prior pipes and nested folders — not just the
	//    one that was opened. Best-effort per file: a store read that fails for one pipe never blocks
	//    the others (or the essential asset seeding below). The explicitly-opened `pipePath` is folded
	//    in even if the listing missed/omitted it (e.g. a brand-new pipe not yet flushed to the store).
	const relPaths = await listStorePipes(opts.store);
	if (opts.pipePath && !relPaths.includes(opts.pipePath)) relPaths.push(opts.pipePath);
	for (const rel of relPaths) {
		const dest = path.join(opts.workspaceDir, rel);
		// Containment guard: never let a store-supplied path escape the workspace root.
		if (path.relative(opts.workspaceDir, dest).startsWith('..')) continue;
		try {
			const content = await opts.store.fsReadString(`${PROJECT_DIR}/${rel}`);
			await fsp.mkdir(path.dirname(dest), { recursive: true });
			await fsp.writeFile(dest, content, 'utf8');
		} catch {
			// best-effort — skip a pipe that fails to read; the seed (and session) still proceeds
		}
	}
	const pipeFile = opts.pipePath || '';
	// 2. AGENTS.md (generated by scripts/build-assets.mjs).
	await fsp.copyFile(path.join(opts.assetsDir, 'AGENTS.md'), path.join(opts.workspaceDir, 'AGENTS.md'));
	// 3. docs/.
	const docsOut = path.join(opts.workspaceDir, 'docs');
	await fsp.mkdir(docsOut, { recursive: true });
	for (const entry of await fsp.readdir(opts.docsDir)) {
		if (entry.endsWith('.md')) await fsp.copyFile(path.join(opts.docsDir, entry), path.join(docsOut, entry));
	}
	// 4. .opencode/agent/rr-builder.md.
	const agentOut = path.join(opts.workspaceDir, '.opencode', 'agent');
	await fsp.mkdir(agentOut, { recursive: true });
	await fsp.copyFile(path.join(opts.assetsDir, 'agent', 'rr-builder.md'), path.join(agentOut, 'rr-builder.md'));
	// 5. skills/ — the Layer-3 lifecycle skill corpus (built into assetsDir by build-assets.mjs
	// from apps/rocket-agent/assets-src/skills). `enter_phase` (synthetics.ts) reads each phase's
	// SKILL.md out of this tree via `phaseBody` below; copying the whole tree (not just the four
	// SKILL.md files) keeps each skill's own relative references — ERROR_TABLE.md, examples/*.pipe,
	// PIPELINE_ANTIPATTERNS.md — resolvable from inside the workspace.
	await fsp.cp(path.join(opts.assetsDir, 'skills'), path.join(opts.workspaceDir, 'skills'), { recursive: true });
	return { pipeFile };
}

/** Lifecycle phases `enter_phase` can activate — each maps to `skills/rocketride-<name>-pipelines/`. */
const PHASE_NAMES = ['designing', 'configuring', 'running', 'debugging'] as const;
type PhaseName = (typeof PHASE_NAMES)[number];

function isPhaseName(name: string): name is PhaseName {
	return (PHASE_NAMES as readonly string[]).includes(name);
}

/**
 * Read a lifecycle phase's seeded skill body: `<skillsDir>/rocketride-<name>-pipelines/SKILL.md`,
 * prefixed with a resolved `Base directory: <abs path>` line so the body's own relative references
 * (`ERROR_TABLE.md`, `examples/…`, `PIPELINE_ANTIPATTERNS.md`) can be resolved by whoever reads it
 * next (the model, told where the skill's other files live). Synchronous and side-effect-free —
 * `enter_phase` (synthetics.ts) calls this inline from its `SyntheticCtx.phaseBody` — and takes
 * `skillsDir` as a parameter (rather than reaching for a workspace path itself) so it's testable
 * against a plain fixture directory. Throws a clear, catchable error for any name outside the four
 * lifecycle phases; `handleSyntheticToolCall` turns that into an MCP error envelope, never a crash.
 */
export function phaseBody(name: string, skillsDir: string): string {
	if (!isPhaseName(name)) {
		throw new Error(`enter_phase: unknown phase "${name}" (expected one of ${PHASE_NAMES.join(', ')})`);
	}
	const dir = path.join(skillsDir, `rocketride-${name}-pipelines`);
	const body = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
	return `Base directory: ${path.resolve(dir)}\n\n${body}`;
}

export async function initGit(workspaceDir: string): Promise<void> {
	await git(workspaceDir, ['init', '--quiet', '--initial-branch=session']);
	await git(workspaceDir, ['add', '-A']);
	// --allow-empty: a session legitimately starts with no user files (the sidebar "New
	// session" creates one with no pipePath; the agent authors the pipe from scratch). Without
	// this, `git commit` exits 1 ("nothing to commit") and session creation 500s. The baseline
	// commit must always exist so commitTurn()/revert have a root to anchor to.
	await git(workspaceDir, ['commit', '--quiet', '--allow-empty', '-m', 'session start']);
}

/** One commit per agent file-change event (per-turn granularity, decided 2026-08-11). Null when clean. */
export async function commitTurn(workspaceDir: string, label: string): Promise<string | null> {
	await git(workspaceDir, ['add', '-A']);
	const status = await git(workspaceDir, ['status', '--porcelain']);
	if (!status.trim()) return null;
	await git(workspaceDir, ['commit', '--quiet', '-m', label]);
	return (await git(workspaceDir, ['rev-parse', 'HEAD'])).trim();
}

export async function listTurns(workspaceDir: string): Promise<Array<{ sha: string; label: string; at: string }>> {
	const out = await git(workspaceDir, ['log', '--format=%H%x09%s%x09%cI']);
	return out.trim().split('\n').filter(Boolean).map((line) => {
		const [sha, label, at] = line.split('\t');
		return { sha, label, at };
	});
}

/** Restore any prior turn's content as a NEW commit — history is never rewritten (audit trail). */
export async function revertTo(workspaceDir: string, sha: string): Promise<string> {
	await git(workspaceDir, ['checkout', sha, '--', '.']);
	// checkout doesn't delete files created after <sha>; clean them so the tree matches the turn.
	await git(workspaceDir, ['clean', '-fd']);
	const commit = await commitTurn(workspaceDir, `revert to ${sha.slice(0, 8)}`);
	return commit ?? sha;
}

export interface SaveBackOpts {
	workspaceDir: string;
	store: StoreFs;
	/** Workspace-relative pipeline paths to write back — change-scoped by the caller (see
	 *  {@link changedPipePaths}), e.g. `qa.pipe`, `examples/test.pipe`. Each mirrors to
	 *  `.projects/<rel>`, preserving folders. */
	files: string[];
}

/**
 * Workspace-relative pipeline files changed since the session baseline (the root commit created by
 * `initGit`). Scopes the idle save-back to only what the agent actually touched, so a full-tree
 * workspace mirror does NOT rewrite (and re-layout / re-emit `saved` for) every untouched pipe on
 * every idle. Covers created + modified + renamed (`--diff-filter=ACMR`) across the whole session,
 * plus any not-yet-committed working-tree pipe changes (the idle backstop can fire before a commit).
 * Deletions are intentionally excluded — save-back never removes store files. Best-effort: any git
 * error yields `[]` (the per-edit write-through already handled the common path).
 */
export async function changedPipePaths(workspaceDir: string): Promise<string[]> {
	try {
		const root = (await git(workspaceDir, ['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n').pop()!.trim();
		const set = new Set<string>();
		const committed = await git(workspaceDir, ['diff', '--name-only', '--diff-filter=ACMR', root, 'HEAD']);
		for (const line of committed.split('\n')) {
			const p = line.trim();
			if (p && isPipePath(p)) set.add(p);
		}
		const wip = await git(workspaceDir, ['status', '--porcelain']);
		for (const line of wip.split('\n')) {
			// porcelain: "XY <path>" (a rename shows "R  old -> new" — take the destination path).
			const raw = line.slice(3).trim();
			if (!raw) continue;
			const p = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4).trim() : raw;
			if (isPipePath(p)) set.add(p);
		}
		return [...set];
	} catch {
		return [];
	}
}

/**
 * Write each workspace-root *.pipe back to the project store, PER FILE. A file that isn't valid
 * JSON is skipped (never written) and returned in `skipped` — one malformed/half-built pipe never
 * blocks the valid ones. This is the filesystem-sync contract behind auto-save-on-idle: every valid
 * change propagates to the store on its own; the caller surfaces `skipped` for visibility.
 */
/**
 * Read the store's current version of a pipe and return each component's saved `ui.position` by id.
 * Returns undefined when there is no readable prior version (first save) or none carry a position —
 * the caller then computes a fresh layout for everything.
 */
async function readPipeLayout(store: StoreFs, storePath: string): Promise<Map<string, { x: number; y: number }> | undefined> {
	let prior: unknown;
	try {
		prior = JSON.parse(await store.fsReadString(storePath));
	} catch {
		return undefined; // no prior version, or unreadable/invalid — treat as first save
	}
	const comps = (prior as { components?: Array<Record<string, any>> })?.components;
	if (!Array.isArray(comps)) return undefined;
	const map = new Map<string, { x: number; y: number }>();
	for (const c of comps) {
		const pos = c?.ui?.position;
		if (typeof c?.id === 'string' && typeof pos?.x === 'number' && typeof pos?.y === 'number') {
			map.set(c.id, { x: pos.x, y: pos.y });
		}
	}
	return map.size > 0 ? map : undefined;
}

/**
 * Ensure every component has a `ui.position`, so a pipe the agent authored (or rewrote) without
 * coordinates opens laid out instead of stacked at the origin — WITHOUT discarding a layout the user
 * already arranged.
 *
 * Two passes:
 *  1. Re-apply positions from `prior` (the last-saved store version) by component id. The agent
 *     frequently rewrites the whole pipe with its `write` tool and drops the `ui` blocks; this pass
 *     restores the user's manual layout so only genuinely-NEW nodes remain unplaced.
 *  2. Deterministic placement for whatever is still unplaced: a node's COLUMN is its longest
 *     dependency depth (sources at column 0) via `input[].from`; nodes sharing a column stack
 *     vertically. Same graph → same coordinates, and a new node never moves existing ones.
 *
 * Mutates `pipe` in place; returns true when it changed anything (so the caller re-serializes).
 */
function ensurePipeLayout(pipe: unknown, prior?: Map<string, { x: number; y: number }>): boolean {
	const comps = (pipe as { components?: Array<Record<string, any>> })?.components;
	if (!Array.isArray(comps) || comps.length === 0) return false;
	const hasPos = (c: Record<string, any>): boolean => typeof c?.ui?.position?.x === 'number' && typeof c?.ui?.position?.y === 'number';

	let changed = false;
	// Pass 1: restore each component's last-saved position (preserves a user's manual arrangement
	// across an agent rewrite that stripped the `ui` blocks). Explicit positions in the file win.
	if (prior) {
		for (const c of comps) {
			if (hasPos(c)) continue;
			const p = typeof c?.id === 'string' ? prior.get(c.id) : undefined;
			if (p) {
				c.ui = { ...(c.ui ?? {}), position: { x: p.x, y: p.y } };
				changed = true;
			}
		}
	}
	if (comps.every(hasPos)) return changed;

	const byId = new Map<string, Record<string, any>>();
	for (const c of comps) if (typeof c?.id === 'string') byId.set(c.id, c);

	const depth = new Map<string, number>();
	const active = new Set<string>();
	const depthOf = (id: string): number => {
		const cached = depth.get(id);
		if (cached !== undefined) return cached;
		if (active.has(id)) return 0; // cycle guard — treat as a source
		active.add(id);
		const inputs = byId.get(id)?.input;
		let d = 0;
		if (Array.isArray(inputs)) {
			for (const inp of inputs) {
				const from = inp?.from;
				if (typeof from === 'string' && byId.has(from) && from !== id) d = Math.max(d, depthOf(from) + 1);
			}
		}
		active.delete(id);
		depth.set(id, d);
		return d;
	};

	const rowByCol = new Map<number, number>();
	for (const c of comps) {
		if (hasPos(c)) continue;
		const col = typeof c?.id === 'string' ? depthOf(c.id) : 0;
		const row = rowByCol.get(col) ?? 0;
		rowByCol.set(col, row + 1);
		c.ui = { ...(c.ui ?? {}), position: { x: 40 + col * 260, y: 120 + row * 150 } };
		changed = true;
	}
	return changed;
}

export interface SaveBackOneOpts {
	store: StoreFs;
	workspaceDir: string;
	/** Project-store root the file's relative path hangs off, WITHOUT a trailing slash — always `.projects` now that the mirror preserves subfolders (the folder lives inside `file`). Store path written to is `${storeRoot}/${file}`. */
	storeRoot: string;
	/** Workspace-relative pipeline path, which MAY contain subfolders (e.g. `qa.pipe` or `examples/test.pipe` — the mirror preserves the store's tree; see `seedWorkspace`). */
	file: string;
}

/**
 * Write-through for ONE workspace `.pipe` file to the project store, sharing the exact same
 * position-preservation guarantees as {@link saveBack} (which now calls this per file — one
 * implementation, two call sites: per-edit write-through and the idle backstop). Invalid JSON is
 * never fatal: it's reported via `skipped` so a half-written file mid-agent-edit doesn't throw,
 * it's simply retried on the next write-through or the idle backstop.
 */
export async function saveBackOne(opts: SaveBackOneOpts): Promise<{ written: boolean; skipped: string | null }> {
	const { store, workspaceDir, storeRoot, file } = opts;
	const text = await fsp.readFile(path.join(workspaceDir, file), 'utf8');
	let pipe: unknown;
	try {
		pipe = JSON.parse(text);
	} catch {
		return { written: false, skipped: file };
	}
	const storePath = `${storeRoot}/${file}`;
	// The agent routinely omits `ui.position` (and often rewrites the whole pipe, dropping the `ui`
	// blocks entirely), which loads every node stacked at (0,0) and forces the user to hit "auto
	// reposition" — and that reposition dirties the open document, which then blocks the canvas from
	// reflecting the agent's next edit. Carry the last-saved layout forward (so a user's manual
	// arrangement survives an agent rewrite) and give a deterministic left-to-right position to only
	// the genuinely-new nodes, so the pipe opens already laid out AND the document stays clean.
	// Never fatal: on any layout error we fall back to the untouched text.
	let out = text;
	try {
		const prior = await readPipeLayout(store, storePath);
		if (ensurePipeLayout(pipe, prior)) out = `${JSON.stringify(pipe, null, 2)}\n`;
	} catch {
		out = text;
	}
	await store.fsWriteString(storePath, out);
	return { written: true, skipped: null };
}

export async function saveBack(opts: SaveBackOpts): Promise<{ written: string[]; skipped: string[] }> {
	const written: string[] = [];
	const skipped: string[] = [];
	for (const rel of opts.files) {
		const result = await saveBackOne({ store: opts.store, workspaceDir: opts.workspaceDir, storeRoot: PROJECT_DIR, file: rel });
		if (result.skipped) skipped.push(result.skipped);
		else written.push(`${PROJECT_DIR}/${rel}`);
	}
	return { written, skipped };
}

/**
 * Render the live component catalog as a compact, greppable markdown doc seeded at
 * `docs/COMPONENTS.md`. One line per real provider (`name (classType) — description · lanes`) so
 * the agent can `grep pdf` / `grep parse` to find a REAL provider instead of inventing one, then
 * `describe_component <name>` for config. The full `list_components` MCP output is ~60 KB and gets
 * truncated before the model sees it — this is the consumable substitute.
 */
export function formatComponentCatalog(services: Record<string, ServiceSummaryLite>): string {
	const lines = [
		'# RocketRide Components — this server\'s LIVE catalog',
		'',
		'Every provider that actually exists on this server is listed below. To pick a provider for a',
		'capability, grep this file (e.g. `grep -i pdf`, `grep -i parse`, `grep -i embed`). Use ONLY a',
		'`provider` name that appears here — if it is not in this list it does not exist, so never invent',
		'one (there is no `pdf_parser`). Then call `describe_component <name>` for its exact config schema.',
		'Do NOT dump `list_components` — it is ~60 KB and gets truncated.',
		'',
		'Format: `- **provider** (classType) — description · lanes: input→[outputs]`',
		'',
	];
	for (const name of Object.keys(services).sort()) {
		const s = services[name] ?? {};
		const cls = (s.classType ?? []).join('/') || 'component';
		// One concise sentence — full descriptions are ~400 chars each and bloat the file / grep hits.
		const full = (s.description ?? s.title ?? '').replace(/\s+/g, ' ').trim();
		const firstSentence = full.split(/(?<=\.)\s/)[0];
		const desc = (firstSentence.length <= 160 ? firstSentence : `${full.slice(0, 157).replace(/\s+\S*$/, '')}…`);
		const lanes = s.lanes
			? Object.entries(s.lanes)
					.map(([inLane, outs]) => `${inLane}→[${(outs ?? []).join(',')}]`)
					.join('  ')
			: '';
		lines.push(`- **${name}** (${cls})${desc ? ` — ${desc}` : ''}${lanes ? ` · lanes: ${lanes}` : ''}`);
	}
	return lines.join('\n') + '\n';
}

export async function workspaceSize(dir: string): Promise<number> {
	let total = 0;
	for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) total += await workspaceSize(p);
		else if (entry.isFile()) total += (await fsp.stat(p)).size;
	}
	return total;
}
