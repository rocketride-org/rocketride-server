/**
 * nodes:docs-generate — write a generated reference block into the marked
 * region of each node's co-located doc.md.
 *
 * Source of truth: nodes/src/nodes/<name>/services*.json (JSONC), requirements.txt,
 * and the node's Python classes (via extract_node_api.py). Multi-service nodes emit
 * one schema section per service file. The generated content lives strictly between
 * the markers; hand-written prose around them is preserved. Nodes without a doc.md
 * are skipped (doc.md is authored/migrated separately).
 *
 * Each generated block contains, per node: per-service metadata / lanes / profiles /
 * config sections / schema fields, then node-level Dependencies, Classes, and a Source
 * link to the node directory on the repo's default branch.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODES_DIR = path.join(HERE, '..', 'src', 'nodes');
const ROOT = path.join(HERE, '..', '..');
const EXTRACT_SCRIPT = path.join(HERE, 'extract_node_api.py');

const START = '<!-- ROCKETRIDE:GENERATED:PARAMS START -->';
const END = '<!-- ROCKETRIDE:GENERATED:PARAMS END -->';

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

function serviceBlock(svc, label) {
	const lines = [];
	if (label) lines.push(`### Service: \`${label}\``, '');

	const meta = [];
	if (svc.classType) meta.push(['Class type', [].concat(svc.classType).join(', ')]);
	if (svc.capabilities) meta.push(['Capabilities', [].concat(svc.capabilities).join(', ')]);
	if (svc.protocol) meta.push(['Protocol', `\`${svc.protocol}\``]);
	if (meta.length) {
		lines.push('| Property | Value |', '| --- | --- |');
		for (const [k, v] of meta) lines.push(`| ${esc(k)} | ${esc(v)} |`);
		lines.push('');
	}

	if (svc.lanes && Object.keys(svc.lanes).length) {
		lines.push('**Data lanes**', '', '| Input | Produces |', '| --- | --- |');
		for (const [input, outputs] of Object.entries(svc.lanes)) {
			lines.push(`| \`${esc(input)}\` | ${[].concat(outputs).map((o) => `\`${esc(o)}\``).join(', ')} |`);
		}
		lines.push('');
	}

	const profiles = svc.preconfig?.profiles;
	if (profiles && Object.keys(profiles).length) {
		lines.push('**Profiles**', '', '| Profile | Title | Model |', '| --- | --- | --- |');
		for (const [key, p] of Object.entries(profiles)) {
			lines.push(`| \`${esc(key)}\` | ${esc(p?.title)} | ${esc(p?.model)} |`);
		}
		lines.push('');
	}

	if (Array.isArray(svc.shape) && svc.shape.length) {
		lines.push('**Configuration sections**', '', '| Section | Fields |', '| --- | --- |');
		for (const sec of svc.shape) {
			const props = [].concat(sec?.properties || []).map((p) => `\`${esc(p)}\``).join(', ');
			lines.push(`| ${esc(sec?.title || sec?.section || '')} | ${props} |`);
		}
		lines.push('');
	}

	// Schema: per-field detail from services.json `fields`. Skip pure grouping refs
	// (entries that only wire properties together and carry no type/title/description).
	const fields = svc.fields && typeof svc.fields === 'object' ? Object.entries(svc.fields) : [];
	const documented = fields.filter(([, f]) => f && typeof f === 'object' && (f.type || f.title || f.description));
	if (documented.length) {
		lines.push('**Schema fields**', '', '| Field | Type | Title / Description | Const / Default |', '| --- | --- | --- | --- |');
		for (const [name, f] of documented) {
			const titleDesc = f.title || f.description || '';
			const constDefault = f.const != null ? `const \`${esc(f.const)}\`` : f.default != null ? `default \`${esc(f.default)}\`` : '';
			lines.push(`| \`${esc(name)}\` | ${esc(f.type)} | ${esc(titleDesc)} | ${constDefault} |`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

/** Parse requirements.txt: drop comments / blank lines, keep version pins. */
function readDependencies(dir) {
	const file = path.join(dir, 'requirements.txt');
	if (!existsSync(file)) return [];
	return readFileSync(file, 'utf8')
		.split('\n')
		.map((line) => line.replace(/#.*$/, '').trim())
		.filter(Boolean);
}

function dependenciesBlock(dir) {
	const deps = readDependencies(dir);
	if (!deps.length) return '';
	return ['**Dependencies**', '', deps.map((d) => `\`${esc(d)}\``).join(', '), ''].join('\n');
}

function classesBlock(classes) {
	if (!classes || !classes.length) return '';
	const lines = ['**Classes**', ''];
	for (const cls of classes) {
		const ext = cls.bases && cls.bases.length ? ` — extends ${cls.bases.map((b) => `\`${esc(b)}\``).join(', ')}` : '';
		lines.push(`\`${esc(cls.name)}\`${ext} (\`${esc(cls.file)}\`)`, '');
		if (cls.methods && cls.methods.length) {
			lines.push('| Method | Summary |', '| --- | --- |');
			for (const m of cls.methods) lines.push(`| \`${esc(m.signature)}\` | ${esc(m.summary)} |`);
			lines.push('');
		}
	}
	// Trailing blank line kept (like the other blocks) so generateBlock's join
	// leaves a blank line before the next section instead of butting a table
	// straight against **Source**.
	return lines.join('\n');
}

