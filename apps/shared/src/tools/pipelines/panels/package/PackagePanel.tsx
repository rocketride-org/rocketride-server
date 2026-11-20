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
// PACKAGE PANEL — the pipeline described: Identity, API Params, Assets, Store
// =============================================================================

/**
 * The pipeline's PACKAGE page (named-pipes mockups 2.3, 2.4, 2.8–2.10, 1.8b):
 * a left {@link SidebarMenu} of side tabs — Identity, API Params, Assets,
 * Store, Requirements, Review — and the active tab's pane on the right.
 *
 * - Identity edits the pipeline's own fields through the document: the short
 *   id (`project_id`, dot-free — the publisher namespace is DERIVED at
 *   publish, never typed), display name, description and the default source
 *   (the `.pipe` root `source`), plus the listing words of the `store` block
 *   (tagline, categories, tags, links). Every change writes the document like
 *   the params page does (a `docRevision` bump), so the canvas, Save and the
 *   dirty state are the editor's as usual; the page itself holds no draft.
 * - API Params hosts the {@link ParamsPanel} map editor (plan §5.5).
 * - Store edits the `store` block's commerce posture (mode, plans) — the same
 *   card an app's Store tab shows, written through the document.
 * - Assets is the shared {@link AssetsPane}: the icon tile, the README
 *   edited in place with a store preview, the files the README references;
 *   the pane writes the files beside the pipe through the host and the
 *   block's icon/readme paths through the document.
 * - Requirements (2.10) is the only checklist, read-only: what deploying
 *   needs, what callers need, the public parameters, the store ladder — the
 *   pure derivation lives in `requirements.ts`, the rows in the shared
 *   {@link RequirementsChecklist} the app page draws too. No engine-sharing
 *   line (decided 2026-11-16).
 * - Review (1.8b) is the store thread for this pipeline by version: the app's
 *   {@link ReviewView} over the host's review adapter (one component, two
 *   adapters); absent the adapter (a readonly host, an unsaved document) the
 *   tab says so.
 *
 * The `store` block (plan §9, C.17b) is what makes a pipeline LISTABLE: with
 * it absent the panes show the default block, and the first write (or a save)
 * Store each offer the one button that stamps the SDK's default block.
 */

import React, { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewMenu } from 'shell';
import { Button, Card, commonStyles, EmptyState, InputField, SidebarMenu } from 'shell';
import type { BillingPlan, PipeStoreBlock, StoreMode, ServiceParamDescriptor } from 'rocketride';
import { defaultStoreBlock, pipeReadmeStub, STORE_MODES } from 'rocketride';
import { AssetsPane } from '../../../../components/assets';
import type { IAssetPaths, IAssetsHost } from '../../../../components/assets';
import { RequirementsChecklist } from '../../../../components/requirements';
import { PlanPanel } from '../../../appdev/views/builder/panels/store/PlanPanel';
import { ReviewView } from '../../../appdev/views/builder/panels/review/ReviewView';
import type { IReviewHost } from '../../../appdev/views/builder/panels/review/ReviewView';
import { ParamsPanel } from '../params';
import type { IParamsProject } from '../params';
import { callerNeedsOf, deployRequirements, publicParametersOf, requirementsLead, storeLadder } from './requirements';
import type { IRequirementsVersion } from './requirements';

// =============================================================================
// TYPES
// =============================================================================

/** The PACKAGE side tabs, in order. */
export type PackageSection = 'identity' | 'api-params' | 'assets' | 'store' | 'requirements' | 'review';

/** The pipeline document fields the PACKAGE page reads and writes. */
export interface IPackageProject extends IParamsProject {
	/** Display name (the `.pipe` root `name`). */
	name?: string;
	/** Description (the `.pipe` root `description`). */
	description?: string;
	/** Default source component id (the `.pipe` root `source`, plan §9). */
	source?: string;
	/** The store manifest (the `.pipe` root `store`, plan §9): present = listable. */
	store?: PipeStoreBlock;
}

/** One source component the default-source select offers. */
export interface IPackageSource {
	id: string;
	name: string;
}

