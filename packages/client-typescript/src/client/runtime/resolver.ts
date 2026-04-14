/**
 * Version resolution for runtime binaries.
 *
 * Reads the compatibility range from package metadata and queries
 * GitHub releases to find the latest compatible runtime version.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { satisfies, maxSatisfying, valid as semverValid, compare } from 'semver';
import { RuntimeNotFoundError } from '../exceptions/index.js';
import { normalizeVersion } from './platform.js';

const GITHUB_API = 'https://api.github.com/repos/rocketride-org/rocketride-server/releases';
const TAG_PATTERN = /^server-v(.+)$/;
const DEFAULT_COMPAT = '>=3.0.0 <4.0.0';

export function getCompatRange(): string {
	// Walk up from this file to find package.json
	// Compiled: dist/cli/client/runtime/resolver.js -> 4 levels to package root
	// Source:   src/client/runtime/resolver.ts -> 3 levels to package root
	let dir = __dirname;
	for (let i = 0; i < 6; i++) {
		try {
			const pkgPath = join(dir, 'package.json');
			const raw = readFileSync(pkgPath, 'utf-8');
			const pkg = JSON.parse(raw);
			const compat: string | undefined = pkg?.rocketride?.runtimeCompatible;
			if (compat) return compat;
			break; // Found package.json but no field — use fallback
		} catch {
			dir = dirname(dir);
		}
	}
	return DEFAULT_COMPAT;
}

export async function resolveCompatibleVersion(compatRange?: string): Promise<string> {
	const range = compatRange ?? getCompatRange();

	const resp = await fetch(GITHUB_API + '?per_page=100', {
		headers: { Accept: 'application/vnd.github+json' },
	});
	if (!resp.ok) {
		throw new RuntimeNotFoundError(`Failed to query GitHub releases (HTTP ${resp.status})`);
	}
	const releases: Array<{ tag_name: string }> = await resp.json();

	const versions: string[] = [];
	for (const release of releases) {
		const match = TAG_PATTERN.exec(release.tag_name);
		if (!match) continue;
		const v = match[1];
		if (semverValid(v) && satisfies(v, range)) {
			versions.push(v);
		}
	}

	if (versions.length === 0) {
		throw new RuntimeNotFoundError(`No runtime release found matching ${range}`);
	}

	const best = maxSatisfying(versions, range);
	if (!best) {
		throw new RuntimeNotFoundError(`No runtime release found matching ${range}`);
	}
	return best;
}

/**
 * Resolve a version spec to a Docker image tag.
 *
 * - 'latest' -> latest stable (non-prerelease) from GitHub releases
 * - 'prerelease' -> latest prerelease
 * - explicit version -> return as-is
 */
export async function resolveDockerTag(versionSpec: string): Promise<string> {
	if (versionSpec !== 'latest' && versionSpec !== 'prerelease') {
		return normalizeVersion(versionSpec);
	}

	const resp = await fetch(GITHUB_API + '?per_page=100', {
		headers: { Accept: 'application/vnd.github+json' },
	});
	if (!resp.ok) {
		throw new RuntimeNotFoundError(`Failed to query GitHub releases (HTTP ${resp.status})`);
	}
	const releases: Array<{ tag_name: string }> = await resp.json();

	const candidates: string[] = [];
	for (const release of releases) {
		const match = TAG_PATTERN.exec(release.tag_name);
		if (!match) continue;
		const v = match[1];
		const isPrerelease = v.includes('-prerelease');

		if (versionSpec === 'prerelease' && isPrerelease) {
			candidates.push(v);
		} else if (versionSpec === 'latest' && !isPrerelease) {
			candidates.push(v);
		}
	}

	if (candidates.length === 0) {
		throw new RuntimeNotFoundError(`No runtime release found for spec: ${versionSpec}`);
	}

	// Sort by semver base version (strip prerelease suffix for comparison)
	candidates.sort((a, b) => {
		const baseA = a.replace(/-prerelease$/, '');
		const baseB = b.replace(/-prerelease$/, '');
		const va = semverValid(baseA);
		const vb = semverValid(baseB);
		if (va && vb) return compare(vb, va); // descending
		return 0;
	});

	return candidates[0];
}
