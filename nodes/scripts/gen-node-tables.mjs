/**
 * nodes:docs-generate — write the generated reference block into the marked
 * region of each node's co-located README.md.
 *
 * The block carries exactly what the docs site renders from it: the node's
 * Dependencies (parsed from requirements.txt) and a Source link to the node's
 * directory on the repo's default branch. The site lifts the Source section
 * into a "View source" breadcrumb action (packages/docs/scripts/lib/gather.js);
 * everything else on a node page is hand-authored prose, so README.md, the
 * rendered page, and the LLM .md surface all carry the same content.
 *
 * The generated content lives strictly between the markers; hand-written prose
 * around them is preserved. The co-located doc is README.md when it
 * already carries the generated markers (GitHub-standard naming — README.md
 * renders in the folder view); a legacy README without markers is never
 * touched. Nodes with neither are skipped (docs are authored/migrated
 * separately). Pass node names as CLI args to restrict generation; no args
 * regenerates every node.
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODES_DIR = path.join(HERE, '..', 'src', 'nodes');

const START = '<!-- ROCKETRIDE:GENERATED:PARAMS START -->';
const END = '<!-- ROCKETRIDE:GENERATED:PARAMS END -->';

// Source links point at the node's directory on the open-source repo's default
// branch, derived once from git so the link tracks renames instead of pinning a
// branch. Both fall back to the canonical public values off a clean checkout.
const DEFAULT_BRANCH = resolveDefaultBranch();
const REPO_SLUG = resolveRepoSlug();

function git(args, fallback) {
	try {
		return execFileSync('git', args, { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return fallback;
	}
}

function resolveDefaultBranch() {
	const ref = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], '');
	const branch = ref.replace(/^origin\//, '').trim();
	return branch || 'develop';
}

function resolveRepoSlug() {
	const url = git(['remote', 'get-url', 'origin'], '');
	const m = /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
	return m ? m[1] : 'rocketride-org/rocketride-server';
}

function esc(v) {
	return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** Dependencies section parsed from requirements.txt (pins kept, comments dropped). */
function dependenciesBlock(dir) {
	const file = path.join(dir, 'requirements.txt');
	if (!existsSync(file)) return '';
	const rows = [];
	for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const m = /^([A-Za-z0-9._-]+(?:\[[^\]]*\])?)(.*)$/.exec(line);
		const pkg = m ? m[1] : line;
		const constraint = m ? m[2].trim() : '';
		rows.push(`- \`${esc(pkg)}\`${constraint ? ` \`${esc(constraint)}\`` : ''}`);
	}
	if (!rows.length) return '';
	return ['## Dependencies', '', ...rows].join('\n');
}

// GitHub mark (Invertocat), inline so it renders the real logo in the CommonMark
// docs (.md is not MDX here, so a JSX icon component won't work). `currentColor`
// makes it inherit the link color and theme with light/dark.
const GITHUB_MARK =
	'<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em">' +
	'<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

/** Source section: a GitHub-mark "View source" link to the node directory. */
function sourceBlock(name) {
	const rel = `nodes/src/nodes/${name}`;
	const url = `https://github.com/${REPO_SLUG}/tree/${DEFAULT_BRANCH}/${rel}`;
	return ['## Source', '', `[${GITHUB_MARK} View source](${url})`].join('\n');
}

