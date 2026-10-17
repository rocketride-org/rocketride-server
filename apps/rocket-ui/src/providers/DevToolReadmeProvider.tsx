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
// DEV-TOOL README — the tool details page (`toolreadme:<appId>` document)
// =============================================================================
//
// The rocket-ui counterpart of the VS Code extension's DevToolReadmeProvider
// page: an extensions-style header (icon, name, publisher, version,
// description) with Install / Remove, and the tool's README markdown below.
// Everything reads straight from the server app manifest — no host protocol.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { MarkdownRenderer, useShellConnection } from 'shell';
import { useDevToolPins } from '../devtools/devToolPins';
import { getDocs } from '../docs';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	page: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		background: 'var(--rr-bg-default)',
		fontFamily: 'var(--rr-font-family)',
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	body: {
		maxWidth: 860,
		margin: '0 auto',
		padding: '28px 32px 48px',
	} as CSSProperties,
	header: {
		display: 'flex',
		gap: 20,
		alignItems: 'flex-start',
		paddingBottom: 20,
		borderBottom: '1px solid var(--rr-border)',
		marginBottom: 20,
	} as CSSProperties,
	icon: {
		width: 96,
		height: 96,
		flexShrink: 0,
		objectFit: 'contain',
	} as CSSProperties,
	title: {
		fontSize: 22,
		fontWeight: 600,
		margin: 0,
	} as CSSProperties,
	metaRow: {
		display: 'flex',
		gap: 10,
		alignItems: 'baseline',
		margin: '4px 0 8px',
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	description: {
		fontSize: 13,
		margin: '0 0 12px',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	installBtn: {
		padding: '4px 14px',
		fontSize: 12.5,
		border: 'none',
		borderRadius: 3,
		background: 'var(--rr-bg-button)',
		color: 'var(--rr-fg-button)',
		cursor: 'pointer',
	} as CSSProperties,
	removeBtn: {
		padding: '4px 14px',
		fontSize: 12.5,
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		background: 'transparent',
		color: 'var(--rr-text-primary)',
		cursor: 'pointer',
	} as CSSProperties,
	missing: {
		padding: 40,
		textAlign: 'center',
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The dev-tool details page for one catalog entry.
 *
 * @param props.appId - The tool's app id (from the `toolreadme:` URI).
 */
const DevToolReadmeProvider: React.FC<{ appId: string }> = ({ appId }) => {
	const { isConnected } = useShellConnection();
	const { catalog, pins, pin, unpin } = useDevToolPins();

	const tool = catalog.find((a) => a.id === appId);
	const installed = pins.includes(appId);

	if (!tool) {
		return <div style={styles.page}><div style={styles.missing}>This dev tool is not published on the connected server.</div></div>;
	}

	/** Unpin and close the tool's open frame — a removed tool keeps no
	    surface, per-document tabs (`tool:<appId>/<docKey>`) included. */
	const handleRemove = (): void => {
		unpin(appId);
		const docs = getDocs();
		if (!docs) return;
		for (const uri of Object.keys(docs.getState().documents)) {
			if (uri === `tool:${appId}` || uri.startsWith(`tool:${appId}/`)) docs.discardDocument(uri);
		}
	};

	return (
		<div style={styles.page}>
			<div style={styles.body}>
				<div style={styles.header}>
					{tool.icon && <img src={tool.icon} alt="" style={styles.icon} />}
					<div>
						<h1 style={styles.title}>{tool.name}</h1>
						<div style={styles.metaRow}>
							{tool.publisher && <span>{tool.publisher}</span>}
							{tool.version && <span>v{tool.version}</span>}
						</div>
						{tool.description && <p style={styles.description}>{tool.description}</p>}
						{installed ? (
							<button type="button" style={styles.removeBtn} disabled={!isConnected} onClick={handleRemove}>Remove from tools</button>
						) : (
							<button type="button" style={styles.installBtn} disabled={!isConnected} onClick={() => pin(appId)}>Install</button>
						)}
					</div>
				</div>
				{tool.readme ? (
					<MarkdownRenderer content={tool.readme} />
				) : (
					<p style={{ color: 'var(--rr-text-secondary)', fontSize: 13 }}>This tool ships no README.</p>
				)}
			</div>
		</div>
	);
};

export default DevToolReadmeProvider;
