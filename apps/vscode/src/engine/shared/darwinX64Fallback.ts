// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * darwinX64Fallback.ts — Intel Mac (darwin-x64) local-engine guardrails.
 *
 * No native darwin-x64 engine binary is published. Intel Mac users must run
 * the engine via Docker. These helpers detect the unsupported platform and
 * spawn-time arch mismatches (ENOEXEC / EBADARCH / "bad CPU type"), and offer
 * a one-click switch to Docker connection mode.
 *
 * Pure detection helpers stay free of vscode imports so unit tests can run
 * under node:test without the extension host.
 */

/** User-facing explanation when local engine cannot run on Intel macOS. */
export const DARWIN_X64_UNSUPPORTED_MESSAGE =
	'Local engine is not supported on Intel Macs (no darwin-x64 build is published). ' +
	'Switch rocketride.development.connectionMode to "docker" to run the engine in Docker Desktop.';

const SWITCH_TO_DOCKER = 'Switch to Docker';
const OPEN_SETTINGS = 'Open Settings';

/**
 * True when the host is macOS on x64 (Intel). Accepts overrides for tests.
 */
export function isUnsupportedDarwinX64(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): boolean {
	return platform === 'darwin' && arch === 'x64';
}

/**
 * True when a spawn/exec failure indicates a CPU architecture mismatch
 * (typical when an arm64 Mach-O binary is launched on Intel macOS).
 */
export function isArchMismatchSpawnError(error: unknown): boolean {
	if (error == null) return false;

	const code = typeof error === 'object' && error !== null && 'code' in error
		? String((error as { code?: unknown }).code ?? '')
		: '';
	if (code === 'ENOEXEC' || code === 'EBADARCH') return true;

	const message = error instanceof Error
		? error.message
		: typeof error === 'string'
			? error
			: String(error);

	const lower = message.toLowerCase();
	return lower.includes('bad cpu type')
		|| lower.includes('ebadarch')
		|| lower.includes('enoexec');
}

/**
 * Shows an actionable modal so the user can switch to Docker or open settings.
 * Does not throw — callers should throw/reject after awaiting this.
 *
 * vscode / ConfigManager are loaded lazily so pure helpers remain unit-testable.
 */
export async function promptDarwinX64DockerFallback(
	message: string = DARWIN_X64_UNSUPPORTED_MESSAGE,
): Promise<void> {
	const vscode = await import('vscode');
	const { ConfigManager } = await import('../../config');

	const choice = await vscode.window.showErrorMessage(
		message,
		{
			modal: true,
			detail: 'Apple Silicon (darwin-arm64) binaries cannot run on Intel CPUs. Docker Desktop runs the published linux/amd64 engine image natively on Intel Macs.',
		},
		SWITCH_TO_DOCKER,
		OPEN_SETTINGS,
	);

	const config = ConfigManager.getInstance();
	if (choice === SWITCH_TO_DOCKER) {
		await config.updateConnectionMode('development', 'docker');
	} else if (choice === OPEN_SETTINGS) {
		await config.openSettings();
	}
}