function readJsonSilently(filepath) {
	try {
		let text = readFileSync(filepath, 'utf8');
		// Strip comments
		text = text.replace(/^[ \t]*\/\/.*$/gm, '');
		text = text.replace(/(?<!:)\/\/.*$/gm, '');
		text = text.replace(/\/\*[\s\S]*?\*\//g, '');
		return JSON.parse(text);
	} catch (e) {
		console.error(`Error parsing JSON at ${filepath}:`, e);
		return null;
	}
}

function formatDescription(field) {
	let desc = field.description || '';
	if (Array.isArray(desc)) desc = desc.join('');
	desc = String(desc).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br/>').trim();
	let title = field.title || '';
	if (title) {
		title = String(title).replace(/\|/g, '\\|').trim();
		return desc ? `**${title}**<br/>${desc}` : `**${title}**`;
	}
	return desc;
}

function formatDefault(field) {
	if (field.const !== undefined) {
		return `const: \`${JSON.stringify(field.const)}\``;
	}
	if (field.default !== undefined) {
		return `\`${JSON.stringify(field.default)}\``;
	}
	return '';
}

function schemaBlock(dir) {
	const files = readdirSync(dir).filter(f => /^services.*\.json$/.test(f)).sort();
	if (!files.length) return '';
	
	const serviceBlocks = [];
	for (const filename of files) {
		const filePath = path.join(dir, filename);
		const data = readJsonSilently(filePath);
		if (!data || !data.fields) continue;
		
		const title = data.title || '';
		const heading = files.length > 1 ? (title ? `### ${title} (\`${filename}\`)` : `### \`${filename}\``) : '';
		
		const fieldKeys = Object.keys(data.fields).sort();
		const rows = [];
		for (const k of fieldKeys) {
			const field = data.fields[k];
			if (field && field.object !== undefined) continue; // Skip profile definitions
			
			const type = field.type || '';
			const desc = formatDescription(field);
			const def = formatDefault(field);
			rows.push(`| \`${esc(k)}\` | ${type ? `\`${esc(type)}\`` : ''} | ${desc} | ${def} |`);
		}
		
		const sectionParts = [];
		if (heading) sectionParts.push(heading, '');
		if (rows.length) {
			sectionParts.push('| Field | Type | Description | Default |', '|---|---|---|---|', ...rows);
		} else {
			sectionParts.push('_No configuration fields._');
		}
		serviceBlocks.push(sectionParts.join('\n'));
	}
	
	if (!serviceBlocks.length) return '';
	return ['## Schema', '', serviceBlocks.join('\n\n')].join('\n');
}

function generateBlock(dir, name) {
	const parts = [];
	
	const schema = schemaBlock(dir);
	if (schema) parts.push(schema);
	
	const deps = dependenciesBlock(dir);
	if (deps) parts.push(deps);
	
	parts.push(sourceBlock(name));
	
	return parts.map((p) => p.trim()).filter(Boolean).join('\n\n').trim();
}

function injectBlock(docPath, block) {
	const original = readFileSync(docPath, 'utf8').replace(/\r\n/g, '\n');
	const wrapped = `${START}\n<!-- Generated by nodes:docs-generate. Do not edit by hand. -->\n\n${block}\n${END}`;
	const s = original.indexOf(START);
	const e = original.indexOf(END);
	let next;
	if (s !== -1 && e !== -1 && e > s) {
		next = original.slice(0, s) + wrapped + original.slice(e + END.length);
	} else {
		next = `${original.replace(/\s*$/, '')}\n\n---\n\n${wrapped}\n`;
	}
	if (next !== original) {
		writeFileSync(docPath, next);
		return true;
	}
	return false;
}

/** The node's co-located doc: README.md that carries the markers. */
function resolveDocPath(dir) {
	const readme = path.join(dir, 'README.md');
	if (existsSync(readme) && readFileSync(readme, 'utf8').includes(START)) return readme;
	return null;
}

function main() {
	// Only regenerate docs on release-track branches to avoid polluting feature
	// branch diffs with source-link changes (branch name is baked into URLs).
	const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], '');
	const allowed = new Set(['main', 'stage', 'develop']);
	if (branch && !allowed.has(branch)) {
		console.log(`nodes:docs-generate skipped (branch: ${branch}, only runs on ${[...allowed].join('/')})`);
		return;
	}

	// Optional CLI args restrict generation to the named node(s); no args = all.
	const only = new Set(process.argv.slice(2));
	let updated = 0;
	let skipped = 0;
	for (const name of readdirSync(NODES_DIR)) {
		if (only.size && !only.has(name)) continue;
		const dir = path.join(NODES_DIR, name);
		const docPath = resolveDocPath(dir);
		if (!docPath) {
			skipped++;
			continue;
		}
		if (injectBlock(docPath, generateBlock(dir, name))) updated++;
	}
	console.log(`nodes:docs-generate updated ${updated} docs, skipped ${skipped} without a co-located doc`);
}

main();
