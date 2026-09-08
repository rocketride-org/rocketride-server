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

/**
 * Workspace provisioning operations shared by every RocketRide client
 * front-end (the CLI executable and the VS Code extension): agent docs
 * bundle install, services catalog sync, stub marker merge, gitignore
 * entries, and `/client/*` artifact vendoring.
 *
 * Everything here is plain node fs + fetch — no IDE APIs — so any
 * consumer can compile it in like a library. Progress reporting is a
 * caller-supplied callback; consumers adapt it to their own logger.
 *
 * Behavioral twin of `client-common/python`'s `provision.py` — changes
 * here must be mirrored there.
 */

import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

/** Marker protocol delimiting the managed section of agent stub files. */
export const MARKER_BEGIN = '<!-- ROCKETRIDE:BEGIN -->';
export const MARKER_END = '<!-- ROCKETRIDE:END -->';

/** Filename shape of installed agent docs — the install sweep's scope. */
export const DOC_FILE_PATTERN = /^ROCKETRIDE_.*\.md$/;

/** Workspace stamp file holding the installed bundle's content hash. */
export const DOCS_STAMP_FILE = '.version';

/** Gitignore entries every provisioned workspace carries (exact names). */
export const GITIGNORE_ENTRIES = ['.rocketride/', '.env'] as const;

/** Progress line sink; consumers route it to their own output/logger. */
export type ProgressSink = (line: string) => void;

/**
 * Normalize a connect URI to an http(s) base URL for /client/* downloads.
 *
 * @param uri - The DAP connect URI (ws/wss/http/https).
 * @returns The http(s) origin with path noise stripped.
 */
export function toHttpBase(uri: string): string {
	return uri
		.replace(/^ws:/i, 'http:')
		.replace(/^wss:/i, 'https:')
		.replace(/\/task\/service\/?$/i, '')
		.replace(/\/+$/, '');
}

/**
 * Write a file only when its content changed. Creates parent dirs.
 *
 * @param filePath - Destination path.
 * @param content - New content (string or bytes).
 * @returns True when the file was written.
 */
export function writeIfChanged(filePath: string, content: string | Buffer): boolean {
	const next = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
	if (fs.existsSync(filePath) && next.equals(fs.readFileSync(filePath))) {
		return false;
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, next);
	return true;
}

/**
 * Download one /client/* artifact from the server.
 *
 * @param base - The server's http(s) base URL.
 * @param route - Route under the base (e.g. `client/shell`).
 * @param label - Human label for error messages.
 * @param timeoutMs - Request timeout in milliseconds.
 * @returns The artifact bytes.
 */
