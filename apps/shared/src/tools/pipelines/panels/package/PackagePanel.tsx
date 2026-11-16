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
// PACKAGE PANEL — the pipeline described: Identity, API Params, and the Step 6 tabs
// =============================================================================

/**
 * The pipeline's PACKAGE page (named-pipes mockups 2.3, 2.4, 2.8–2.10, 1.8b):
 * a left {@link SidebarMenu} of side tabs — Identity, API Params, Assets,
 * Store, Requirements, Review — and the active tab's pane on the right.
 *
 * - Identity edits the pipeline's own fields through the document: the short
 *   id (`project_id`, dot-free — the publisher namespace is DERIVED at
 *   publish, never typed), display name, description and the default source
 *   (the `.pipe` root `source`). Every change writes the document like the
 *   params page does (a `docRevision` bump), so the canvas, Save and the
 *   dirty state are the editor's as usual; the page itself holds no draft.
 * - API Params hosts the {@link ParamsPanel} map editor (plan §5.5).
 * - Assets, Store, Requirements and Review need the pipeline bundle, the
 *   store and the review ladder (plan Step 6, C.17); until then each is an
 *   empty state that says so, so the tab list is complete from day one.
 */

import React, { CSSProperties, useMemo, useState } from 'react';
import type { ViewMenu } from 'shell';
import { Card, commonStyles, EmptyState, InputField, SidebarMenu } from 'shell';
import type { ServiceParamDescriptor } from 'rocketride';
import { ParamsPanel } from '../params';
import type { IParamsProject } from '../params';

// =============================================================================
// TYPES
// =============================================================================

/** The PACKAGE side tabs, in order. */
export type PackageSection = 'identity' | 'api-params' | 'assets' | 'store' | 'requirements' | 'review';

/** The pipeline document fields the Identity page reads and writes. */
export interface IPackageProject extends IParamsProject {
	/** Display name (the `.pipe` root `name`). */
	name?: string;
	/** Description (the `.pipe` root `description`). */
	description?: string;
	/** Default source component id (the `.pipe` root `source`, plan §9). */
	source?: string;
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

/** What the Step 6 tabs will hold, told as an empty state until they land. */
const PENDING_SECTIONS: Record<'assets' | 'store' | 'requirements' | 'review', { title: string; description: string }> = {
	assets: { title: 'Assets land with publishing', description: 'The icon, the readme, and the readme\'s images under ./assets/ as thumbnails — once the pipeline bundle (plan Step 6) exists.' },
	store: { title: 'Store lands with publishing', description: 'Mode (Free, Subscription, Paywall), plans and the required permission — the same card an app has — once pipelines publish to the store (plan Step 6).' },
	requirements: { title: 'Requirements land with publishing', description: 'The one checklist: what deploying needs, what callers need, the public parameters, the store ladder (plan Step 6).' },
	review: { title: 'Review lands with publishing', description: 'The conversation with the store review team, by version (plan Step 6).' },
};

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
};

// =============================================================================
// IDENTITY
// =============================================================================

/**
 * The Identity page: the pipeline's own fields, written through the document.
 *
 * @param props - The panel props.
 * @returns The Identity pane.
 */
function IdentitySection({ project, sources, developerId, onContentChanged }: IPackagePanelProps): React.ReactElement {
	const readonly = !onContentChanged;
	const shortId = project.project_id ?? '';
	const idProblem = shortId && !SHORT_ID_PATTERN.test(shortId) ? 'A pipeline id is one dot-free segment: letters, digits, _ and - only (B5).' : null;
	const publishedAs = `${developerId || '{developerId}'}.${shortId || '{pipeId}'}`;

	/** Writes one root field through the document (a revision bump, like the params page). */
	const write = (patch: Partial<IPackageProject>): void => {
		onContentChanged?.({ ...project, ...patch, docRevision: (project.docRevision ?? 0) + 1 });
	};

	return (
		<Card header="Identity">
			<div style={styles.formRow}>
				<div style={styles.formLabel}>Pipeline id</div>
				<InputField type="text" style={styles.mono} value={shortId} disabled={readonly} pattern={SHORT_ID_PATTERN.source} aria-invalid={idProblem ? true : undefined} placeholder="docBrain" onChange={(event) => write({ project_id: event.target.value })} />
				{idProblem ? <div style={styles.problem}>{idProblem}</div> : null}
				<div style={styles.help}>
					Short name, no dots. Published as <span style={{ ...styles.mono, ...styles.helpStrong }}>{publishedAs}</span>
					{developerId ? '' : ' once your organization claims a developer id'} — the publisher is whoever publishes; it is never typed here. Renaming after publish starts a new lineage.
				</div>
			</div>
			<div style={styles.formRow}>
				<div style={styles.formLabel}>Display name</div>
				<InputField type="text" value={project.name ?? ''} disabled={readonly} placeholder="Doc brain" onChange={(event) => write({ name: event.target.value })} />
			</div>
			<div style={styles.formRow}>
				<div style={styles.formLabel}>Description</div>
				<textarea style={styles.formArea} value={project.description ?? ''} disabled={readonly} onChange={(event) => write({ description: event.target.value })} />
			</div>
			<div style={styles.formRow}>
				<div style={styles.formLabel}>Default source</div>
				<select style={styles.select} value={project.source ?? ''} disabled={readonly || sources.length === 0} onChange={(event) => write({ source: event.target.value || undefined })}>
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
			<div style={styles.help}>Tagline, category, tags and links are part of the store manifest and arrive with publishing (plan Step 6).</div>
		</Card>
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
		default: {
			const pending = PENDING_SECTIONS[section];
			pane = <EmptyState title={pending.title} description={pending.description} />;
		}
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
