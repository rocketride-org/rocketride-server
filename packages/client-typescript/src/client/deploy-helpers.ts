// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Pure helpers shared by every deploy/publish host — the VS Code extension's
 * panels and the `rocketride` CLI — so team naming, version validation, and
 * version picking have one implementation. Browser-safe: no Node imports.
 */

import type { ConnectResult, Deployment } from './types/index.js';

// =============================================================================
// REGISTRY VERSIONS
// =============================================================================

/**
 * Parses a registry version argument, rejecting anything that is not a
 * positive integer. A missing or non-numeric value would otherwise become
 * NaN (null over JSON) or 0 — silently changing deployment state against an
 * unspecified version.
 *
 * @param value - The raw version (number or numeric string).
 * @returns The validated registry version (v1 is the first).
 * @throws Error when the value is not a positive integer.
 */
export function parseRegistryVersion(value: unknown): number {
	// Number(null) and Number('') both coerce to 0, so the type gate comes first
	if (typeof value !== 'number' && typeof value !== 'string') {
		throw new Error(`Invalid registry version: ${JSON.stringify(value)}`);
	}
	const version = typeof value === 'string' ? Number(value.trim().replace(/^v/i, '')) : value;
	if (!Number.isSafeInteger(version) || version <= 0) {
		throw new Error(`Invalid registry version: ${JSON.stringify(value)}`);
	}
	return version;
}

/** The version-rail fields version picking reads. */
export interface AppRailVersion {
	registryVersion: number;
	state: string;
	buildStatus: string;
}

/**
 * Picks the version a bare "publish this app" means: the NEWEST version that
 * has not failed (review state or build). A newer version that is still
 * building is the pick — callers wait for its build rather than silently
 * publishing an older one.
 *
 * @param rows - The app's version rail (`listDeployments`), any order.
 * @returns The picked row, or null when every version failed or none exist.
 */
export function pickPublishVersion<T extends AppRailVersion>(rows: T[]): T | null {
	let picked: T | null = null;
	for (const row of rows) {
		if (row.state === 'failed' || row.buildStatus === 'failed') continue;
		if (!picked || row.registryVersion > picked.registryVersion) picked = row;
	}
	return picked;
}

// =============================================================================
// TEAMS
// =============================================================================

/** One deploy target the caller can address. */
export interface DeployTeamRef {
	/** Team id, or '@me' for the caller's personal space. */
	id: string;
	/** Display name. */
	name: string;
	/** Caller holds task.control on this team (may deploy/pause/schedule). */
	canControl: boolean;
}

/**
 * Resolves the caller's deploy targets (names + control rights) from the
 * authenticated identity:
 *
 * - '@me' (the personal space) comes first for any signed-in user — it
 *   exists even with zero team memberships.
 * - org.admin (and sys.admin) implies the FULL team permission set — the
 *   server resolver's documented expansion; per-team rows only carry
 *   explicit task.* grants for regular members.
 * - Rosterless identities (the OSS single-team server) derive refs from the
 *   deployment rows with control assumed — the server enforces the real
 *   permission on every call. Personal (`user~`) rows never become targets.
 *
 * @param client - A connected client (its cached ConnectResult is read), or none.
 * @param deployments - Deployment rows used as the rosterless fallback.
 * @returns The addressable team refs.
 */
export function resolveDeployTeams(client: { getAccountInfo(): ConnectResult | undefined } | null | undefined, deployments: Deployment[]): DeployTeamRef[] {
	const info = client?.getAccountInfo();
	const org = info?.organization;
	const me: DeployTeamRef[] = info?.userId ? [{ id: '@me', name: 'Me', canControl: true }] : [];
	const isAdmin = (org?.permissions ?? []).includes('org.admin') || (info?.sysPermissions ?? []).includes('sys.admin');

	// step: prefer the identity's team roster when one exists
	const orgTeams = org?.teams;
	if (Array.isArray(orgTeams) && orgTeams.length > 0) {
		return [...me, ...orgTeams.filter((t) => t.id).map((t) => ({ id: t.id, name: t.name || t.id, canControl: isAdmin || (t.permissions ?? []).includes('task.control') }))];
	}

	// step: rosterless — derive refs from the rows so hosts still render
	const seen = new Map<string, DeployTeamRef>();
	for (const dep of deployments) {
		if (dep.teamId && !dep.teamId.startsWith('user~') && !seen.has(dep.teamId)) {
			seen.set(dep.teamId, { id: dep.teamId, name: dep.teamId, canControl: true });
		}
	}
	return [...me, ...seen.values()];
}

/**
 * Resolves a team id to its display name, falling back to the id. Personal
 * (`user~`) owner keys render as "Me" for the caller's own space and
 * "Personal" for another user's (admin visibility) — the raw guid never
 * reaches a label.
 *
 * @param teams - The resolved team refs.
 * @param teamId - The team id (or owner key) to resolve.
 * @param ownUserId - The caller's user id ('' when unknown).
 * @returns The display name, or the id when unknown.
 */
export function teamNameOf(teams: DeployTeamRef[], teamId: string, ownUserId = ''): string {
	if (teamId.startsWith('user~')) {
		return ownUserId && teamId === `user~${ownUserId}` ? 'Me' : 'Personal';
	}
	return teams.find((t) => t.id === teamId)?.name ?? teamId;
}

/**
 * Translates a row's owner key into the ADDRESSABLE team ref for API calls:
 * the caller's own `user~{uid}` row is addressed as '@me' (the server never
 * accepts raw owner keys); everything else passes through.
 *
 * @param teamId - The row's team id / owner key.
 * @param ownUserId - The caller's user id ('' when unknown).
 * @returns The team id to put on the wire.
 */
export function wireTeamIdOf(teamId: string, ownUserId: string): string {
	return ownUserId && teamId === `user~${ownUserId}` ? '@me' : teamId;
}

/**
 * Resolves what a person typed as a team — '@me', a team id, or a team
 * display name (case-insensitive) — to the id to send. An unknown value
 * passes through unchanged (the server validates it; an admin may address
 * a team outside their own roster).
 *
 * @param input - The typed team ('' = unscoped/default).
 * @param teams - The caller's resolved team refs.
 * @returns The team id to put on the wire.
 * @throws Error when a name matches more than one team.
 */
export function resolveTeamArg(input: string, teams: DeployTeamRef[]): string {
	const typed = input.trim();
	if (!typed || typed === '@me' || teams.some((t) => t.id === typed)) return typed;
	const byName = teams.filter((t) => t.name.toLowerCase() === typed.toLowerCase());
	if (byName.length > 1) {
		throw new Error(`Team name "${typed}" is ambiguous — use one of the ids: ${byName.map((t) => t.id).join(', ')}`);
	}
	return byName[0]?.id ?? typed;
}

// =============================================================================
// PIPELINES
// =============================================================================

/**
 * The registry name for a pipeline file whose JSON carries none — `.pipe`
 * names live in FILENAMES, and every deploy surface renders pipelineName.
 *
 * @param filePath - The pipeline file path (either separator).
 * @returns The basename without its `.pipe` / `.pipe.json` extension.
 */
export function pipelineNameFromPath(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() || filePath;
	return base.replace(/\.pipe(?:\.json)?$/, '') || base;
}
