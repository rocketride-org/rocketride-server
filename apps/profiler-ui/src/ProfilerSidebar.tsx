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
// PROFILER SIDEBAR — the control panel (controls moved out of the frame)
// =============================================================================
//
// Renders the ProfilerControlsState the frame publishes and sends
// ProfilerActions back over the channel (see profilerBridge.ts): target
// picker, session name, Start/Stop + View Report, and the status line. The
// visualisation knobs (thread/style/depth/cutoff) stay in the frame's own
// toolbar — only the SESSION controls moved here.
//
// The session name is panel-LOCAL and travels with the `start` action, so
// typing never round-trips through the frame (no echo fighting the caret).
//
// Two mounts, one panel: the app's AppLayout sidebar (behind the shell's
// collapse gate — this free-form content has no icon-rail form) and the
// host's sidebar as a devToolSidebar (peer-backed channel, no gate).

import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { SidebarCollapsedGate } from 'shell';
import type { DevToolProps } from 'shell';
import { localSidebarChannel, createPeerSidebarChannel } from './profilerBridge';
import type { ProfilerControlsState, ProfilerSidebarChannel } from './profilerBridge';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	/** Panel column — stacked controls with sidebar padding. */
	panel: {
		display: 'flex',
		flexDirection: 'column',
		gap: 10,
		padding: '8px 12px',
		overflowY: 'auto',
	} as CSSProperties,

	/** Uppercase group heading (the sidebar section-header treatment). */
	groupLabel: {
		fontSize: 11,
		fontWeight: 600,
		textTransform: 'uppercase',
		letterSpacing: '0.5px',
		color: 'var(--rr-text-secondary)',
		marginTop: 4,
	} as CSSProperties,

	/** Field label above a control. */
	fieldLabel: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	/** Labelled field — label stacked over its control. */
	field: {
		display: 'flex',
		flexDirection: 'column',
		gap: 3,
	} as CSSProperties,

	/** Full-width dropdown. */
	select: {
		width: '100%',
		padding: '5px 8px',
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
		borderRadius: 4,
		fontSize: 12,
		fontFamily: 'var(--rr-font-family)',
		boxSizing: 'border-box',
	} as CSSProperties,

	/** Full-width text input. */
	input: {
		width: '100%',
		padding: '5px 8px',
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
		borderRadius: 4,
		fontSize: 12,
		fontFamily: 'var(--rr-font-family)',
		boxSizing: 'border-box',
	} as CSSProperties,

	/** Full-width button base. */
	button: {
		width: '100%',
		padding: '6px 12px',
		border: 'none',
		borderRadius: 4,
		fontSize: 12.5,
		cursor: 'pointer',
		fontWeight: 500,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,

	/** Start button colour. */
	startButton: {
		background: 'var(--rr-brand)',
		color: '#fff',
	} as CSSProperties,

	/** Stop button colour. */
	stopButton: {
		background: 'var(--rr-error, #f44747)',
		color: '#fff',
	} as CSSProperties,

	/** Quiet secondary button (View Report, Reset Root). */
	quietButton: {
		background: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
		border: '1px solid var(--rr-border)',
	} as CSSProperties,

	/** Status line box. */
	statusBar: (active: boolean): CSSProperties => ({
		padding: '6px 10px',
		borderRadius: 4,
		fontSize: 12,
		border: '1px solid var(--rr-border)',
		...(active
			? { background: 'rgba(40, 167, 69, 0.15)', borderColor: 'rgba(40, 167, 69, 0.4)' }
			: { background: 'rgba(108, 117, 125, 0.1)', borderColor: 'rgba(108, 117, 125, 0.3)' }),
	}),

	/** Error text. */
	error: {
		color: 'var(--rr-error, #f44747)',
		fontSize: 12,
	} as CSSProperties,

	/** Muted placeholder while the frame has not published yet. */
	placeholder: {
		padding: 16,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link ProfilerSidebar}. */
export interface IProfilerSidebarProps {
	/** The controls channel (in-document emitter or peer-backed). */
	channel?: ProfilerSidebarChannel;
	/** Wrap in the shell's collapse gate (in-app only). */
	gated?: boolean;
}

/**
 * The profiler controls panel: renders the frame's published state, sends
 * control actions back over the channel.
 *
 * @param props - {@link IProfilerSidebarProps}.
 */
const ProfilerSidebar: React.FC<IProfilerSidebarProps> = ({ channel = localSidebarChannel, gated = true }) => {
	const [state, setState] = useState<ProfilerControlsState | null>(null);
	// Panel-local: travels with the start action (never echoed back).
	const [sessionName, setSessionName] = useState('');

	useEffect(() => channel.subscribeState(setState), [channel]);

	let content: React.ReactNode;
	if (!state || !state.connected) {
		content = <div style={styles.placeholder}>{!state ? 'Waiting for the profiler...' : 'Waiting for the server connection...'}</div>;
	} else {
		const { active } = state;
		content = (
			<div style={styles.panel}>
				<div style={styles.groupLabel}>Session</div>

				{/* Target picker — the server process or a running task. */}
				<div style={styles.field}>
					<span style={styles.fieldLabel}>Target</span>
					<select
						style={styles.select}
						value={state.target}
						onChange={(e) => channel.sendAction({ op: 'setTarget', target: e.target.value })}
						disabled={active}
					>
						<option value="">Server Process</option>
						{state.targets.map((t) => (
							<option key={t.token} value={t.token}>{t.label}</option>
						))}
					</select>
				</div>

				{/* Session name (optional, sent with Start). */}
				<div style={styles.field}>
					<span style={styles.fieldLabel}>Session name</span>
					<input
						type="text"
						placeholder="Optional"
						value={sessionName}
						onChange={(e) => setSessionName(e.target.value)}
						style={styles.input}
						disabled={active}
					/>
				</div>

				{/* Start / Stop. */}
				{!active ? (
					<button style={{ ...styles.button, ...styles.startButton }} onClick={() => channel.sendAction({ op: 'start', session: sessionName })}>
						Start Profiling
					</button>
				) : (
					<button style={{ ...styles.button, ...styles.stopButton }} onClick={() => channel.sendAction({ op: 'stop' })}>
						Stop Profiling
					</button>
				)}

				{/* View Report — whenever not actively profiling. */}
				<button
					style={{ ...styles.button, ...styles.quietButton }}
					onClick={() => channel.sendAction({ op: 'viewReport' })}
					disabled={active}
				>
					View Report
				</button>

				{/* Status line. */}
				{state.statusLine && (
					<div style={styles.statusBar(active)}>
						<strong>Status:</strong> {state.statusLine}
					</div>
				)}

				{/* Last action error. */}
				{state.error && <div style={styles.error}>{state.error}</div>}
			</div>
		);
	}

	// In-app: behind the collapse gate (free-form content has no icon-rail
	// form). As a devToolSidebar there is no shell frame; the host panel owns
	// visibility.
	return gated ? <SidebarCollapsedGate>{content}</SidebarCollapsedGate> : content;
};

// =============================================================================
// DEV-TOOL SIDEBAR — the panel in the host's sidebar, actions over peer
// =============================================================================

/**
 * The controls panel as a host-mounted devToolSidebar: actions ride the peer
 * channel to the frame panel, and the frame's state arrives back the same
 * way (seeded by a `hello`, since the frame may already be running).
 */
export const ProfilerDevToolSidebar: React.FC<DevToolProps> = ({ peer }) => {
	const channel = useMemo(() => createPeerSidebarChannel(peer), [peer]);
	return <ProfilerSidebar channel={channel} gated={false} />;
};

export default ProfilerSidebar;
