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
// APP BUILDER SCREEN — the complete shared App Builder surface
// =============================================================================

/**
 * The App Builder's entire view surface: a top TabControl strip switching
 * the activity views — DASHBOARD | DESIGN | PACKAGE | STORE | DEPLOY —
 * with the app's `id · version` in the trailing slot (revised decision D1:
 * activity names, no coach bar, no artifact views). DASHBOARD is the
 * landing view; PACKAGE is the complete-app bar, STORE is commerce only.
 * Code editing lives OUTSIDE this screen on every host (VSCode edits
 * natively; the web edits through the workspace Explorer's file tabs).
 *
 * Hosts mount this ONE component in exactly one of two ways (decision D7):
 * rocket-ui direct-mounts it with an adapter over the live client; the
 * VSCode `page-app` webview mounts it with an adapter that bridges every
 * accessor/action over useMessaging to the extension host. The preview
 * surface is the only host-rendered piece, passed in as a slot.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { TabControl } from 'shell';
import type { ViewMenu } from 'shell';
import { DashboardView } from './panels/dashboard/DashboardView';
import { DesignView } from './panels/design/DesignView';
import { DeployView } from './panels/deploy/DeployView';
import { PackageView } from './panels/package/PackageView';
import { StoreView } from './panels/store/StoreView';
import type { AppBuilderStage, AppSummary, IAppBuilderHost } from '../../types';

// =============================================================================
// TYPES
// =============================================================================

/** The prefs key holding the active activity view. */
const STAGE_PREF_KEY = 'stage';

/**
 * Maps a persisted stage to the CURRENT vocabulary, defaulting to the landing
 * view. Two legacy values exist and must not resurrect a tab that is gone:
 * 'develop' predates the DEVELOP -> DESIGN rename, and 'code' predates the
 * web host dropping the CODE tab (the Explorer's file tabs replaced it).
 *
 * @param raw - The persisted value, or undefined when never persisted.
 * @returns A stage that exists today.
 */
function normalizeStage(raw: unknown): AppBuilderStage {
	if (raw === 'develop') return 'design';
	if (raw === 'design' || raw === 'package' || raw === 'store' || raw === 'deploy' || raw === 'dashboard') return raw;
	return 'dashboard';
}

/** Props for the {@link AppBuilderScreen} component. */
export interface IAppBuilderScreenProps {
	/** The host adapter — the single seam to platform data and actions. */
	host: IAppBuilderHost;
	/** The app being built. */
	app: AppSummary;
	/** Host-rendered live preview surface (iframe wrapper). */
	previewPane?: React.ReactNode;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
		background: 'var(--rr-bg-default)',
	},
	body: {
		flex: 1,
		minHeight: 0,
		position: 'relative',
		display: 'flex',
		flexDirection: 'column',
	},
	trailing: {
		fontSize: 11,
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		color: 'var(--rr-text-disabled)',
		alignSelf: 'center',
		paddingRight: 4,
	},
	// Namespace-mismatch banner above the STORE/DEPLOY views — the pages
	// below it render read-only.
	nsBanner: {
		margin: '12px 26px 0',
		padding: '10px 14px',
		border: '1px solid var(--rr-color-warning)',
		borderRadius: 8,
		background: 'rgba(232,185,49,0.10)',
		fontSize: 12.5,
		color: 'var(--rr-text-primary)',
		lineHeight: 1.5,
		flexShrink: 0,
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the App Builder screen: TabControl strip + the active view.
 *
 * @param props - See {@link IAppBuilderScreenProps}.
 */
export const AppBuilderScreen: React.FC<IAppBuilderScreenProps> = ({
	host, app, previewPane,
}) => {
	// ── Stage — the active activity view ─────────────────────────────────
	// Persisted HERE, not by the host: it is a pref like every other App
	// Builder UI pref, read synchronously off the host's prefs partition.
	// Both hosts used to carry identical stage plumbing of their own.
	const [stage, setStage] = useState<AppBuilderStage>(() => normalizeStage(host.getPref?.(STAGE_PREF_KEY)));

	// ── Namespace gate ───────────────────────────────────────────────────
	// The app id's prefix must match the org's developerId to publish. On a
	// mismatch STORE and DEPLOY render read-only (DEVELOP is untouched —
	// local work is always allowed). null = unknown (signed out / no org):
	// no gate, the server enforces ownership anyway.
	const [developerId, setDeveloperId] = useState<string | null>(null);
	useEffect(() => {
		if (!host.getDeveloperId) { setDeveloperId(null); return; }
		void host.getDeveloperId().then((id) => setDeveloperId(id || null)).catch(() => setDeveloperId(null));
	}, [host]);
	const namespaceMismatch = developerId !== null && app.id.split('.')[0] !== developerId;

	// The activity views, per the settled UI model — Dashboard lands first;
	// Package is the complete-app bar, Store is commerce only.
	const viewMenu: ViewMenu = useMemo(() => ({
		entries: [
			{ id: 'dashboard', label: 'Dashboard' },
			{ id: 'design', label: 'Design' },
			{ id: 'package', label: 'Package' },
			{ id: 'store', label: 'Store' },
			{ id: 'deploy', label: 'Deploy' },
		],
	}), []);

	/** Switch views and persist the selection. */
	const selectStage = (id: string): void => {
		const next = id as AppBuilderStage;
		setStage(next);
		host.setPref?.(STAGE_PREF_KEY, next);
	};

	return (
		<div style={styles.wrap}>
			{/* Top strip — the stock TabControl with the id·version note */}
			<TabControl
				menu={viewMenu}
				activeId={stage}
				onSelect={selectStage}
				trailing={
					<span style={styles.trailing}>
						{app.id}{app.version ? ` · v${app.version}` : ''}
					</span>
				}
			/>

			{/* Namespace-mismatch banner — why the page below is read-only.
			    STORE/DEPLOY only: DESIGN is local work (always allowed), and the
			    DASHBOARD is read-only by nature — it disables just its reply box
			    with an inline hint instead of opening the landing tab on a warning. */}
			{namespaceMismatch && (stage === 'store' || stage === 'deploy') && (
				<div style={styles.nsBanner}>
					<strong>Read-only:</strong> this app&rsquo;s id <code>{app.id}</code> is outside your
					organization&rsquo;s developer namespace <code>{developerId}</code>. Rename the app id
					in package.json to <code>{developerId}.&lt;name&gt;</code> to publish it from this org.
				</div>
			)}

			{/* Active view body */}
			<div style={styles.body}>
				{stage === 'dashboard' && (
					<DashboardView host={host} app={app} readOnly={namespaceMismatch} onNavigate={selectStage} />
				)}
				{stage === 'design' && (
					<DesignView host={host} previewPane={previewPane} />
				)}
				{/* Package edits LOCAL files (like DESIGN) — never namespace-gated. */}
				{stage === 'package' && <PackageView host={host} app={app} />}
				{stage === 'deploy' && <DeployView host={host} app={app} readOnly={namespaceMismatch} />}
				{stage === 'store' && <StoreView host={host} app={app} readOnly={namespaceMismatch} onNavigate={selectStage} />}
			</div>
		</div>
	);
};
