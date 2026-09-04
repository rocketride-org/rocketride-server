#!/usr/bin/env node

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Verify that pinned GitHub Action SHAs agree with their version comments. */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const USES_RE = /^\s*(?:-\s*)?uses:\s*(["']?)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s#]+)?)@([0-9a-f]{40})\1(?:\s+#\s*(\S+))?\s*$/;
const VERSION_RE = /^v\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/;

/** Parse remotely hosted, SHA-pinned actions from one workflow. */
export function parseWorkflow(source, filename) {
	return source.split(/\r?\n/).flatMap((line, index) => {
		const match = line.match(USES_RE);
		if (!match) return [];
		const action = match[2];
		return [
			{
				filename,
				line: index + 1,
				action,
				repository: action.split('/').slice(0, 2).join('/'),
				sha: match[3],
				version: match[4] ?? null,
			},
		];
	});
}

/** Compare parsed pins with a resolver that maps repository + tag to eligible commit SHAs. */
export async function verifyPins(pins, resolveTag) {
	const errors = [];
	await Promise.all(
		pins.map(async (pin) => {
			if (!pin.version) {
				errors.push({ ...pin, message: `${pin.action}@${pin.sha} is missing a version comment (for example, # v4).` });
				return;
			}
			if (!VERSION_RE.test(pin.version)) {
				errors.push({ ...pin, message: `Version comment "${pin.version}" is not a supported Git tag.` });
				return;
			}
			try {
				const expected = await resolveTag(pin.repository, pin.version);
				const candidates = Array.isArray(expected) ? expected : [expected];
				if (!candidates.some((sha) => sha.toLowerCase() === pin.sha.toLowerCase())) {
					errors.push({
						...pin,
						message: `${pin.repository}@${pin.version} does not include pinned commit ${pin.sha}.`,
					});
				}
			} catch (error) {
				errors.push({ ...pin, message: `Could not resolve ${pin.repository}@${pin.version}: ${error.message}` });
			}
		})
	);
	return errors.sort((a, b) => a.filename.localeCompare(b.filename) || a.line - b.line);
}

/** Resolve exact tags, or every release within a major-only comment such as v4. */
export async function resolveGitHubTag(repository, version) {
	const remote = `https://github.com/${repository}.git`;
	const majorOnly = /^v\d+$/.test(version);
	const patterns = majorOnly ? [`refs/tags/${version}*`] : [`refs/tags/${version}`, `refs/tags/${version}^{}`];
	const { stdout } = await execFileAsync('git', ['ls-remote', '--tags', remote, ...patterns], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
	const refs = new Map(
		stdout
			.trim()
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => {
				const [sha, ref] = line.split(/\s+/);
				return [ref, sha];
			})
	);
	const tags = new Map();
	for (const [ref, sha] of refs) {
		const base = ref.replace(/\^\{\}$/, '');
		const tagName = base.slice('refs/tags/'.length);
		if (majorOnly && tagName !== version && !tagName.startsWith(`${version}.`)) continue;
		if (ref.endsWith('^{}') || !tags.has(base)) tags.set(base, sha);
	}
	if (!tags.size) throw new Error('tag does not exist');
	return [...new Set(tags.values())];
}

/** Return every YAML workflow in the repository's workflow directory. */
async function workflowFiles(root) {
	const workflowDir = path.join(root, '.github', 'workflows');
	const entries = await fs.readdir(workflowDir, { withFileTypes: true });
	return entries.filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name)).map((entry) => path.join(workflowDir, entry.name));
}

/** Run the repository-wide verifier and emit GitHub annotation commands. */
async function main() {
	const root = process.cwd();
	const pins = [];
	for (const filename of await workflowFiles(root)) {
		const relative = path.relative(root, filename).replaceAll('\\', '/');
		pins.push(...parseWorkflow(await fs.readFile(filename, 'utf8'), relative));
	}

	const cache = new Map();
	const cachedResolver = (repository, version) => {
		const key = `${repository}@${version}`;
		if (!cache.has(key)) cache.set(key, resolveGitHubTag(repository, version));
		return cache.get(key);
	};
	const errors = await verifyPins(pins, cachedResolver);

	if (errors.length) {
		for (const error of errors) {
			console.error(`::error file=${error.filename},line=${error.line}::${error.message}`);
		}
		console.error(`\n${errors.length} invalid action pin(s) found across ${pins.length} pinned uses.`);
		process.exitCode = 1;
		return;
	}
	console.log(`Verified ${pins.length} action pins against ${cache.size} upstream tags.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
