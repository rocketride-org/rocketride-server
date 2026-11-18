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
 * the activity views — DESIGN | PACKAGE | DEPLOY — with the app's
 * `id · version` in the trailing slot (revised decision D1: activity names,
 * no coach bar, no artifact views). DESIGN is the landing view; PACKAGE
 * describes the app in side tabs (Identity, Assets, Build, Store,
 * Requirements, Review). DASHBOARD was retired and STORE folded into
 * PACKAGE on 2026-11-16 (named-pipes mockups 1.x).
 * Code editing lives OUTSIDE this screen on every host (VSCode edits
 * natively; the web edits through the workspace Explorer's file tabs).
 *
 * Hosts mount this ONE component in exactly one of two ways (decision D7):
 * rocket-ui direct-mounts it with an adapter over the live client; the
 * VSCode `page-app` webview mounts it with an adapter that bridges every
 * accessor/action over useMessaging to the extension host. The preview
 * surface is the only host-rendered piece, passed in as a slot.
 */

import React, { useMemo, useState } from 'react';
import { TabControl } from 'shell';
import type { ViewMenu } from 'shell';
import { DesignView } from './panels/design/DesignView';
import { DeployView } from './panels/deploy/DeployView';
import { PackageView } from './panels/package/PackageView';
import type { AppBuilderStage, AppSummary, IAppBuilderHost } from '../../types';

// =============================================================================
// TYPES
// =============================================================================

/** The prefs key holding the active activity view. */
const STAGE_PREF_KEY = 'stage';

/**
 * Maps a persisted stage to the CURRENT vocabulary, defaulting to the landing
 * view (DESIGN). Legacy values must not resurrect a tab that is gone:
 * 'develop' predates the DEVELOP -> DESIGN rename, 'code' predates the web
 * host dropping the CODE tab, 'dashboard' predates the DASHBOARD retirement
 * and 'store' predates STORE becoming a PACKAGE side tab (2026-11-16).
 *
 * @param raw - The persisted value, or undefined when never persisted.
 * @returns A stage that exists today.
 */
function normalizeStage(raw: unknown): AppBuilderStage {
	if (raw === 'design' || raw === 'package' || raw === 'deploy') return raw;
	// 'develop' predates the DEVELOP -> DESIGN rename; 'dashboard' predates
	// the DASHBOARD retirement (DESIGN is the landing view now); 'store'
	// predates STORE becoming a PACKAGE side tab (2026-11-16).
	if (raw === 'store') return 'package';
	return 'design';
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

	// The activity views (named-pipes mockups 1.x, 2026-11-16): Design lands
	// first; Package describes the app, Store included, in side tabs.
	const viewMenu: ViewMenu = useMemo(() => ({
		entries: [
			{ id: 'design', label: 'Design' },
			{ id: 'package', label: 'Package' },
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

			{/* Active view body */}
			<div style={styles.body}>
				{stage === 'design' && (
					<DesignView host={host} previewPane={previewPane} />
				)}
				{/* The files carry the app's SLUG; the organization that deploys
				    attaches its developer id, so there is no namespace to gate. */}
				{stage === 'package' && <PackageView host={host} app={app} onNavigate={selectStage} />}
				{stage === 'deploy' && <DeployView host={host} app={app} />}
			</div>
		</div>
	);
};
