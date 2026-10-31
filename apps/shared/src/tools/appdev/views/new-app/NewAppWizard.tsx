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
// NEW APP WIZARD — the App Builder's UNBOUND (empty) state
// =============================================================================
//
// The wizard is not a page: it is what an App Builder document shows while
// no app is bound — the same pattern as the pipeline editor's empty-canvas
// wizard. This component owns the whole wizard lifecycle (identity load and
// live refresh, in-flight lock, failure display) over a small host seam, so
// each host contributes only transport: where identity comes from, what a
// scaffold does, and how an untitled document retires.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { NewAppForm } from './NewAppForm';
import type { NewAppIdentity } from '../../types';
import type { FrameOptions } from '../../templates';

// =============================================================================
// TYPES
// =============================================================================

/** The host seam behind the wizard — transport only, no wizard state. */
export interface INewAppWizardHost {
	/** The live identity snapshot (developer id, collision folders). */
	identity(): Promise<NewAppIdentity>;
	/** Identity change feed (login/logout while the modeless wizard sits
	 *  open); returns unsubscribe. Hosts without a feed omit it. */
	onIdentityChanged?(cb: (identity: NewAppIdentity) => void): () => void;
	/**
	 * Scaffolds the app in ONE pass. Resolution means the host has created
	 * the app AND performed the document transition (bound the builder /
	 * retired the untitled document) — the wizard stays locked through it.
	 * Rejection re-enables the form with the validation message.
	 */
	scaffold(appName: string, displayName: string, frame: FrameOptions): Promise<void>;
	/** Close the untitled document without creating anything. */
	cancel(): void;
	/** Scaffold location prefix for the identity summary (e.g. 'apps/'). */
	locationPrefix?: string;
	/** Footer note when identity.workspaceOpen is false. */
	noWorkspaceNote?: string;
}

/** Props for {@link NewAppWizard}. */
export interface INewAppWizardProps {
	host: INewAppWizardHost;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	root: {
		flex: 1,
		minHeight: 0,
		minWidth: 0,
		display: 'flex',
		flexDirection: 'column',
	},
	loading: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		fontFamily: 'var(--rr-font-family)',
	},
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * The unbound App Builder body: NewAppForm over the host seam.
 *
 * @param props - See {@link INewAppWizardProps}.
 */
export const NewAppWizard: React.FC<INewAppWizardProps> = ({ host }) => {
	/** Live identity; null until the first pull answers. */
	const [identity, setIdentity] = useState<NewAppIdentity | null>(null);
	/** True while a scaffold is in flight (locks the form). */
	const [creating, setCreating] = useState(false);
	/** Error from a failed create, shown in the form footer. */
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void host.identity().then(
			(i) => { if (!cancelled) setIdentity(i); },
			() => { /* host unreachable — the form stays in its loading state */ },
		);
		const off = host.onIdentityChanged?.((i) => setIdentity(i));
		return () => {
			cancelled = true;
			off?.();
		};
	}, [host]);

	/** One scaffold pass; success retires this document (the host did the
	 *  transition — stay locked), a rejection re-enables the form. */
	const handleCreate = useCallback(
		(appName: string, displayName: string, frame: FrameOptions) => {
			setError(null);
			setCreating(true);
			host.scaffold(appName, displayName, frame).catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
				setCreating(false);
			});
		},
		[host],
	);

	if (!identity) return <div style={styles.root}><div style={styles.loading}>Loading&hellip;</div></div>;

	return (
		<div style={styles.root}>
			<NewAppForm
				identity={identity}
				creating={creating}
				error={error}
				{...(host.locationPrefix !== undefined ? { locationPrefix: host.locationPrefix } : {})}
				{...(host.noWorkspaceNote !== undefined ? { noWorkspaceNote: host.noWorkspaceNote } : {})}
				onCreate={handleCreate}
				onCancel={() => host.cancel()}
			/>
		</div>
	);
};
