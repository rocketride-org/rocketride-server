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
// VECTOR-UI - THE OVERVIEW TAB (the first tab of a connection)
// =============================================================================
//
// For now it holds the stats strip as the console had it: the figures, the
// chips (support, writes, caveats, "N need attention"), "counts as of", the
// scope line while a scope applies, and the collapsed Charts disclosure,
// whose bars set the scope.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import type { IDocumentsFilter } from '../contract/types';
import type { IHealthSummary } from '../vector/health';
import StatsStrip from './StatsStrip';
import type { IWorkbenchPanelProps } from './workbenchProps';

const styles = {
	scroll: { flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' } as CSSProperties,
};

/** Props for the {@link OverviewPanel} component. */
export interface IOverviewPanelProps extends IWorkbenchPanelProps {
	/** What the scope covers, while one applies (vector/filters.ts scopeStripText), or null. */
	scopeLine: string | null;
	/** The loaded documents' health (the "N need attention" chip). */
	health: IHealthSummary;
	/** A chart's bar was clicked: set its kind of condition on the scope. */
	onChartScope(filter: IDocumentsFilter): void;
}

/**
 * The Overview tab.
 *
 * @param props - {@link IOverviewPanelProps}.
 * @returns The tab's panel.
 */
export function OverviewPanel({ entry, model, console: state, selection, scopeLine, health, onChartScope }: IOverviewPanelProps): React.ReactElement {
	return (
		<div style={styles.scroll}>
			<StatsStrip stats={state.stats} dialect={model.connection.dialect} readOnly={model.readOnly} documents={state.directory.rows} scopeLine={scopeLine} sample={selection.connectionKey === entry.key ? selection.sampleModel : null} loading={state.directory.status === 'loading'} scopeFilter={model.scope?.filter ?? null} onScope={onChartScope} health={health} />
		</div>
	);
}

export default OverviewPanel;
