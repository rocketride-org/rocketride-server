/**
 * nodes:docs-generate — write a generated parameter/IO table into the marked
 * block of each node's co-located doc.md.
 *
 * Source of truth: nodes/src/nodes/<name>/services*.json (JSONC). Multi-service
 * nodes emit one section per service file. The generated content lives strictly
 * between the markers; hand-written prose around them is preserved. Nodes without
 * a doc.md are skipped (doc.md is authored/migrated separately).
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODES_DIR = path.join(HERE, '..', 'src', 'nodes');
const EXTRACTOR = path.join(HERE, 'extract_node_api.py');

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

let pythonBin = null;

/** Resolve a usable Python interpreter once (python3, then python). */
function resolvePython() {
	if (pythonBin) return pythonBin;
	for (const bin of ['python3', 'python']) {
		try {
			execFileSync(bin, ['--version'], { stdio: 'ignore' });
			pythonBin = bin;
			return bin;
		} catch {
			/* try next */
		}
	}
	throw new Error('gen-node-tables: no python3/python interpreter found to run extract_node_api.py');
}

/** Static class API for a node via the stdlib-ast extractor (no imports executed). */
function extractNodeApi(dir) {
	const out = execFileSync(resolvePython(), [EXTRACTOR, dir], { encoding: 'utf8' });
	return JSON.parse(out);
}

/** Strip // and block comments and trailing commas from JSONC, string-aware. */
function stripJsonc(text) {
	let out = '';
	let inStr = false;
	let quote = '';
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const n = text[i + 1];
		if (inLine) {
			if (c === '\n') {
				inLine = false;
				out += c;
			}
			continue;
		}
		if (inBlock) {
			if (c === '*' && n === '/') {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inStr) {
			out += c;
			if (c === '\\') {
				out += text[i + 1] ?? '';
				i++;
			} else if (c === quote) {
				inStr = false;
			}
			continue;
		}
		if (c === '"' || c === "'") {
			inStr = true;
			quote = c;
			out += c;
			continue;
		}
		if (c === '/' && n === '/') {
			inLine = true;
			i++;
			continue;
		}
		if (c === '/' && n === '*') {
			inBlock = true;
			i++;
			continue;
		}
		out += c;
	}
	// Remove trailing commas before } or ]
	return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseService(file) {
	return JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
}

function esc(v) {
	return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * Escape free (non-code) text destined for a Markdown table cell on the MDX
 * docs site. Beyond table-pipe escaping, neutralize the characters MDX reads as
 * JSX/expressions (`<` `>` `{` `}`) so field descriptions like
 * `<your-deployment-id>.es...` don't break `docs:build`. Do NOT use this for
 * values rendered inside backticks — MDX already treats those literally.
 */
function escCell(v) {
	return esc(v)
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\{/g, '&#123;')
		.replace(/\}/g, '&#125;');
}

function fmtTokens(n) {
	if (n == null || n === '') return '';
	const num = Number(n);
	if (!Number.isFinite(num)) return esc(n);
	if (num >= 1_000_000 && num % 1_000_000 === 0) return `${num / 1_000_000}M`;
	if (num >= 1000 && num % 1000 === 0) return `${num / 1000}K`;
	return num.toLocaleString('en-US');
}

function serviceBlock(svc, label) {
	const lines = [];
	if (label) lines.push(`### Service: \`${label}\``, '');

	const meta = [];
	if (svc.classType) meta.push(`**Class type** — ${esc([].concat(svc.classType).join(', '))}`);
	const caps = svc.capabilities ? [].concat(svc.capabilities).filter(Boolean) : [];
	if (caps.length) meta.push(`**Capabilities** — ${esc(caps.join(', '))}`);
	if (svc.protocol) meta.push(`**Protocol** — \`${esc(svc.protocol)}\``);
	if (meta.length) {
		for (const m of meta) lines.push(`- ${m}`);
		lines.push('');
	}

	if (svc.lanes && Object.keys(svc.lanes).length) {
		lines.push('**Data lanes**', '');
		for (const [input, outputs] of Object.entries(svc.lanes)) {
			const outs = [].concat(outputs).filter(Boolean);
			if (outs.length) {
				lines.push(`- \`${esc(input)}\` → ${outs.map((o) => `\`${esc(o)}\``).join(', ')}`);
			} else {
				lines.push(`- \`${esc(input)}\` — ingest lane`);
			}
		}
		lines.push('');
	}

	const profiles = svc.preconfig?.profiles;
	if (profiles && Object.keys(profiles).length) {
		lines.push('**Profiles**', '');
		for (const [key, p] of Object.entries(profiles)) {
			const bits = [];
			if (p?.title) bits.push(escCell(p.title));
			if (p?.model) bits.push(`model \`${esc(p.model)}\``);
			const ctx = fmtTokens(p?.modelTotalTokens);
			const out = fmtTokens(p?.modelOutputTokens);
			if (ctx) bits.push(`context ${ctx}`);
			if (out) bits.push(`max output ${out}`);
			lines.push(`- \`${esc(key)}\`${bits.length ? ` — ${bits.join(' · ')}` : ''}`);
		}
		lines.push('');
	}

	if (Array.isArray(svc.shape) && svc.shape.length) {
		lines.push('**Configuration sections**', '');
		for (const sec of svc.shape) {
			const props = [].concat(sec?.properties || []).map((p) => `\`${esc(p)}\``).join(', ');
			lines.push(`- **${escCell(sec?.title || sec?.section || '')}**${props ? ` — ${props}` : ''}`);
		}
		lines.push('');
	}

	const schema = schemaBullets(svc.fields);
	if (schema.length) {
		lines.push('**Schema**', '');
		for (const row of schema) lines.push(row);
		lines.push('');
	}

	return lines.join('\n');
}

