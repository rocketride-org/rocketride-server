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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * DevToolReadmeWebview — the dev-tool details page (VS Code extension-page
 * style): identity header (icon, name, publisher · version · category),
 * Install / Remove actions, and the app's README markdown below.
 */

import React, { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { MarkdownRenderer } from 'shell';
import { useMessaging } from '../hooks/useMessaging';
import type { ReadmeHostToWebview, ReadmeToolInfo, ReadmeWebviewToHost } from '../../types/devToolReadmeTypes';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	page: {
		position: 'fixed' as const,
		inset: 0,
		overflowY: 'auto' as const,
		backgroundColor: 'var(--rr-bg-default)',
		fontFamily: 'var(--rr-font-family)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	inner: {
		maxWidth: 860,
		margin: '0 auto',
		padding: '36px 40px 80px',
	} as CSSProperties,

	header: {
		display: 'flex',
		gap: 24,
		alignItems: 'flex-start',
		paddingBottom: 24,
		borderBottom: '1px solid var(--rr-border)',
		marginBottom: 24,
	} as CSSProperties,

	iconChip: {
		width: 96,
		height: 96,
		flexShrink: 0,
		borderRadius: 16,
		backgroundColor: 'var(--rr-bg-surface-alt)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		overflow: 'hidden',
	} as CSSProperties,

	iconImg: {
		width: 64,
		height: 64,
		objectFit: 'contain' as const,
	} as CSSProperties,

	name: {
		margin: '0 0 4px',
		fontSize: 26,
		fontWeight: 800,
		letterSpacing: -0.4,
	} as CSSProperties,

	metaLine: {
		margin: '0 0 10px',
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	description: {
		margin: '0 0 14px',
		fontSize: 14,
		lineHeight: 1.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	installBtn: {
		padding: '6px 18px',
		borderRadius: 6,
		border: 'none',
		backgroundColor: 'var(--rr-brand)',
		color: '#fff',
		fontSize: 13,
		fontWeight: 600,
		cursor: 'pointer',
	} as CSSProperties,

	removeBtn: {
		padding: '6px 18px',
		borderRadius: 6,
		border: '1px solid var(--rr-border)',
		backgroundColor: 'transparent',
		color: 'var(--rr-color-error, #ef4444)',
		fontSize: 13,
		fontWeight: 600,
		cursor: 'pointer',
	} as CSSProperties,

	installedTag: {
		marginLeft: 10,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	status: {
		position: 'absolute' as const,
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

const DevToolReadmeWebview: React.FC = () => {
	const [tool, setTool] = useState<ReadmeToolInfo | null>(null);
	const [installed, setInstalled] = useState(false);
	const [connected, setConnected] = useState(false);
	const [seeded, setSeeded] = useState(false);

	const onMessage = useCallback((message: ReadmeHostToWebview) => {
		if (message.type === 'readme:init') {
			setTool(message.payload.tool);
			setInstalled(message.payload.installed);
			setConnected(message.payload.connected);
			setSeeded(true);
		}
	}, []);

	const { sendMessage } = useMessaging<ReadmeWebviewToHost, ReadmeHostToWebview>({ onMessage });

	if (!seeded || !tool) {
		return (
			<div style={styles.page}>
				<div style={styles.status}>
					{!seeded ? 'Loading…' : connected ? 'This tool is no longer available on the server.' : 'Connect to a RocketRide server to view this tool.'}
				</div>
			</div>
		);
	}

	const metaBits = [tool.publisher, tool.version ? `v${tool.version}` : undefined, tool.categories?.[0]].filter(Boolean);

	return (
		<div style={styles.page}>
			<div style={styles.inner}>
				{/* ── Identity header — extension-page style ────────────── */}
				<div style={styles.header}>
					<div style={styles.iconChip}>
						{tool.iconDataUri ? <img src={tool.iconDataUri} alt="" style={styles.iconImg} /> : <span style={{ fontSize: 34, fontWeight: 800, color: 'var(--rr-brand)' }}>{tool.name[0]}</span>}
					</div>
					<div style={{ flex: 1, minWidth: 0 }}>
						<h1 style={styles.name}>{tool.name}</h1>
						{metaBits.length > 0 && <p style={styles.metaLine}>{metaBits.join(' · ')}</p>}
						{tool.description && <p style={styles.description}>{tool.description}</p>}
						<div style={{ display: 'flex', alignItems: 'center' }}>
							{installed ? (
								<>
									<button type="button" style={styles.removeBtn} disabled={!connected} onClick={() => sendMessage({ type: 'readme:remove', appId: tool.id })}>
										Remove
									</button>
									<span style={styles.installedTag}>Installed — on your Dev Tools strip</span>
								</>
							) : (
								<button type="button" style={styles.installBtn} disabled={!connected} onClick={() => sendMessage({ type: 'readme:install', appId: tool.id })}>
									Install
								</button>
							)}
						</div>
					</div>
				</div>

				{/* ── README ─────────────────────────────────────────────── */}
				{tool.readme ? (
					<MarkdownRenderer content={tool.readme} />
				) : (
					<p style={{ color: 'var(--rr-text-secondary)', fontSize: 13 }}>This tool ships no README.</p>
				)}
			</div>
		</div>
	);
};

export default DevToolReadmeWebview;
