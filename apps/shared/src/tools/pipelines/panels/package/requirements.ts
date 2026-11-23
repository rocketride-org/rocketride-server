// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// PIPELINE REQUIREMENTS — the checklist derived from the document and the rail
// =============================================================================

/**
 * The pure half of PACKAGE › Requirements for a pipeline (named-pipes mockup
 * 2.10, plan Step 6): what deploying needs, what callers need, the public
 * parameters, and the store ladder. Everything here is a function of the
 * document and the version rail — no host, no React — so the page renders
 * the answer and the tests pin it.
 *
 * Engine sharing is deliberately NOT a line here (decided 2026-11-16): it is
 * the engine's decision from the shape, not a publisher-facing requirement.
 */

import type { PipeStoreBlock } from 'rocketride';
import type { IRequirementItem } from '../../../../components/requirements';
import { extractPipelineEnvVars } from '../design/canvas/util/extractEnvVars';

// =============================================================================
// TYPES
// =============================================================================

/** The document fields the checklist reads (a PACKAGE project is assignable). */
export interface IRequirementsProject {
	project_id?: string;
	components?: Array<{ id: string }>;
	/** The `parameters` map: public name -> `nodeId.configKey`. */
	parameters?: Record<string, string>;
	store?: PipeStoreBlock;
}

/** One rail entry as the ladder reads it (an app {@link AppVersionInfo} is assignable). */
export interface IRequirementsVersion {
	registryVersion: number;
	state?: 'private' | 'submit' | 'ready' | 'rejected' | 'failed';
}