/** Join a string-or-array text value (descriptions are sometimes split arrays). */
function joinText(v) {
	if (Array.isArray(v)) return v.join('');
	return v == null ? '' : String(v);
}

/**
 * One bullet per user-facing field in `fields`, shaped as
 * `- **Title** (\`name\`) — \`type\`, default \`x\`. Description`. Skips pure
 * layout/composition entries (those built from `object` / `properties`, and
 * bare object-type section labels) which carry no input.
 */
function schemaBullets(fields) {
	if (!fields || typeof fields !== 'object') return [];
	const rows = [];
	for (const [name, def] of Object.entries(fields)) {
		if (!def || typeof def !== 'object') continue;
		if ('object' in def || 'properties' in def) continue; // composition/layout node
		if (def.type === 'object') continue; // UI section label, not an input
		const hasContent = ['type', 'title', 'description', 'const', 'default'].some((k) => k in def);
		if (!hasContent) continue;

		// Lead with the human title (bold) plus the config key, or just the key.
		const lead = def.title ? `**${escCell(def.title)}** (\`${esc(name)}\`)` : `\`${esc(name)}\``;

		const meta = [];
		if (def.type) meta.push(`\`${esc(def.type)}\``);
		if ('const' in def) meta.push(`const \`${esc(def.const)}\``);
		else if ('default' in def && def.default !== '') meta.push(`default \`${esc(def.default)}\``);

		const desc = escCell(joinText(def.description));
		const tail = [meta.join(', '), desc].filter(Boolean).join('. ');
		rows.push(`- ${lead}${tail ? ` — ${tail}` : ''}`);
	}
	return rows;
}

/** Dependencies sub-section parsed from requirements.txt (pins kept, comments dropped). */
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
	return ['### Dependencies', '', ...rows].join('\n');
}

/** Classes sub-section from the static-ast API: bases, summary, public methods. */
function classesBlock(dir) {
	const api = extractNodeApi(dir);
	const files = api.files || [];
	if (!files.length) return '';
	const lines = ['### Classes', ''];
	for (const f of files) {
		for (const cls of f.classes) {
			const bases = cls.bases?.length ? `(${cls.bases.join(', ')})` : '';
			lines.push(`**\`${esc(f.file)}\` — \`${esc(cls.name)}${esc(bases)}\`**`, '');
			if (cls.summary) lines.push(escCell(cls.summary), '');
			if (cls.methods?.length) {
				for (const m of cls.methods) {
					lines.push(`- \`${esc(m.signature)}\`${m.summary ? ` — ${escCell(m.summary)}` : ''}`);
				}
				lines.push('');
			}
		}
	}
	return lines.join('\n').trim();
}

// GitHub mark (Invertocat), inline so it renders the real logo in the CommonMark
// docs (.md is not MDX here, so a JSX icon component won't work). `currentColor`
// makes it inherit the link color and theme with light/dark.
const GITHUB_MARK =
	'<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em">' +
	'<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

/** Source sub-section: a GitHub-mark link to the node directory on the default branch. */
function sourceBlock(name) {
	const rel = `nodes/src/nodes/${name}`;
	const url = `https://github.com/${REPO_SLUG}/tree/${DEFAULT_BRANCH}/${rel}`;
	return ['### Source', '', `[${GITHUB_MARK} GitHub/${name}](${url})`].join('\n');
}

function generateBlock(dir, name) {
	const parts = [];

	const services = readdirSync(dir).filter((f) => /^services.*\.json$/.test(f)).sort();
	if (services.length) {
		const multi = services.length > 1;
		for (const f of services) {
			const svc = parseService(path.join(dir, f));
			const label = multi ? f.replace(/^services\.?/, '').replace(/\.json$/, '') || 'default' : '';
			parts.push(serviceBlock(svc, label));
		}
	} else {
		parts.push('_No machine-readable schema for this node._');
	}

	const deps = dependenciesBlock(dir);
	if (deps) parts.push(deps);

	const classes = classesBlock(dir);
	if (classes) parts.push(classes);

	parts.push(sourceBlock(name));

	return parts.map((p) => p.trim()).filter(Boolean).join('\n\n').trim();
}

function injectBlock(docPath, block) {
	const original = readFileSync(docPath, 'utf8');
	const wrapped = `${START}\n<!-- Generated by nodes:docs-generate. Do not edit by hand. -->\n\n${block}\n${END}`;
	const s = original.indexOf(START);
	const e = original.indexOf(END);
	let next;
	if (s !== -1 && e !== -1 && e > s) {
		next = original.slice(0, s) + wrapped + original.slice(e + END.length);
	} else {
		next = `${original.replace(/\s*$/, '')}\n\n## Reference\n\n${wrapped}\n`;
	}
	if (next !== original) {
		writeFileSync(docPath, next);
		return true;
	}
	return false;
}

function main() {
	// Optional CLI args restrict generation to the named node(s); no args = all.
	const only = new Set(process.argv.slice(2));
	let updated = 0;
	let skipped = 0;
	for (const name of readdirSync(NODES_DIR)) {
		if (only.size && !only.has(name)) continue;
		const dir = path.join(NODES_DIR, name);
		const docPath = path.join(dir, 'doc.md');
		if (!existsSync(docPath)) {
			skipped++;
			continue;
		}
		if (injectBlock(docPath, generateBlock(dir, name))) updated++;
	}
	console.log(`nodes:docs-generate updated ${updated} doc.md, skipped ${skipped} without doc.md`);
}

main();