/** Props for {@link PackagePanel}. */
export interface IPackagePanelProps {
	/** The pipeline document. */
	project: IPackageProject;
	/** The source components of the pipeline (for Default source). */
	sources: IPackageSource[];
	/** The service catalog (the params page's descriptors). */
	servicesJson: Record<string, { title?: string; params?: ServiceParamDescriptor[] } | undefined>;
	/** Resolves a node's schema on demand (the params page). */
	getNodeSchema?: (provider: string) => Promise<Record<string, unknown> | undefined>;
	/** Writes the document; absent on readonly hosts. */
	onContentChanged?: (project: IPackageProject) => void;
	/** The org's developer id, or '' until one is claimed (plan §2.1). */
	developerId: string;
	/** The server host, for the HTTP call example. */
	serverHost?: string;
	/** Which side tab opens first. */
	initialSection?: PackageSection;
	/**
	 * The files beside the pipeline (`./README.md`, `./icon.svg`, `assets/`):
	 * read, written, picked and opened through the host. Absent on a host
	 * that cannot reach the pipe's folder: Assets then says so.
	 */
	assetsHost?: IAssetsHost;
	/**
	 * The store-review adapter for this pipeline (the thread, the rail, the
	 * reply): Review mounts the app's view over it, Requirements reads the
	 * rail's review states for the store ladder. Absent on a readonly host
	 * or an unsaved document: Review then says so and the ladder shows no
	 * version.
	 */
	review?: IReviewHost;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** The side-tab menu (one entry per tab, in page order). */
const SECTION_MENU: ViewMenu = {
	entries: [
		{ id: 'identity', label: 'Identity' },
		{ id: 'api-params', label: 'API Params' },
		{ id: 'assets', label: 'Assets' },
		{ id: 'store', label: 'Store' },
		{ id: 'requirements', label: 'Requirements' },
		{ id: 'review', label: 'Review' },
	],
};

/** Short-id grammar (plan §2.2, B5): one dot-free segment. */
const SHORT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The store modes as the select shows them (the SDK owns the values). */
const MODE_LABELS: Record<StoreMode, string> = { free: 'Free', subscription: 'Subscription', paywall: 'Paywall' };

/** Interval groups in display order; unknown intervals append after these. */
const PLAN_GROUPS: Array<{ key: string; label: string }> = [
	{ key: 'month', label: 'Monthly Plans' },
	{ key: 'year', label: 'Annual Plans' },
	{ key: 'one_time', label: 'One-time' },
];

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	layout: {
		display: 'flex',
		alignItems: 'stretch',
		gap: 0,
		minHeight: 0,
		flex: 1,
	} as CSSProperties,
	nav: {
		width: 200,
		flexShrink: 0,
		borderRight: '1px solid var(--rr-border)',
		padding: '12px 8px',
		backgroundColor: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,
	pane: {
		flex: 1,
		minWidth: 0,
		padding: '4px 28px 48px 20px',
		overflowY: 'auto',
	} as CSSProperties,
	formRow: {
		display: 'flex',
		flexDirection: 'column',
		gap: 4,
		marginBottom: 14,
		maxWidth: 560,
	} as CSSProperties,
	formLabel: {
		fontSize: 11,
		fontWeight: 600,
		letterSpacing: '0.5px',
		textTransform: 'uppercase',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	formArea: {
		...commonStyles.inputField,
		minHeight: 64,
		resize: 'vertical',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	select: {
		...commonStyles.inputField,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	help: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	helpStrong: {
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	mono: {
		...commonStyles.fontMono,
	} as CSSProperties,
	problem: {
		fontSize: 12,
		color: 'var(--rr-color-error)',
	} as CSSProperties,
	// ── Links editor: one row per link, label beside URL ──────────────────
	linkRow: {
		display: 'flex',
		gap: 8,
		alignItems: 'center',
	} as CSSProperties,
	linkLabel: {
		flex: '0 0 160px',
	} as CSSProperties,
	linkUrl: {
		flex: 1,
		minWidth: 0,
	} as CSSProperties,
	// ── Pricing list — interval group headers with stock list rows ────────
	planGroup: {
		...commonStyles.labelUppercase,
		color: 'var(--rr-text-secondary)',
		marginTop: 10,
		marginBottom: 2,
	} as CSSProperties,
	planRow: {
		...commonStyles.listRow(false),
		padding: '3px 8px 3px 16px',
	} as CSSProperties,
	// An editable row is a native button (focusable, Enter/Space open it) drawn as the row.
	planRowButton: {
		width: '100%',
		border: 'none',
		background: 'transparent',
		font: 'inherit',
		textAlign: 'left',
	} as CSSProperties,
	planRowStatic: {
		cursor: 'default',
	} as CSSProperties,
	planName: {
		...commonStyles.textEllipsis,
		flex: 1,
	} as CSSProperties,
	planPrice: {
		...commonStyles.fontMono,
		fontSize: 12,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'nowrap',
	} as CSSProperties,
	planActions: {
		marginTop: 10,
	} as CSSProperties,
	// ── Requirements: group labels between row runs; plain rows for the lists ─
	reqGroup: {
		...commonStyles.labelUppercase,
		color: 'var(--rr-text-secondary)',
		marginTop: 16,
		marginBottom: 4,
	} as CSSProperties,
	reqGroupFirst: {
		marginTop: 0,
	} as CSSProperties,
	reqGroupRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
	} as CSSProperties,
	reqListRow: {
		display: 'flex',
		alignItems: 'baseline',
		gap: 10,
		padding: '4px 0',
		fontSize: 12.5,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	reqListNote: {
		color: 'var(--rr-text-disabled)',
		fontSize: 11.5,
	} as CSSProperties,
	// The Review pane owns the pane height: the thread card flexes inside it.
	reviewFill: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

/** A comma-separated list as the input shows it. */
function joinList(values: string[] | undefined): string {
	return (values ?? []).join(', ');
}

/** The list a comma-separated input stands for (trimmed, empties dropped). */
function splitList(text: string): string[] {
	return text.split(',').map((v) => v.trim()).filter(Boolean);
}

/** The storefront price label — metadata.displayAmount wins; always USD. */
function priceLabel(plan: BillingPlan): string {
	const display = (plan.metadata as { displayAmount?: unknown } | undefined)?.displayAmount;
	if (typeof display === 'string' && display) return display;
	return (plan.amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Sort key inside a group — metadata.order first, unordered plans last. */
function planOrder(plan: BillingPlan): number {
	const order = (plan.metadata as { order?: unknown } | undefined)?.order;
	return typeof order === 'number' ? order : Number.MAX_SAFE_INTEGER;
}

/** The first `Link n` label no row carries — a count-based label would reuse one after a removal and overwrite its URL. */
function freeLinkLabel(rows: Array<[string, string]>): string {
	const taken = new Set(rows.map(([label]) => label.trim()));
	for (let n = 1; ; n++) if (!taken.has(`Link ${n}`)) return `Link ${n}`;
}

/**
 * The one document-write path every pane uses: the patch lands on the root
 * with a `docRevision` bump, like the params page. Root-only writes never
 * touch `components`, so the canvas takes the revision without a reload.
 */
function documentWriter({ project, onContentChanged }: IPackagePanelProps): { readonly: boolean; write: (patch: Partial<IPackageProject>) => void; writeStore: (patch: Partial<PipeStoreBlock>) => void } {
	const write = (patch: Partial<IPackageProject>): void => {
		onContentChanged?.({ ...project, ...patch, docRevision: (project.docRevision ?? 0) + 1 });
	};
	const writeStore = (patch: Partial<PipeStoreBlock>): void => {
		write({ store: { ...(project.store ?? defaultStoreBlock()), ...patch } });
	};
	return { readonly: !onContentChanged, write, writeStore };
}

// =============================================================================
// IDENTITY
// =============================================================================

/**
 * The Identity page: the pipeline's own fields, written through the document,
 * plus the store block's listing words when the block exists.
 *
 * @param props - The panel props.
 * @returns The Identity pane.
 */
function IdentitySection(props: IPackagePanelProps): React.ReactElement {
	const { project, sources, developerId } = props;
	const { readonly, write, writeStore } = documentWriter(props);
	const shortId = project.project_id ?? '';
	const idProblem = shortId && !SHORT_ID_PATTERN.test(shortId) ? 'A pipeline id is one dot-free segment: letters, digits, _ and - only (B5).' : null;
	const publishedAs = `${developerId || '{developerId}'}.${shortId || '{pipeId}'}`;
	const store = project.store ?? defaultStoreBlock();
	// The links editor keeps insertion order; an entry being renamed keeps its
	// position because the map is rebuilt from the row list, not re-keyed.
	const linkRows = useMemo(() => Object.entries(store?.links ?? {}), [store?.links]);

	/** Writes the link rows back as the block's map (empty labels dropped). */
	const writeLinks = (rows: Array<[string, string]>): void => {
		const links: Record<string, string> = {};
		for (const [label, url] of rows) if (label.trim()) links[label.trim()] = url;
		writeStore({ links });
	};

	// Every caption is a <label htmlFor> of its control, so assistive
	// technology names the field the way the eye does.
	return (
		<Card header="Identity">
			<div style={styles.formRow}>
				<label htmlFor="rr-package-id" style={styles.formLabel}>Pipeline id</label>
				<InputField id="rr-package-id" type="text" style={styles.mono} value={shortId} disabled={readonly} pattern={SHORT_ID_PATTERN.source} aria-invalid={idProblem ? true : undefined} aria-describedby={idProblem ? 'rr-package-id-problem' : undefined} placeholder="docBrain" onChange={(event) => write({ project_id: event.target.value })} />
				{idProblem ? <div id="rr-package-id-problem" style={styles.problem}>{idProblem}</div> : null}
				<div style={styles.help}>
					Short name, no dots. Published as <span style={{ ...styles.mono, ...styles.helpStrong }}>{publishedAs}</span>
					{developerId ? '' : ' once your organization claims a developer id'} — the publisher is whoever publishes; it is never typed here. Renaming after publish starts a new lineage.
				</div>
			</div>
			<div style={styles.formRow}>
				<label htmlFor="rr-package-name" style={styles.formLabel}>Display name</label>
				<InputField id="rr-package-name" type="text" value={project.name ?? ''} disabled={readonly} placeholder="Doc brain" onChange={(event) => write({ name: event.target.value })} />
			</div>
			<div style={styles.formRow}>
				<label htmlFor="rr-package-tagline" style={styles.formLabel}>Tagline</label>
				<InputField id="rr-package-tagline" type="text" value={store.tagline ?? ''} disabled={readonly} placeholder="Answers from your documents" onChange={(event) => writeStore({ tagline: event.target.value })} />
			</div>
			<div style={styles.formRow}>
				<label htmlFor="rr-package-description" style={styles.formLabel}>Description</label>
				<textarea id="rr-package-description" style={styles.formArea} value={project.description ?? ''} disabled={readonly} onChange={(event) => write({ description: event.target.value })} />
			</div>
				<div style={styles.formRow}>
					<label htmlFor="rr-package-categories" style={styles.formLabel}>Categories</label>
					<InputField id="rr-package-categories" type="text" defaultValue={joinList(store.categories)} key={`cat:${joinList(store.categories)}`} disabled={readonly} placeholder="pipeline, productivity" onBlur={(event) => writeStore({ categories: splitList(event.target.value) })} />
					<div style={styles.help}>Comma-separated; the store groups listings by category.</div>
				</div>
				<div style={styles.formRow}>
					<label htmlFor="rr-package-tags" style={styles.formLabel}>Tags</label>
					<InputField id="rr-package-tags" type="text" defaultValue={joinList(store.tags)} key={`tag:${joinList(store.tags)}`} disabled={readonly} placeholder="documents, rag, chat" onBlur={(event) => writeStore({ tags: splitList(event.target.value) })} />
				</div>
			<div style={styles.formRow}>
				<label htmlFor="rr-package-source" style={styles.formLabel}>Default source</label>
				<select id="rr-package-source" style={styles.select} value={project.source ?? ''} disabled={readonly || sources.length === 0} onChange={(event) => write({ source: event.target.value || undefined })}>
					<option value="">{sources.length > 1 ? 'None — callers must name a source' : 'The only source'}</option>
					{sources.map((src) => (
						<option key={src.id} value={src.id}>
							{src.name} ({src.id})
						</option>
					))}
				</select>
				<div style={styles.help}>
					The entry a two-segment address or a <span style={styles.mono}>submit()</span> without <span style={styles.mono}>source</span> uses. With several sources and no default, callers get <span style={styles.mono}>source_required</span>.
				</div>
			</div>
			<div style={styles.formRow}>
				<div style={styles.formLabel}>Links</div>
				{linkRows.map(([label, url], index) => (
					<div key={index} style={styles.linkRow}>
						<InputField type="text" style={styles.linkLabel} aria-label={`Link ${index + 1} label`} defaultValue={label} key={`label:${index}:${label}`} disabled={readonly} placeholder="Docs" onBlur={(event) => writeLinks(linkRows.map((row, i) => (i === index ? [event.target.value, row[1]] : row)))} />
						<InputField type="url" style={styles.linkUrl} aria-label={`Link ${index + 1} URL`} value={url} disabled={readonly} placeholder="https://" onChange={(event) => writeLinks(linkRows.map((row, i) => (i === index ? [row[0], event.target.value] : row)))} />
						{!readonly && (
							<Button variant="ghost" small aria-label={`Remove link ${index + 1}`} onClick={() => writeLinks(linkRows.filter((_, i) => i !== index))}>
								Remove
							</Button>
						)}
					</div>
				))}
				{!readonly && (
					<div>
						<Button variant="secondary" small onClick={() => writeLinks([...linkRows, [freeLinkLabel(linkRows), '']])}>
							Add link
						</Button>
					</div>
				)}
				<div style={styles.help}>Shown on the store page: documentation, support, source.</div>
			</div>
		</Card>
	);
}

// =============================================================================
// STORE
// =============================================================================

/**
 * The Store pane: the block's commerce posture — mode and, when not Free, the
 * pricing plans (the same card and record panel an app's Store tab uses),
 * written through the document.
 *
 * @param props - The panel props.
 * @returns The Store pane.
 */
function StoreSection(props: IPackagePanelProps): React.ReactElement {
	const { project } = props;
	const { readonly, writeStore } = documentWriter(props);
	// Plan record panel — a row click opens the record; "Add plan" opens the
	// same panel empty. idx null = Create mode.
	const [planPanel, setPlanPanel] = useState<{ idx: number | null } | null>(null);
	const store = project.store ?? defaultStoreBlock();

	const mode: StoreMode = store.mode ?? 'free';
	const plans = store.billing?.plans ?? [];
	/** Writes a new plan list into the block (the PlanPanel's onSave/onRemove contract is async). */
	const writePlans = async (next: BillingPlan[]): Promise<void> => {
		writeStore({ billing: { ...store.billing, plans: next } });
	};

	// Bucket plans by interval, keeping their index for the record panel;
	// unknown intervals get their own trailing group rather than mislabeling.
	const groups = [...PLAN_GROUPS];
	for (const p of plans) if (!groups.some((g) => g.key === p.interval)) groups.push({ key: p.interval, label: p.interval });

	return (
		<>
			<Card header="Store listing">
				<div style={styles.formRow}>
					<label htmlFor="rr-package-mode" style={styles.formLabel}>Mode</label>
					<select id="rr-package-mode" style={styles.select} value={mode} disabled={readonly} onChange={(event) => writeStore({ mode: event.target.value as StoreMode })}>
						{STORE_MODES.map((mode) => (
							<option key={mode} value={mode}>
								{MODE_LABELS[mode]}
							</option>
						))}
					</select>
					<div style={styles.help}>Free lists the pipeline at no charge; Subscription and Paywall need at least one plan. The pricing is a proposal that goes live on approval.</div>
				</div>
				{mode !== 'free' && (
					<div style={styles.formRow}>
						<div style={styles.formLabel}>Pricing (proposal, live on approval)</div>
						{groups.map(({ key, label }) => {
							const rows = plans
								.map((plan, idx) => ({ plan, idx }))
								.filter(({ plan }) => plan.interval === key)
								.sort((a, b) => planOrder(a.plan) - planOrder(b.plan) || a.plan.nickname.localeCompare(b.plan.nickname));
							if (rows.length === 0) return null;
							return (
								<div key={key}>
									<div style={styles.planGroup}>{label}</div>
									{rows.map(({ plan, idx }) =>
										readonly ? (
											<div key={idx} style={{ ...styles.planRow, ...styles.planRowStatic }}>
												<span style={styles.planName}>{plan.nickname}</span>
												<span style={styles.planPrice}>{priceLabel(plan)}</span>
											</div>
										) : (
											<button key={idx} type="button" style={{ ...styles.planRow, ...styles.planRowButton }} aria-label={`Edit plan ${plan.nickname}`} onClick={() => setPlanPanel({ idx })}>
												<span style={styles.planName}>{plan.nickname}</span>
												<span style={styles.planPrice}>{priceLabel(plan)}</span>
											</button>
										)
									)}
								</div>
							);
						})}
						{plans.length === 0 && <div style={styles.problem}>Mode "{MODE_LABELS[mode]}" needs at least one plan.</div>}
						{!readonly && (
							<div style={styles.planActions}>
								<Button variant="secondary" small onClick={() => setPlanPanel({ idx: null })}>
									Add plan
								</Button>
							</div>
						)}
					</div>
				)}
			</Card>
			{/* Plan record panel (stock DetailPanel): its Save writes the block through the document. */}
			{planPanel && <PlanPanel open plan={planPanel.idx === null ? null : (plans[planPanel.idx] ?? null)} appName={project.name || project.project_id || 'this pipeline'} onSave={(p) => writePlans(planPanel.idx === null ? [...plans, p] : plans.map((x, i) => (i === planPanel.idx ? p : x)))} onRemove={planPanel.idx === null ? undefined : () => writePlans(plans.filter((_, i) => i !== planPanel.idx))} onClose={() => setPlanPanel(null)} />}
		</>
	);
}

// =============================================================================
// ASSETS
// =============================================================================

/**
 * The Assets pane: the shared {@link AssetsPane} over the block's icon and
 * readme paths. The pane writes the files beside the pipe through the host;
 * the paths it declares land in the `store` block through the document
 * (the default block applies when the document has none yet).
 *
 * @param props - The panel props.
 * @returns The Assets pane.
 */
function AssetsSection(props: IPackagePanelProps): React.ReactElement {
	const { project, assetsHost } = props;
	const { readonly } = documentWriter(props);
	const store = project.store ?? defaultStoreBlock();
	const displayName = project.name || project.project_id || 'this pipeline';

	// The props as they are NOW: a path change lands after an awaited file
	// write, and the patch must go onto the document as it is THEN (a component
	// added on the canvas meanwhile stays), not as it was when the drop began.
	const latest = useRef(props);
	latest.current = props;

	// A '' in the patch clears the key: the block then declares no such file
	// (validateStoreBlock refuses an empty path, so the key goes, not its value).
	const onPathsChange = useCallback((patch: IAssetPaths): void => {
		const current = latest.current;
		const next: PipeStoreBlock = { ...(current.project.store ?? defaultStoreBlock()) };
		for (const key of ['icon', 'readme'] as const) {
			const value = patch[key];
			if (value === undefined) continue;
			if (value === '') delete next[key];
			else next[key] = value;
		}
		documentWriter(current).write({ store: next });
	}, []);

	const readmeStub = useMemo(() => pipeReadmeStub(displayName), [displayName]);

	return (
		<Card header="Assets">
			{assetsHost ? (
				<AssetsPane kind="pipeline" host={assetsHost} docStem={project.project_id || 'pipeline'} paths={{ icon: store.icon ?? '', readme: store.readme ?? '' }} onPathsChange={onPathsChange} readmeStub={readmeStub} readonly={readonly} />
			) : (
				<EmptyState title="No files on this host" description="This host cannot reach the files beside the pipeline, so the icon and README cannot be shown or edited here." />
			)}
		</Card>
	);
}

// =============================================================================
// REQUIREMENTS
// =============================================================================

/**
 * The Requirements pane (mockup 2.10): the only checklist, read-only. Four
 * groups — To deploy, Public parameters, Callers need, To list publicly —
 * derived from the document by `requirements.ts`; the ladder group reads the
 * review states off the rail the review adapter serves (the same rail DEPLOY
 * draws). Every fix lives on the side tab that owns the field, so the rows
 * only point there.
 *
 * @param props - The panel props plus the side-tab switch for the API Params link.
 * @returns The Requirements pane.
 */
function RequirementsSection({ project, developerId, review, onOpenSection }: IPackagePanelProps & { onOpenSection: (section: PackageSection) => void }): React.ReactElement {
	// The rail's review states, for the ladder: fetched through the review
	// adapter and re-pulled on a deploy change (a submit or a verdict from
	// any session). null = no adapter (readonly host, unsaved document).
	const [versions, setVersions] = useState<IRequirementsVersion[] | null>(null);
	useEffect(() => {
		if (!review?.listVersions) {
			setVersions(null);
			return;
		}
		let live = true;
		const pull = (): void => {
			void review.listVersions!()
				.then((rail) => {
					if (live) setVersions(rail);
				})
				.catch(() => {
					if (live) setVersions([]);
				});
		};
		pull();
		const off = review.subscribeDeployChanged?.(pull);
		return () => {
			live = false;
			off?.();
		};
	}, [review]);

	const deploy = useMemo(() => deployRequirements(project, developerId), [project, developerId]);
	const parameters = useMemo(() => publicParametersOf(project), [project]);
	const callerNeeds = useMemo(() => callerNeedsOf(project), [project]);
	const ladder = useMemo(() => storeLadder(project, versions ?? []), [project, versions]);

	return (
		<Card header="Requirements">
			<div style={{ ...styles.reqGroup, ...styles.reqGroupFirst }}>To deploy</div>
			<RequirementsChecklist items={deploy} lead={requirementsLead(deploy)} />

			<div style={{ ...styles.reqGroup, ...styles.reqGroupRow }}>
				<span>Public parameters</span>
				<Button variant="ghost" small onClick={() => onOpenSection('api-params')}>
					API Params
				</Button>
			</div>
			{parameters.length === 0 ? (
				<div style={styles.help}>None: callers can only pass what the pipeline reads from its own config. Expose a field on API Params.</div>
			) : (
				parameters.map(({ name, target }) => (
					<div key={name} style={styles.reqListRow}>
						<span style={styles.mono}>{name}</span>
						<span style={styles.reqListNote}>
							writes <span style={styles.mono}>{target}</span>
						</span>
					</div>
				))
			)}

			<div style={styles.reqGroup}>Callers need</div>
			{callerNeeds.length === 0 ? (
				<div style={styles.help}>Nothing beyond an API key: the pipeline references no environment variables.</div>
			) : (
				callerNeeds.map((key) => (
					<div key={key} style={styles.reqListRow}>
						<span>callers must have</span>
						<span style={styles.mono}>{key}</span>
					</div>
				))
			)}

			<div style={styles.reqGroup}>To list publicly</div>
			<RequirementsChecklist items={ladder} />
			{versions === null && <div style={styles.help}>The ladder reads the version rail once the pipeline is saved and this host is connected.</div>}
		</Card>
	);
}

// =============================================================================
// REVIEW
// =============================================================================

/**
 * The Review pane (mockup 1.8b): the store thread for this pipeline by
 * version — the app's {@link ReviewView} over the review adapter.
 *
 * @param props - The panel props.
 * @returns The Review pane, or the empty state when no adapter serves it.
 */
function ReviewSection({ review, onContentChanged }: IPackagePanelProps): React.ReactElement {
	if (!review) return <EmptyState title="No review thread here" description="The conversation with the store review team opens once the pipeline is saved on a connected, editable host." />;
	return (
		<div style={styles.reviewFill}>
			<ReviewView host={review} subject="pipeline" readOnly={!onContentChanged} />
		</div>
	);
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The PACKAGE page: side tabs on the left, the active tab's pane on the right.
 *
 * @param props - {@link IPackagePanelProps}.
 * @returns The panel.
 */
const PackagePanel: React.FC<IPackagePanelProps> = (props) => {
	const { project, servicesJson, getNodeSchema, onContentChanged, developerId, serverHost, initialSection = 'identity' } = props;
	const [section, setSection] = useState<PackageSection>(initialSection);

	const address = useMemo(() => `${developerId || '{developerId}'}.${project.project_id ?? '{pipeId}'}`, [developerId, project.project_id]);

	let pane: React.ReactNode;
	switch (section) {
		case 'identity':
			pane = <IdentitySection {...props} />;
			break;
		case 'api-params':
			pane = <ParamsPanel project={project} servicesJson={servicesJson} getNodeSchema={getNodeSchema} onContentChanged={onContentChanged} address={address} serverHost={serverHost} />;
			break;
		case 'assets':
			pane = <AssetsSection {...props} />;
			break;
		case 'store':
			pane = <StoreSection {...props} />;
			break;
		case 'requirements':
			pane = <RequirementsSection {...props} onOpenSection={setSection} />;
			break;
		case 'review':
			pane = <ReviewSection {...props} />;
			break;
	}

	return (
		<div style={styles.layout}>
			<nav style={styles.nav} aria-label="Package sections">
				<SidebarMenu menu={SECTION_MENU} activeId={section} onSelect={(id) => setSection(id as PackageSection)} collapsed={false} />
			</nav>
			<div style={styles.pane}>{pane}</div>
		</div>
	);
};

PackagePanel.displayName = 'PackagePanel';

export default PackagePanel;
