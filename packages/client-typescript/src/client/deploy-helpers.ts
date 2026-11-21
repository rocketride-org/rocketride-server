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
	/** What a deploy verb's `teamId` takes for this target, passed unchanged:
	    '@me' for the caller's personal space, or the team's audience as the
	    server composed it (`=team/<tid>`). */
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
 * - Each team of the roster is addressed by the `audience` the server
 *   stamped on it; a team without one is not addressable and is skipped.
 * - org.admin (and sys.admin) implies the FULL team permission set — the
 *   server resolver's documented expansion; per-team rows only carry
 *   explicit task.* grants for regular members.
 * - Rosterless identities (the OSS single-team server) derive refs from the
 *   deployment rows the server marked `rung: 'team'`, named by their
 *   `handle`, with control assumed — the server enforces the real permission
 *   on every call. No audience string is parsed here.
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
		const roster = orgTeams.flatMap((t): DeployTeamRef[] => (t.audience ? [{ id: t.audience, name: t.name || t.audience, canControl: isAdmin || (t.permissions ?? []).includes('task.control') }] : []));
		return [...me, ...roster];
	}

	// step: rosterless — derive refs from the team rows so hosts still render
	const seen = new Map<string, DeployTeamRef>();
	for (const dep of deployments) {
		if (dep.teamId && dep.rung === 'team' && !seen.has(dep.teamId)) {
			seen.set(dep.teamId, { id: dep.teamId, name: dep.handle || dep.teamId, canControl: true });
		}
	}
	return [...me, ...seen.values()];
}

// =============================================================================
// REGISTRY NAMES
// =============================================================================

/**
 * The slug an app manifest names: the id with anything up to and including
 * its LAST dot discarded.
 *
 * An app's files carry only the slug (`appManifest.id`, the `.rrapp`
 * trigger, the descriptor literal); the developer namespace is attached by
 * the organization that deploys it, never read from the file. A manifest
 * written before this rule may still carry `<developerId>.<slug>`: the
 * prefix is ignored as if it had never been specified. Pipes are stricter
 * (a dotted `project_id` is refused), so this is for apps only.
 *
 * @param manifestId - `appManifest.id` as written.
 * @returns The slug ('' when the id is missing).
 */
export function appSlugOf(manifestId: string | null | undefined): string {
	// No trimming: the deploy door validates the untrimmed suffix, so verify
	// must report what deploy will see
	const id = typeof manifestId === 'string' ? manifestId : '';
	if (!id) return '';
	const dot = id.lastIndexOf('.');
	return dot >= 0 ? id.slice(dot + 1) : id;
}

/**
 * The registry name an app or pipe is deployed, published and resolved under.
 *
 * Every registry row (`deployment_projects`, `deployment_artifacts`,
 * `published_artifacts`, `deployment_history`), every deploy-change event
 * and every `apaevt_build*` event carries `<developerId>.<slug>`. Clients
 * SEND the slug (the server composes the name from the deploying
 * organization); this is the value to MATCH rows and events against.
 *
 * @param slug - The short id the file carries.
 * @param developerId - The caller organization's developer id, if known.
 * @returns The registry name, or '' when the developer id is unknown (no
 *          row can match: nothing deploys without one).
 */
export function registryIdOf(slug: string, developerId: string | null | undefined): string {
	if (!slug || !developerId) return '';
	return slug.includes('.') ? slug : `${developerId}.${slug}`;
}

/** The developer id a build names itself under when its organization has none yet. */
export const LOCAL_DEVELOPER_ID = 'local';

/**
 * The Module Federation container name of a registry name: the name with
 * every character outside `[a-zA-Z0-9_$]` as an underscore (`acme.chat` is
 * `acme_chat`). A served build is named this way by the server from the
 * registry row; a dev build by the host that runs it.
 *
 * @param name - A registry name (`<developerId>.<slug>`).
 * @returns The container name.
 */
export function containerNameOf(name: string): string {
	return name.replace(/[^a-zA-Z0-9_$]/g, '_');
}

/**
 * The container name of a DEV build: the slug inside the organization's
 * developer namespace, or inside the reserved `local` namespace while the
 * organization has not claimed a developer id. `local` can never be a real
 * developer id, so a dev build never collides with a served one; the first
 * dev start after the claim renames the build.
 *
 * @param slug - The app slug (appManifest.id).
 * @param developerId - The organization's developer id, if it has one.
 * @returns `<developerId>_<slug>` or `local_<slug>`.
 */
export function devContainerNameOf(slug: string, developerId: string | null | undefined): string {
	return containerNameOf(`${developerId || LOCAL_DEVELOPER_ID}.${slug}`);
}

/**
 * The name of the team ref whose `id` is `teamId`, else `teamId` unchanged.
 *
 * @deprecated Show a row's `handle` instead: the server composes it for the
 * reader (plan 2.5). Kept for the frozen contract; it parses nothing.
 *
 * @param teams - The resolved team refs.
 * @param teamId - A ref id or a row's `teamId`, matched exactly.
 * @param _ownUserId - Unused; kept for the frozen signature.
 * @returns The matching ref's name, or `teamId`.
 */
export function teamNameOf(teams: DeployTeamRef[], teamId: string, _ownUserId = ''): string {
	return teams.find((t) => t.id === teamId)?.name ?? teamId;
}

/**
 * The value to put on the wire for a row's `teamId`: the value itself.
 *
 * @deprecated A row's `teamId` is its audience and every deploy verb takes
 * it back unchanged (plan 2.5); there is nothing to translate. Kept for the
 * frozen contract.
 *
 * @param teamId - The row's `teamId`.
 * @param _ownUserId - Unused; kept for the frozen signature.
 * @returns `teamId`, unchanged.
 */
export function wireTeamIdOf(teamId: string, _ownUserId: string): string {
	return teamId;
}

/**
 * What a person typed as a team, passed through for the server to resolve.
 * The server reads every spelling (`@me`, `@public`, `@<team>` by name
 * ignoring case, `=team/<tid>`, a row's audience) and refuses an unknown
 * one; the SDK matches nothing (plan 2.5).
 *
 * @param input - The typed team ('' = unscoped/default).
 * @param _teams - Unused; kept for the frozen signature.
 * @returns The typed value, trimmed.
 */
export function resolveTeamArg(input: string, _teams: DeployTeamRef[]): string {
	return input.trim();
}

// =============================================================================
// PIPELINES
// =============================================================================

/**
 * The registry name for a pipeline file whose JSON carries none — `.pipe`
 * names live in FILENAMES, and every deploy surface renders pipelineName.
 *
 * @param filePath - The pipeline file path (either separator).
 * @returns The basename without its `.pipe` extension.
 */
export function pipelineNameFromPath(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() || filePath;
	return base.replace(/\.pipe$/, '') || base;
}