/** One public parameter: its caller-facing name and the `nodeId.configKey` it writes. */
export interface IPublicParameter {
	name: string;
	target: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Short-id grammar (plan §2.2, B5): one dot-free segment — the pipeline id and every component id. */
export const SHORT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Whether an id is one dot-free segment (B5). The Identity page validates
 * typing against it; the editor refuses to address the registry with
 * anything else (a dotted draft id would compose another pipeline's name).
 *
 * @param id - The candidate id.
 * @returns True for a valid short id.
 */
export function isShortId(id: string): boolean {
	return SHORT_ID_PATTERN.test(id);
}

/** Human labels for the store modes. */
const MODE_LABELS: Record<string, string> = { free: 'Free', subscription: 'Subscription', paywall: 'Paywall' };

// =============================================================================
// CALLERS' NEEDS AND PUBLIC PARAMETERS
// =============================================================================

/**
 * The `${ROCKETRIDE_*}` placeholders the pipeline references, each once, in
 * first-seen order: what a caller must have set for the pipeline to run.
 *
 * @param project - The pipeline document.
 * @returns The variable names (without `${}`).
 */
export function callerNeedsOf(project: IRequirementsProject): string[] {
	return extractPipelineEnvVars(project as Record<string, unknown>);
}

/**
 * The public parameters as the `parameters` map declares them, in map order.
 *
 * @param project - The pipeline document.
 * @returns Name/target pairs; empty when the map is absent.
 */
export function publicParametersOf(project: IRequirementsProject): IPublicParameter[] {
	return Object.entries(project.parameters ?? {}).map(([name, target]) => ({ name, target }));
}

// =============================================================================
// WHAT DEPLOYING NEEDS
// =============================================================================

/**
 * The "To deploy" rows: the identity the registry accepts, the parameters map
 * the door validates, the developer namespace the address needs, and the
 * store listing every pipeline carries (the default block where the document
 * has none) with the README it declares.
 *
 * @param project - The pipeline document.
 * @param developerId - The org's developer id, '' while none is claimed.
 * @returns The rows, in page order.
 */
export function deployRequirements(project: IRequirementsProject, developerId: string): IRequirementItem[] {
	const items: IRequirementItem[] = [];
	const shortId = project.project_id ?? '';

	// step: the pipeline id and every component id are one dot-free segment (B5)
	const badComponents = (project.components ?? []).map((c) => c.id).filter((id) => !isShortId(id));
	if (!shortId) items.push({ id: 'ids', state: 'fail', label: 'Pipeline id missing', note: 'Set it on Identity' });
	else if (!isShortId(shortId)) items.push({ id: 'ids', state: 'fail', label: 'Pipeline id is not one dot-free segment', note: shortId });
	else if (badComponents.length > 0) items.push({ id: 'ids', state: 'fail', label: 'Component ids must be dot-free', note: badComponents.join(', ') });
	else items.push({ id: 'ids', state: 'pass', label: 'Pipeline id and component ids are dot-free', note: shortId });

	// step: every public parameter targets `nodeId.configKey` on a component the
	// document has — a target without the separator is rejected outright (on
	// `llm_1x` the slice arithmetic would otherwise read component `llm_1`)
	const componentIds = new Set((project.components ?? []).map((c) => c.id));
	const params = publicParametersOf(project);
	const dangling = params.filter(({ target }) => {
		const dot = target.lastIndexOf('.');
		if (dot <= 0 || dot === target.length - 1) return true;
		return !componentIds.has(target.slice(0, dot));
	});
	if (params.length === 0) items.push({ id: 'parameters', state: 'pass', label: 'Parameters map valid', note: 'no public parameters' });
	else if (dangling.length > 0) items.push({ id: 'parameters', state: 'fail', label: 'Parameters map points at missing components', note: dangling.map((p) => p.name).join(', ') });
	else items.push({ id: 'parameters', state: 'pass', label: 'Parameters map valid', note: `${params.length} public parameter${params.length === 1 ? '' : 's'}` });

	// step: the address needs the org's developer namespace
	if (developerId) items.push({ id: 'developer', state: 'pass', label: 'Developer id claimed', note: `published as ${developerId}.${shortId || '{pipeId}'}` });
	else items.push({ id: 'developer', state: 'fail', label: 'Your organization has no developer id', note: 'claim one above' });

	// step: every pipeline carries a store listing; the default block stands in
	// until the document has its own (a save or a deploy writes it)
	const store = project.store;
	if (!store) {
		items.push({ id: 'store', state: 'pass', label: 'Store listing: the default', note: 'written when you save or deploy' });
		return items;
	}
	items.push({ id: 'store', state: 'pass', label: 'Store listing set' });
	// step: the README is the store page; an icon is optional (a listing
	// without one shows the first letter of its name)
	if (store.readme) items.push({ id: 'assets', state: 'pass', label: store.icon ? 'README and icon declared' : 'README declared', note: [store.readme, store.icon].filter(Boolean).join(', ') });
	else items.push({ id: 'assets', state: 'warn', label: 'No README declared', note: 'Assets' });
	return items;
}

// =============================================================================
// THE STORE LADDER
// =============================================================================

/**
 * The newest rail entry that can still move (a 'failed' version never does).
 *
 * @param versions - The rail, any order.
 * @returns The entry, or undefined on an empty rail.
 */
function newestLive(versions: IRequirementsVersion[]): IRequirementsVersion | undefined {
	return versions.filter((v) => v.state !== 'failed').sort((a, b) => b.registryVersion - a.registryVersion)[0];
}

/**
 * The "To list publicly" rows: the ladder private -> submit -> ready read off
 * the newest version, plus the pricing the block proposes.
 *
 * @param project - The pipeline document (its `store` block).
 * @param versions - The version rail the host already gives DEPLOY.
 * @returns The rows, in ladder order.
 */
export function storeLadder(project: IRequirementsProject, versions: IRequirementsVersion[]): IRequirementItem[] {
	const items: IRequirementItem[] = [];
	const newest = newestLive(versions);

	// step: a version exists to submit
	if (newest) items.push({ id: 'deployed', state: 'pass', label: 'Deployed to the server', note: `v${newest.registryVersion} is the newest` });
	else items.push({ id: 'deployed', state: 'pending', label: 'Deploy a version', note: 'DEPLOY' });

	// step: pricing is set (free counts, and is the default listing's mode; a paid mode needs a plan)
	const mode = project.store?.mode ?? 'free';
	const plans = project.store?.billing?.plans?.length ?? 0;
	if (mode === 'free') items.push({ id: 'pricing', state: 'pass', label: 'Pricing set', note: 'Free' });
	else if (plans > 0) items.push({ id: 'pricing', state: 'pass', label: 'Pricing set', note: `${MODE_LABELS[mode] ?? mode}, ${plans} plan${plans === 1 ? '' : 's'}` });
	else items.push({ id: 'pricing', state: 'fail', label: `Mode ${MODE_LABELS[mode] ?? mode} needs at least one plan`, note: 'Store' });

	// step: the review ladder on the newest version
	const state = newest?.state ?? 'private';
	const v = newest ? `v${newest.registryVersion}` : '';
	if (state === 'submit') items.push({ id: 'submitted', state: 'pass', label: `${v} submitted for review` });
	else if (state === 'ready') items.push({ id: 'submitted', state: 'pass', label: `${v} submitted for review` });
	else if (state === 'rejected') items.push({ id: 'submitted', state: 'fail', label: `${v} rejected`, note: 'deploy again to resubmit' });
	else items.push({ id: 'submitted', state: 'pending', label: 'Submit the newest version for review', note: 'DEPLOY' });
	if (state === 'ready') items.push({ id: 'ready', state: 'pass', label: `${v} approved for the store` });
	else items.push({ id: 'ready', state: 'pending', label: 'Review by RocketRide' });
	return items;
}

/**
 * The lead sentence above the deploy rows: what the marks add up to.
 *
 * @param deploy - The "To deploy" rows.
 * @returns One sentence.
 */
export function requirementsLead(deploy: IRequirementItem[]): string {
	const failing = deploy.filter((c) => c.state === 'fail').length;
	const warning = deploy.filter((c) => c.state === 'warn').length;
	if (failing > 0) return `${failing} item${failing === 1 ? ' needs' : 's need'} fixing before this pipeline can deploy.`;
	if (warning > 0) return `Everything deploying needs is in place. ${warning} optional item${warning === 1 ? '' : 's'} would complete its listing.`;
	return 'Everything is in place. Deploy it from DEPLOY whenever you like.';
}
