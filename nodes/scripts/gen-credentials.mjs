// Copyright 2026 Aparavi Software AG. MIT License.
/**
 * nodes:credentials-generate / nodes:credentials-check — reconcile the
 * credential catalog (packages/ai/src/ai/modules/mcp/credentials.json) from
 * node service definitions.
 *
 * The catalog tells the MCP integrations surface which config fields on
 * which nodes are credential-shaped, so it can tell a caller what is and
 * isn't configured. This script keeps that catalog honest:
 *
 *   - Scans every node's services*.json for credential-shaped fields
 *     (preconfig.profiles.* entries with an empty-string default, and
 *     top-level `fields` entries whose key looks like a secret regardless
 *     of default value, as long as the field's declared `type` is `string`
 *     or unset -- a numeric/boolean field with a secret-sounding key, e.g.
 *     a token *count*, is never a credential).
 *   - Catalog entries are keyed by the PROTOCOL-DERIVED SERVICE NAME (the
 *     `protocol` field with its trailing `://` stripped) -- the same name
 *     the engine's get_services() uses -- never by node directory name. A
 *     services*.json file with no `protocol` field defines no service and
 *     contributes no catalog key. One node directory commonly declares
 *     several services (several services*.json files, each its own
 *     protocol); each gets scanned and bucketed independently.
 *   - Any detected path already covered by an existing catalog entry is
 *     left completely untouched — a curator's chosen title/suggests always
 *     wins over the generator.
 *   - Any detected path with no catalog entry gets a stub appended
 *     (`review: true`) so a human can give it a real name.
 *   - Staleness is split by who owns the field:
 *       - Generator-owned stubs (`review: true`) go stale when the
 *         generator can no longer detect their path — that's the signal a
 *         human still needs to give them a real name, or the field is gone.
 *       - Human-curated fields (no `review` flag) are NEVER path-stale.
 *         Curation exists specifically to describe config the generator
 *         cannot detect — non-secret companions (endpoints, usernames,
 *         database names) and secrets the generator misses — so "the
 *         generator doesn't see this path" is expected for them, not drift.
 *       - Either kind goes stale if the catalog key's SERVICE is gone
 *         entirely (no services*.json in the tree still declares that
 *         protocol) — that's a real signal the node was removed or
 *         renamed, and a human should prune (or re-key) the whole entry.
 *     Nothing is ever auto-deleted; stale is reported, not removed.
 *   - Class-closing invariant: every catalog key must be a protocol-derived
 *     service name that exists in the tree. A key that instead matches a
 *     node DIRECTORY name (the pre-fix keying mistake) is reported as its
 *     own `--check` failure naming the correct key(s) to use, distinct from
 *     generic staleness.
 *
 * `--check` is the drift gate: it never writes, and exits 1 if there is an
 * unmapped credential path, a stale catalog entry, or a directory-keyed
 * entry (`nodes:build` calls the writing form; CI/local review calls
 * `--check`).
 *
 * Discovery and parsing intentionally mirror gen-node-tables.mjs (services
 * file glob, comment-tolerant JSON), extended with trailing-comma tolerance
 * since some services*.json authors leave them in.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(HERE, '..', 'src', 'nodes');
const DEFAULT_CATALOG = path.join(HERE, '..', '..', 'packages', 'ai', 'src', 'ai', 'modules', 'mcp', 'credentials.json');

// Same token list as packages/ai/src/ai/modules/mcp/credentials.py:_GENERIC_TOKENS.
// JS can't import the Python constant, so this is a deliberate duplicate —
// keep the two lists in sync by hand.
const GENERIC_TOKENS = new Set(['store', 'tool', 'db', 'graph', 'llm', 'embedding', 'memory', 'search', 'rerank', 'vision', 'cloud', 'api', 'agent', 'eval']);

// A key is credential-shaped iff it looks like a secret AND is not one of
// the token-count fields that happen to contain the substring "token".
const CREDENTIAL_RE = /(api_?key|secret|passw|bearer|credential|token)/i;
const TOKEN_COUNT_RE = /(total|output|max)_?tokens?(_estimate)?$/i;

function isCredentialKey(key) {
	return CREDENTIAL_RE.test(key) && !TOKEN_COUNT_RE.test(key);
}

/** Comment- and trailing-comma-tolerant JSON read (services*.json is JSON5-ish). */
function readJsonTolerant(filepath) {
	let text;
	try {
		text = readFileSync(filepath, 'utf8');
	} catch (e) {
		console.error(`Error reading ${filepath}:`, e.message);
		return null;
	}
	// Strip comments (same approach as gen-node-tables.mjs's readJsonSilently).
	text = text.replace(/^[ \t]*\/\/.*$/gm, '');
	text = text.replace(/(?<!:)\/\/.*$/gm, '');
	text = text.replace(/\/\*[\s\S]*?\*\//g, '');
	// Strip trailing commas before a closing bracket/brace.
	text = text.replace(/,(\s*[}\]])/g, '$1');
	try {
		return JSON.parse(text);
	} catch (e) {
		console.error(`Error parsing JSON at ${filepath}:`, e.message);
		return null;
	}
}

