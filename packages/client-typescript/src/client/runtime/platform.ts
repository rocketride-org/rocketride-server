/**
 * Platform detection and release asset naming.
 *
 * Maps the current OS/arch to GitHub release asset names.
 * Supported platforms: darwin-arm64, linux-x64, win64.
 */

import { UnsupportedPlatformError } from '../exceptions/index.js';

interface PlatformSlug {
	os: string;
	arch: string;
}

const PLATFORM_MAP: Record<string, PlatformSlug> = {
	'darwin-arm64': { os: 'darwin', arch: 'arm64' },
	'linux-x64': { os: 'linux', arch: 'x64' },
};

const WINDOWS_SLUG: PlatformSlug = { os: 'win', arch: '64' };

export function getPlatform(): PlatformSlug {
	if (process.platform === 'win32') {
		return WINDOWS_SLUG;
	}

	const key = `${process.platform}-${process.arch}`;
	const slug = PLATFORM_MAP[key];
	if (slug) {
		return slug;
	}

	throw new UnsupportedPlatformError(`Unsupported platform: ${process.platform} ${process.arch}. ` + 'Supported platforms: macOS ARM64, Linux x64, Windows x64.');
}

export function normalizeVersion(version: string): string {
	return version.replace(/^v/, '');
}

function baseVersion(version: string): string {
	for (const suffix of ['-prerelease', '-beta', '-alpha', '-rc']) {
		const idx = version.indexOf(suffix);
		if (idx !== -1) {
			return version.substring(0, idx);
		}
	}
	return version;
}

export function assetName(version: string): string {
	const { os: osSlug, arch: archSlug } = getPlatform();
	const ext = osSlug === 'win' ? 'zip' : 'tar.gz';
	const slug = osSlug === 'win' ? `${osSlug}${archSlug}` : `${osSlug}-${archSlug}`;
	const base = baseVersion(version);
	return `rocketride-server-v${base}-${slug}.${ext}`;
}

export function releaseTag(version: string): string {
	return `server-v${version}`;
}
