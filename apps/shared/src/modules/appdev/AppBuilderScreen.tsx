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
 * the three activity views — DEVELOP | DEPLOY | STORE — with the app's
 * `id · version` in the trailing slot (revised decision D1: activity names,
 * no coach bar, no artifact views).
 *
 * Hosts mount this ONE component in exactly one of two ways (decision D7):
 * rocket-ui direct-mounts it with an adapter over the live client; the
 * VSCode `page-app` webview mounts it with an adapter that bridges every
 * accessor/action over useMessaging to the extension host. The preview and
 * code surfaces are the only host-rendered pieces, passed in as slots.
 */

import React, { useMemo, useState } from 'react';
import { TabControl } from 'shell';
import type { ViewMenu } from 'shell';
import { DevelopView } from './DevelopView';
import { DeployView } from './DeployView';
import { StoreView } from './StoreView';
import type { AppBuilderStage, AppSummary, IAppBuilderHost } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link AppBuilderScreen} component. */
export interface IAppBuilderScreenProps {
	/** The host adapter — the single seam to platform data and actions. */
	host: IAppBuilderHost;
	/** The app being built. */
	app: AppSummary;
	/** Host-rendered live preview surface (iframe wrapper). */
	previewPane?: React.ReactNode;
	/** Host-rendered Code surface (web: file tree + Monaco). */
	codePane?: React.ReactNode;
	/** Initial activity view (defaults to 'develop'). */
	initialStage?: AppBuilderStage;
	/** Notified when the user switches views (hosts persist view state). */
	onStageChange?: (stage: AppBuilderStage) => void;
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
	host, app, previewPane, codePane, initialStage, onStageChange,
}) => {
	// ── Stage — the active activity view ─────────────────────────────────
	const [stage, setStage] = useState<AppBuilderStage>(initialStage ?? 'develop');

	// The three activity views, per the settled UI model
	const viewMenu: ViewMenu = useMemo(() => ({
		entries: [
			{ id: 'develop', label: 'Develop' },
			{ id: 'deploy', label: 'Deploy' },
			{ id: 'store', label: 'Store' },
		],
	}), []);

	/** Switch views and let the host persist the selection. */
	const selectStage = (id: string): void => {
		const next = id as AppBuilderStage;
		setStage(next);
		onStageChange?.(next);
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
				{stage === 'develop' && (
					<DevelopView host={host} previewPane={previewPane} codePane={codePane} />
				)}
				{stage === 'deploy' && <DeployView host={host} app={app} />}
				{stage === 'store' && <StoreView host={host} app={app} />}
			</div>
		</div>
	);
};