/** The protocol-derived service name for a parsed services*.json, or null if it doesn't declare one. */
function serviceNameOf(data) {
	if (!data || typeof data.protocol !== 'string' || !data.protocol.endsWith('://')) return null;
	const name = data.protocol.slice(0, -3);
	return name || null;
}

/** TOKEN half of a stub name: service name minus generic prefixes, upper-cased. */
function nodeToken(serviceName) {
	const parts = serviceName.split('_').filter((p) => p.length > 2 && !GENERIC_TOKENS.has(p.toLowerCase()));
	return (parts.length ? parts : [serviceName]).join('_').toUpperCase();
}

/** FIELD half of a stub name: raw key, dots and camelCase humps -> '_', upper-cased. */
function fieldToken(key) {
	let s = key.replace(/\./g, '_');
	s = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
	s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
	return s.toUpperCase();
}

function suggestStub(serviceName, rawKey) {
	return `ROCKETRIDE_${nodeToken(serviceName)}_${fieldToken(rawKey)}`;
}

/**
 * Scan every node dir under `root` for credential-shaped fields, bucketed
 * by protocol-derived service name (not directory name — one directory may
 * declare several services across several services*.json files).
 *
 * Returns { hits, knownServices }:
 *   - hits: Map<serviceName, Map<path, rawKey>> — rawKey is kept alongside
 *     the constructed path since stub names are derived from the raw key,
 *     not the (possibly prefixed) path. Only services with at least one
 *     detected credential-shaped field appear here.
 *   - knownServices: Set<serviceName> — every protocol-derived service name
 *     that currently exists in the tree, regardless of whether it produced
 *     any hits. This is what distinguishes "the service exists but this
 *     specific path isn't secret-shaped" (not stale for curated fields)
 *     from "the service is gone" (stale for every field, curated or not).
 */
function scan(root) {
	const hits = new Map();
	const knownServices = new Set();
	if (!existsSync(root)) return { hits, knownServices };

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const nodeName = entry.name;
		const dir = path.join(root, nodeName);

		const files = readdirSync(dir).filter((f) => /^services.*\.json$/.test(f));
		if (!files.length) continue;

		for (const filename of files) {
			const data = readJsonTolerant(path.join(dir, filename));
			if (!data || typeof data !== 'object') continue;
			const serviceName = serviceNameOf(data);
			if (!serviceName) continue; // no protocol -> not a registrable service (e.g. shared field fragments)
			knownServices.add(serviceName);

			const prefix = typeof data.prefix === 'string' && data.prefix ? data.prefix : nodeName;
			const fileHits = hits.get(serviceName) || new Map();
			scanProfiles(data, prefix, fileHits);
			scanFields(data, prefix, fileHits);
			if (fileHits.size) hits.set(serviceName, fileHits);
		}
	}
	return { hits, knownServices };
}