export async function fetchArtifact(base: string, route: string, label: string, timeoutMs: number = 60_000): Promise<Buffer> {
	const res = await fetch(new URL(route, `${base}/`), { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) {
		throw new Error(`${base} does not serve the ${label} (HTTP ${res.status})`);
	}
	return Buffer.from(await res.arrayBuffer());
}

/**
 * Install the agent docs bundle into `<workspace>/.rocketride/docs` with
 * the sweep rule.
 *
 * Downloads GET /client/docs (docs.zip), compares its manifest hash to
 * the workspace stamp, and on change deletes every `ROCKETRIDE_*` doc
 * before unpacking the new set — renamed/retired docs cannot linger,
 * while non-matching files a user added survive. Stubs land under
 * `.rocketride/docs/stubs/`.
 *
 * @param workspaceRoot - Workspace directory.
 * @param base - The server's http(s) base URL.
 * @param onProgress - Progress line sink.
 * @returns True when docs were installed or refreshed.
 */
export async function installDocsBundle(workspaceRoot: string, base: string, onProgress: ProgressSink = () => {}): Promise<boolean> {
	const docsDir = path.join(workspaceRoot, '.rocketride', 'docs');
	const stampPath = path.join(docsDir, DOCS_STAMP_FILE);

	// step: download and read the bundle manifest
	const bundle = await fetchArtifact(base, 'client/docs', 'agent docs bundle (docs.zip)');
	const zip = new AdmZip(bundle);
	const manifestEntry = zip.getEntry('manifest.json');
	const manifest = manifestEntry ? JSON.parse(manifestEntry.getData().toString('utf-8')) : { hash: '', files: [] };
	const hash = String(manifest.hash || '');

	// step: unchanged bundle — stamp matches, nothing to do
	if (hash && fs.existsSync(stampPath) && fs.readFileSync(stampPath, 'utf-8').trim() === hash) {
		onProgress('Agent docs already up to date.');
		return false;
	}

	// step: sweep — remove every ROCKETRIDE_* doc so renamed/retired docs
	// cannot fossilize; anything else in the directory survives
	if (fs.existsSync(docsDir)) {
		for (const fileName of fs.readdirSync(docsDir)) {
			if (DOC_FILE_PATTERN.test(fileName)) {
				fs.rmSync(path.join(docsDir, fileName));
			}
		}
	}

	// step: unpack the new set (docs at the root, stubs under stubs/) —
	// entry names are server-supplied, so absolute and traversing names
	// are rejected and every resolved target must stay under docsDir
	fs.mkdirSync(docsDir, { recursive: true });
	const docsRoot = path.resolve(docsDir);
	for (const entry of zip.getEntries()) {
		const entryName = entry.entryName.replace(/\\/g, '/');
		if (entry.isDirectory || entryName === 'manifest.json' || entryName.includes('..') || path.isAbsolute(entryName)) {
			continue;
		}
		const target = path.resolve(docsDir, entryName);
		if (target !== docsRoot && !target.startsWith(docsRoot + path.sep)) {
			onProgress(`Skipped docs entry outside the workspace: ${entry.entryName}`);
			continue;
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, entry.getData());
	}
	if (hash) {
		fs.writeFileSync(stampPath, hash + '\n', 'utf-8');
	}
	onProgress(`Agent docs installed (${(manifest.files || []).length} files).`);
	return true;
}

/**
 * Extract the first sentence from an HTML description string.
 *
 * Strips HTML tags first. The strip loops until idempotent so nested or
 * malformed tags like `<scri<x>pt>` collapse fully — a single regex pass
 * would leave `<script>` behind after consuming only the inner `<x>`.
 * Defense-in-depth: the output lands in a JSON catalog file, not
 * rendered as HTML, but the consumer surface may grow.
 *
 * @param description - Raw (possibly HTML) description.
 * @returns The first sentence, tags stripped.
 */
function firstSentence(description: string | undefined): string {
	if (!description) return '';
	let stripped = description;
	let prev: string;
	do {
		prev = stripped;
		stripped = stripped.replace(/<[^>]*>/g, '');
	} while (stripped !== prev);
	const text = stripped.trim();
	// Take first sentence (ends with . ! or ?)
	const match = text.match(/^[^.!?]*[.!?]/);
	return match ? match[0].trim() : text;
}

/**
 * Encode a service name so it is safe - and unique - as a filename.
 * Only `[a-zA-Z0-9._-]` characters survive literally; every other character
 * becomes the percent-escape of its UTF-8 bytes, and each leading dot becomes
 * `%2E` so no schema file is hidden or traversing. The encoding is reversible,
 * hence collision-free: names that differ (`a/b` vs `a_b`) can never land on
 * the same schema file and silently overwrite each other. The Python twin
 * encodes identically so both clients produce the same workspace contents.
 *
 * @param name - Raw service name from the server.
 * @returns Filename-safe name.
 */
function sanitizeServiceName(name: string): string {
	// The /u flag makes each match a whole code point, so astral characters
	// are encoded as one UTF-8 sequence rather than two lone surrogates
	const encoded = name.replace(/[^a-zA-Z0-9._-]/gu, (char) => Array.from(new TextEncoder().encode(char), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''));
	return encoded.replace(/^\.+/, (match) => '%2E'.repeat(match.length));
}

/**
 * Sync the services catalog + per-component schemas into .rocketride/.
 *
 * Writes one schema file per component, removes schemas for components
 * the server no longer has, and writes the master catalog (name,
 * classType, first-sentence description, lanes, optional invoke).
 *
 * @param workspaceRoot - Workspace directory.
 * @param services - The services map from the client's getServices().
 * @param onProgress - Progress line sink.
 */
export function syncServiceCatalog(workspaceRoot: string, services: Record<string, unknown>, onProgress: ProgressSink = () => {}): void {
	const schemaDir = path.join(workspaceRoot, '.rocketride', 'schema');
	fs.mkdirSync(schemaDir, { recursive: true });

	// step: one schema file per component; track for obsolete cleanup
	const expected = new Set<string>();
	for (const name of Object.keys(services)) {
		const safeName = sanitizeServiceName(name);
		const schemaPath = path.join(schemaDir, `${safeName}.json`);
		// Defense-in-depth after sanitization: the resolved path must stay
		// strictly inside the schema directory
		if (!path.resolve(schemaPath).startsWith(path.resolve(schemaDir) + path.sep)) {
			onProgress(`Skipped schema write for unsafe service name: ${name}`);
			continue;
		}
		expected.add(`${safeName}.json`);
		writeIfChanged(schemaPath, JSON.stringify(services[name], null, 2));
	}

	// step: remove schemas for components the server no longer has
	for (const fileName of fs.readdirSync(schemaDir)) {
		if (!expected.has(fileName)) {
			fs.rmSync(path.join(schemaDir, fileName));
		}
	}

	// step: the master catalog
	const catalog = Object.keys(services).map((name) => {
		const svc = services[name] as Record<string, unknown>;
		const entry: Record<string, unknown> = {
			name,
			classType: svc.classType ?? [],
			description: firstSentence(svc.description as string | undefined),
			lanes: svc.lanes ?? {},
		};
		if (svc.invoke !== undefined) {
			entry.invoke = svc.invoke;
		}
		return entry;
	});
	writeIfChanged(path.join(workspaceRoot, '.rocketride', 'services-catalog.json'), JSON.stringify(catalog, null, 2));
	onProgress(`Service catalog synced (${catalog.length} components).`);
}

/**
 * Merge stub content into existing file content using the marker
 * protocol: replace between markers when present, else append with a
 * separator, else the stub alone.
 *
 * @param existing - Current target file content ('' when absent).
 * @param stubContent - The stub template (with or without markers).
 * @returns The merged file content.
 */
export function mergeStubContent(existing: string, stubContent: string): string {
	const hasMarkers = stubContent.includes(MARKER_BEGIN) && stubContent.includes(MARKER_END);
	const block = hasMarkers ? stubContent.substring(stubContent.indexOf(MARKER_BEGIN), stubContent.indexOf(MARKER_END) + MARKER_END.length) : `${MARKER_BEGIN}\n${stubContent}\n${MARKER_END}`;

	if (existing === '') {
		return hasMarkers ? stubContent : block + '\n';
	}
	const beginIdx = existing.indexOf(MARKER_BEGIN);
	const endIdx = existing.indexOf(MARKER_END);
	if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
		// Replace the existing marked section
		return existing.substring(0, beginIdx) + block + existing.substring(endIdx + MARKER_END.length);
	}
	// Append with separator
	return existing.trimEnd() + '\n\n' + block + '\n';
}

