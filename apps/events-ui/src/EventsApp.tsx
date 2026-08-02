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
// EVENTS-UI — MAIN APP (Archetype A: Dashboard)
// =============================================================================

import React, { useState } from 'react';
import type { ShellAppProps } from 'shell';
import { ContentHeader, MiniCard, MiniContainer, StatusBadge } from 'shell';
import type { StatusVariant } from 'shell';
import type { EventRow } from './types';
import { styles } from './styles';
import { useEventCapture } from './hooks/useEventCapture';
import { CaptureCard } from './components/CaptureCard';
import { EventsGrid } from './components/EventsGrid';
import { EventDetailPanel } from './components/EventDetailPanel';

// =============================================================================
// HELPERS
// =============================================================================

/** Run-state badge descriptor (variant + label) for the header. */
interface IRunBadge {
	/** Semantic badge variant. */
	variant: StatusVariant;
	/** Badge label. */
	label: string;
}

/**
 * Resolve the run-state badge: a missing client outranks the run flag (nothing
 * can stream without a connection), then active vs stopped.
 *
 * @param connected - Whether a shell client is available.
 * @param active - Whether monitoring is running.
 * @returns The badge variant + label.
 */
function runBadge(connected: boolean, active: boolean): IRunBadge {
	if (!connected) return { variant: 'error', label: 'Not connected' };
	if (active) return { variant: 'success', label: 'Monitoring' };
	return { variant: 'muted', label: 'Stopped' };
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Event Monitor — client area. A thin composition over {@link useEventCapture}:
 * the standard page header (run badge + Start/Stop + Clear), the capture
 * metrics as MiniCards, the subscription controls, and the live event grid,
 * with a row click opening the record detail panel.
 */
const EventsApp: React.FC<ShellAppProps> = (_props) => {
	const {
		config,
		snapshot,
		connected,
		toggleActive,
		clear,
		setToken,
		toggleType,
		selectAllTypes,
		clearTypes,
	} = useEventCapture();

	// The event whose body is open in the detail drawer (null = closed).
	const [selected, setSelected] = useState<EventRow | null>(null);

	// Header run-state badge, and whether Start is currently permitted.
	const badge = runBadge(connected, config.active);
	const canStart = config.types.length > 0;

	return (
		<div style={styles.root}>
			<ContentHeader
				title="Event Monitor"
				subtitle="Capture and inspect live DAP events from the connected engine."
				actions={<StatusBadge variant={badge.variant}>{badge.label}</StatusBadge>}
			/>

			<div style={styles.content}>
				{/* Capture metrics (natural height). */}
				<div style={styles.staticRow}>
					<MiniContainer columns={3}>
						<MiniCard value={snapshot.total.toLocaleString()} label="Captured" />
						<MiniCard value={snapshot.inMemory.toLocaleString()} label="In memory" />
						<MiniCard value={`${snapshot.rate}/s`} label="Event rate" />
					</MiniContainer>
				</div>

				{/* Capture controls + subscription (natural height); Start/Stop/Clear
				    live in this card's header. */}
				<div style={styles.staticRow}>
					<CaptureCard
						config={config}
						canStart={canStart}
						onToggleActive={toggleActive}
						onClear={() => {
							// Clearing the buffer must also dismiss the detail drawer:
							// the selected row no longer exists in the (now-empty) capture.
							clear();
							setSelected(null);
						}}
						onSetToken={setToken}
						onToggleType={toggleType}
						onSelectAllTypes={selectAllTypes}
						onClearTypes={clearTypes}
					/>
				</div>

				{/* The live event stream fills the remaining height and scrolls. */}
				<div style={styles.gridFill}>
					<EventsGrid rows={snapshot.rows} onRowClick={setSelected} />
				</div>
			</div>

			{/* Record slide-over for the selected event's body. */}
			<EventDetailPanel event={selected} onClose={() => setSelected(null)} />
		</div>
	);
};

export default EventsApp;