function scanProfiles(data, prefix, hits) {
	const profiles = data.preconfig && data.preconfig.profiles;
	if (!profiles || typeof profiles !== 'object') return;
	for (const profile of Object.values(profiles)) {
		if (!profile || typeof profile !== 'object') continue;
		for (const [key, value] of Object.entries(profile)) {
			if (typeof value === 'string' && value === '' && isCredentialKey(key)) {
				hits.set(`${prefix}.${key}`, key);
			}
		}
	}
}

function scanFields(data, prefix, hits) {
	const fields = data.fields;
	if (!fields || typeof fields !== 'object') return;
	for (const [key, def] of Object.entries(fields)) {
		if (!def || typeof def !== 'object') continue;
		if (def.object !== undefined) continue; // grouping def, not a leaf field
		if (def.type !== undefined && def.type !== 'string') continue; // e.g. number/boolean counters aren't secrets
		// Credential-shaped fields-section keys are detected regardless of
		// default value: a field with no empty-string default (or no
		// default at all) is still a credential the caller must supply.
		// Paths already found via scanProfiles are naturally deduped since
		// both write into the same `hits` Map keyed by path.
		if (isCredentialKey(key)) {
			// Top-level field keys are frequently already-qualified config
			// paths (e.g. "tool_n8n.apiKey"); a bare key falls back to prefix.key.
			const p = key.includes('.') ? key : `${prefix}.${key}`;
			hits.set(p, key);
		}
	}
}

/**
 * Reconcile the existing catalog against scanned hits.
 * Returns { next, added, stale }: `next` is the catalog to write, `added`
 * is newly-appended stub fields, `stale` is existing entries with no
 * matching detection (kept, never deleted).
 *
 * Staleness rule (see the header comment for the full rationale): a field
 * whose path the generator no longer detects is stale only if it's a
 * generator-owned stub (`review: true`) or its catalog key's service is
 * gone entirely. A human-curated field (no `review` flag) on a service that
 * still exists is never path-stale — the generator not detecting it is
 * expected, since curation covers exactly what detection can't see.
 */
function reconcile(existing, scanned, knownServices) {
	const next = {};
	const added = [];
	const stale = [];

	const serviceNames = new Set([...Object.keys(existing), ...scanned.keys()]);
	for (const serviceName of serviceNames) {
		const existingNode = existing[serviceName] && typeof existing[serviceName] === 'object' ? existing[serviceName] : null;
		const existingFields = existingNode && Array.isArray(existingNode.fields) ? existingNode.fields : [];
		const existingPaths = new Set(existingFields.map((f) => f && f.path));
		const detected = scanned.get(serviceName); // Map<path, rawKey> | undefined
		const serviceExists = knownServices.has(serviceName);

		const fields = existingFields.slice(); // existing entries untouched, byte-for-byte
		if (detected) {
			for (const [detectedPath, rawKey] of detected) {
				if (existingPaths.has(detectedPath)) continue;
				fields.push({
					path: detectedPath,
					title: detectedPath,
					kind: 'secret',
					required: true,
					suggests: suggestStub(serviceName, rawKey),
					review: true,
				});
				added.push({ node: serviceName, path: detectedPath });
			}
		}
		for (const field of existingFields) {
			const existingPath = field && field.path;
			if (detected && detected.has(existingPath)) continue; // still detected: never stale
			const isReviewStub = !!(field && field.review === true);
			if (!serviceExists || isReviewStub) {
				stale.push({ node: serviceName, path: existingPath });
			}
			// else: human-curated field, service still exists — not
			// generator-detectable by design, never path-stale.
		}

		if (fields.length) {
			next[serviceName] = existingNode ? { ...existingNode, title: existingNode.title || serviceName, fields } : { title: serviceName, fields };
		} else if (existingNode) {
			next[serviceName] = existingNode; // preserve verbatim even if it has no fields
		}
	}

	const sortedNext = {};
	for (const key of Object.keys(next).sort()) sortedNext[key] = next[key];

	return { next: sortedNext, added, stale };
}