function sourceBlock(name, repo) {
	return ['**Source**', '', `[\`nodes/src/nodes/${name}\`](${repo.base}/tree/${repo.branch}/nodes/src/nodes/${name})`, ''].join('\n');
}

function generateBlock(dir, name, apiData, repo) {
	const services = readdirSync(dir).filter((f) => /^services.*\.json$/.test(f)).sort();
	const multi = services.length > 1;
	const parts = [];
	for (const f of services) {
		const svc = parseService(path.join(dir, f));
		const label = multi ? f.replace(/^services\.?/, '').replace(/\.json$/, '') || 'default' : '';
		parts.push(serviceBlock(svc, label));
	}
	if (!services.length) parts.push('_No machine-readable schema for this node._');

	// Node-level sections (emitted once, after the per-service schema blocks).
	const deps = dependenciesBlock(dir);
	if (deps) parts.push(deps);
	const classes = classesBlock(apiData[name]);
	if (classes) parts.push(classes);
	parts.push(sourceBlock(name, repo));

	return parts.join('\n').trim();
}

/** Run the static Python extractor once for all nodes; tolerate its absence. */
function loadNodeApi() {
	for (const py of ['python3', 'python']) {
		try {
			return JSON.parse(execFileSync(py, [EXTRACT_SCRIPT, NODES_DIR], { encoding: 'utf8' }));
		} catch (err) {
			if (err && err.code === 'ENOENT') continue; // try next interpreter
			console.warn(`nodes:docs-generate: class extraction failed (${err.message}); Classes sections omitted`);
			return {};
		}
	}
	console.warn('nodes:docs-generate: no python interpreter found; Classes sections omitted');
	return {};
}

/** Resolve the repo URL base and default branch for Source links. */
function resolveRepo() {
	let base = 'https://github.com/rocketride-org/rocketride-server';
	try {
		const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
		const url = pkg?.repository?.url || '';
		const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
		if (m) base = `https://github.com/${m[1]}`;
	} catch {
		// fall back to the default base
	}

	let branch = 'develop';
	try {
		branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: ROOT, encoding: 'utf8' })
			.trim()
			.replace(/^origin\//, '') || 'develop';
	} catch {
		// origin/HEAD not configured locally — default branch is develop
	}

	return { base, branch };
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
	const apiData = loadNodeApi();
	const repo = resolveRepo();
	let updated = 0;
	let skipped = 0;
	for (const name of readdirSync(NODES_DIR)) {
		const dir = path.join(NODES_DIR, name);
		const docPath = path.join(dir, 'doc.md');
		if (!existsSync(docPath)) {
			skipped++;
			continue;
		}
		if (injectBlock(docPath, generateBlock(dir, name, apiData, repo))) updated++;
	}
	console.log(`nodes:docs-generate updated ${updated} doc.md, skipped ${skipped} without doc.md (branch ${repo.branch})`);
}

main();