/**
 * Remove the marked block (markers + content between) from a string.
 *
 * @param content - The file content.
 * @returns The content without the managed block, whitespace-collapsed.
 */
export function stripStubContent(content: string): string {
	const beginIdx = content.indexOf(MARKER_BEGIN);
	const endIdx = content.indexOf(MARKER_END);
	if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
		return content;
	}
	const before = content.substring(0, beginIdx);
	const after = content.substring(endIdx + MARKER_END.length);
	return (before + after).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Install one agent stub from the workspace's downloaded docs bundle.
 *
 * Reads `.rocketride/docs/stubs/<stubSource>` and merges it into
 * `<workspace>/<stubTarget>` via the marker protocol. Line-ending
 * normalized change detection avoids dirtying the repo.
 *
 * @param workspaceRoot - Workspace directory.
 * @param stubSource - Stub filename inside the bundle's stubs/ dir.
 * @param stubTarget - Target path relative to the workspace root.
 * @returns True when the target was created or updated.
 * @throws Error when the stub is not present in the docs bundle.
 */
export function installStub(workspaceRoot: string, stubSource: string, stubTarget: string): boolean {
	const stubPath = path.join(workspaceRoot, '.rocketride', 'docs', 'stubs', stubSource);
	if (!fs.existsSync(stubPath)) {
		throw new Error(`Stub ${stubSource} is not present in the docs bundle — connect to a server to sync docs first`);
	}
	const stubContent = fs.readFileSync(stubPath, 'utf-8');
	const targetPath = path.join(workspaceRoot, stubTarget);
	const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf-8') : '';
	const next = mergeStubContent(existing, stubContent);
	if (next.replace(/\r\n/g, '\n') === existing.replace(/\r\n/g, '\n')) {
		return false;
	}
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	fs.writeFileSync(targetPath, next, 'utf-8');
	return true;
}

/**
 * Ensure the standard entries are git-ignored (exact-name patterns, so a
 * committed `.env.example` is unaffected). Creates `.gitignore` when
 * absent; appends only missing entries.
 *
 * @param workspaceRoot - Workspace directory.
 * @returns True when `.gitignore` was created or updated.
 */
export function ensureGitignore(workspaceRoot: string): boolean {
	const gitignorePath = path.join(workspaceRoot, '.gitignore');
	const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
	const lines = existing.split(/\r?\n/).map((line) => line.trim());
	const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
	if (missing.length === 0) {
		return false;
	}
	const next = (existing.trimEnd() + '\n' + missing.join('\n') + '\n').replace(/^\n/, '');
	fs.writeFileSync(gitignorePath, next, 'utf-8');
	return true;
}