/**
 * Class-closing invariant: a catalog key must be a protocol-derived service
 * name. A key that instead matches a node DIRECTORY name (the historical
 * keying mistake this generator now fixes) is flagged separately from
 * generic staleness, naming the service name(s) that directory actually
 * declares so a human can fix the key directly.
 */
function collectWrongKeys(existing, root, knownServices) {
	const wrong = [];
	if (!existsSync(root)) return wrong;
	for (const key of Object.keys(existing)) {
		if (knownServices.has(key)) continue; // already a valid service name
		const dir = path.join(root, key);
		if (!existsSync(dir)) continue; // not a directory either -- ordinary staleness handles it
		const files = readdirSync(dir).filter((f) => /^services.*\.json$/.test(f));
		const protocols = [];
		for (const filename of files) {
			const data = readJsonTolerant(path.join(dir, filename));
			const serviceName = serviceNameOf(data);
			if (serviceName) protocols.push(serviceName);
		}
		wrong.push({ key, suggestions: protocols });
	}
	return wrong;
}

function collectReviewPending(catalog) {
	const pending = [];
	for (const [nodeName, entry] of Object.entries(catalog)) {
		for (const field of entry.fields || []) {
			if (field && field.review === true) pending.push({ node: nodeName, path: field.path });
		}
	}
	return pending;
}

function readCatalog(catalogPath) {
	if (!existsSync(catalogPath)) return {};
	const data = readJsonTolerant(catalogPath);
	return data && typeof data === 'object' ? data : {};
}

function parseArgs(argv) {
	const args = { root: DEFAULT_ROOT, catalog: DEFAULT_CATALOG, check: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--root') args.root = argv[++i];
		else if (arg === '--catalog') args.catalog = argv[++i];
		else if (arg === '--check') args.check = true;
	}
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const { hits, knownServices } = scan(args.root);
	const existing = readCatalog(args.catalog);
	const { next, added, stale } = reconcile(existing, hits, knownServices);
	const wrongKeys = collectWrongKeys(existing, args.root, knownServices);

	if (args.check) {
		if (wrongKeys.length || added.length || stale.length) {
			if (wrongKeys.length) {
				console.log('Catalog key(s) match a node DIRECTORY name, not a protocol-derived service name:');
				for (const { key, suggestions } of wrongKeys) {
					const suggestion = suggestions.length ? suggestions.join(', ') : '(no protocol-bearing services*.json in that directory)';
					console.log(`  ${key}: use '${suggestion}' instead`);
				}
			}
			if (added.length) {
				console.log('Unmapped credential path(s) - run nodes:credentials-generate to add stubs:');
				for (const { node, path: p } of added) console.log(`  ${node}: ${p}`);
			}
			if (stale.length) {
				console.log(`Stale catalog entr${stale.length === 1 ? 'y' : 'ies'} (no matching detection; not auto-removed):`);
				for (const { node, path: p } of stale) console.log(`  ${node}: ${p}`);
			}
			process.exitCode = 1;
			return;
		}
		const pending = collectReviewPending(next);
		if (pending.length) {
			console.log(`Warning: ${pending.length} catalog field(s) still carry review:true (auto-generated, needs a curated name):`);
			for (const { node, path: p } of pending) console.log(`  ${node}: ${p}`);
		}
		console.log('nodes:credentials-check: catalog matches detected credential-shaped fields.');
		return;
	}

	writeFileSync(args.catalog, JSON.stringify(next, null, 2) + '\n');
	console.log(`nodes:credentials-generate wrote ${Object.keys(next).length} node(s): ` + `${added.length} new field(s) appended, ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} kept (not removed).`);
}

main();
