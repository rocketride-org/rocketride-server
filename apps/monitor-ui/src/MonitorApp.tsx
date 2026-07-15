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
// MONITOR APP — Main client area component
// =============================================================================
//
// Renders the shared MonitorView, sourcing the 3s dashboard snapshot and live
// activity feed from the shared useDashboardData hook (shell-ui) instead of a
// hand-rolled poll. Pattern matches rocket-ui's MonitorPage.tsx.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import type { ShellAppProps } from 'shell-ui';
import { useShellConnection, useDashboardData } from 'shell-ui';
import { commonStyles } from 'shared/themes/styles';
import { MonitorView } from 'shared';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	container: {
		...commonStyles.columnFill,
	} as CSSProperties,

};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Server Monitor app — client area.
 *
 * Sources the dashboard snapshot and activity feed from the shared
 * useDashboardData hook (shell-ui), which polls `getDashboard()` every 3
 * seconds and subscribes to live server events through the shell client.
 * Renders the shared MonitorView with the latest data.
 */
const MonitorApp: React.FC<ShellAppProps> = (_props) => {
	const { isConnected } = useShellConnection();

	// Shared 3s dashboard snapshot + activity feed (module-level singleton hook,
	// so data survives view switches without re-fetching).
	const { data, events, refresh } = useDashboardData();

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div style={styles.container}>
			<MonitorView
				data={data}
				events={events}
				isConnected={isConnected}
				onRefresh={refresh}
			/>
		</div>
	);
};

export default MonitorApp;
