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

// =============================================================================
// TOOL DETAILS VIEW — the extensions-style tool page, shared by both hosts
// =============================================================================
//
// The one details page for a dev-tool catalog entry: icon, name, publisher ·
// version meta line, description, Install / Remove, README markdown below.
// It was a ~150-line near-copy per host (down to the fallback string); the
// hosts now supply only DATA and the two actions — the page is this file.
//
// The catalog row carries the README as a URL (`/apps/<id>/v<N>/README.md`),
// not as text: this view fetches it with the entitlement cookie the shell
// primes and renders the body, with the README's directory as the base for
// its relative images and links.
// =============================================================================

import React, { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { MarkdownRenderer } from 'shell';

// =============================================================================
// TYPES
// =============================================================================

/** The catalog facts the page renders — host-resolved (icons loadable). */
export interface ToolDetails {
	/** The tool's app id. */
	id: string;
	/** Display name. */
	name: string;
	/** Publisher line (omitted when unknown). */
	publisher?: string;
	/** Resolved version (rendered as `v<version>`). */
	version?: string;
	/** Short description under the meta line. */
	description?: string;
	/** Icon the view can load directly (data: URI or served URL). */
	iconUrl?: string;
	/**
	 * The README's URL (the catalog row's `readme`: `/apps/<id>/v<N>/<path>`,
	 * root-relative on the server origin or absolute); absent renders the
	 * stock no-README line. The view fetches it — never README text.
	 */
	readme?: string;
}

/** The README fetch, as the page shows it. */
type ReadmeState = { kind: 'loading' } | { kind: 'ready'; markdown: string } | { kind: 'none' } | { kind: 'error'; message: string };

/** Props for {@link ToolDetailsView}. */
export interface ToolDetailsViewProps {
	/** The tool to render. */
	tool: ToolDetails;
	/** Whether the tool is on the user's strip (switches the action). */
	installed: boolean;
	/** Whether the host holds a server connection (gates both actions). */
	connected: boolean;
	/** Pins the tool. */
	onInstall: () => void;
	/** Unpins the tool (the host also closes its open surfaces). */
	onRemove: () => void;
}

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
	iconFallback: {
		width: 96,
		height: 96,
		flexShrink: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 34,
		fontWeight: 800,
		color: 'var(--rr-brand)',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
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
	noReadme: {
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
	} as CSSProperties,
	readmeError: {
		color: 'var(--rr-color-error)',
		fontSize: 13,
	} as CSSProperties,
};

// =============================================================================
// README FETCH
// =============================================================================

/** The directory of a README URL — the base its relative references resolve against. */
function readmeBaseOf(url: string): string {
	const slash = url.lastIndexOf('/');
	return slash < 0 ? url : url.slice(0, slash + 1);
}

/**
 * Fetches the README behind a catalog URL. The entitlement cookie rides the
 * request (`credentials: 'include'`: the shell primes it on the server
 * origin, which may differ from the page's in VS Code). A 404 or an empty
 * body is the no-README state; any other failure is an error state.
 *
 * @param url - The README URL, or undefined when the row declares none.
 * @returns The README state, loading first.
 */
function useReadme(url: string | undefined): ReadmeState {
	const [state, setState] = useState<ReadmeState>(() => (url ? { kind: 'loading' } : { kind: 'none' }));

	useEffect(() => {
		if (!url) {
			setState({ kind: 'none' });
			return;
		}
		let cancelled = false;
		setState({ kind: 'loading' });
		// Step 1: fetch with the entitlement cookie; 404 = no README
		fetch(url, { credentials: 'include' })
			.then(async (response) => {
				if (response.status === 404) return { kind: 'none' } as ReadmeState;
				if (!response.ok) return { kind: 'error', message: `The README could not be loaded (HTTP ${response.status}).` } as ReadmeState;
				const markdown = await response.text();
				// Step 2: an empty body reads as no README, not as a blank sheet
				return (markdown.trim() ? { kind: 'ready', markdown } : { kind: 'none' }) as ReadmeState;
			})
			.catch((err: unknown) => ({ kind: 'error', message: `The README could not be loaded: ${err instanceof Error ? err.message : String(err)}` }) as ReadmeState)
			.then((next) => {
				if (!cancelled) setState(next);
			});
		return () => {
			cancelled = true;
		};
	}, [url]);

	return state;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The tool details page.
 *
 * @param props - {@link ToolDetailsViewProps}.
 */
export const ToolDetailsView: React.FC<ToolDetailsViewProps> = ({ tool, installed, connected, onInstall, onRemove }) => {
	const readme = useReadme(tool.readme);

	// Step 1: the README body by fetch state
	let body: React.ReactNode;
	switch (readme.kind) {
		case 'loading':
			body = <p style={styles.noReadme}>Loading README…</p>;
			break;
		case 'ready':
			body = <MarkdownRenderer content={readme.markdown} baseUrl={readmeBaseOf(tool.readme ?? '')} />;
			break;
		case 'error':
			body = <p style={styles.readmeError}>{readme.message}</p>;
			break;
		default:
			body = <p style={styles.noReadme}>This tool ships no README.</p>;
	}

	// Step 2: the page
	return (
	<div style={styles.page}>
		<div style={styles.body}>
			<div style={styles.header}>
				{tool.iconUrl
					? <img src={tool.iconUrl} alt="" style={styles.icon} />
					: <div style={styles.iconFallback}>{tool.name[0]}</div>}
				<div>
					<h1 style={styles.title}>{tool.name}</h1>
					<div style={styles.metaRow}>
						{tool.publisher && <span>{tool.publisher}</span>}
						{tool.version && <span>v{tool.version}</span>}
					</div>
					{tool.description && <p style={styles.description}>{tool.description}</p>}
					{installed ? (
						<button type="button" style={styles.removeBtn} disabled={!connected} onClick={onRemove}>Remove from tools</button>
					) : (
						<button type="button" style={styles.installBtn} disabled={!connected} onClick={onInstall}>Install</button>
					)}
				</div>
			</div>
			{body}
		</div>
	</div>
	);
};
