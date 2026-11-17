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

/**
 * Developer-id onboarding for the pipelines tool (plan §2.1, Step 5).
 *
 * Every pipeline address is `<developerId>.<pipeId>.<source>`, and the server
 * refuses to run, deploy or publish anything for an organization that has not
 * claimed its developer id. This banner sits above the editor's page strip
 * while the org has none: an org admin claims the id right here (the same
 * verb the App Builder's Deploy page uses); a member sees the pending state
 * and who to ask. It renders nothing when the id is set, or when the host
 * cannot tell (an unknown id must never read as "none").
 */

import React, { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { Banner, Button, commonStyles } from 'shell';

// =============================================================================
// Styles
// =============================================================================

const styles: Record<string, CSSProperties> = {
	wrap: {
		padding: '8px 12px 0',
	},
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginTop: 8,
	},
	input: {
		...commonStyles.inputField,
		maxWidth: 280,
	},
	error: {
		marginTop: 6,
		color: 'var(--rr-text-error, #c33)',
		fontSize: 12,
	},
};

// =============================================================================
// Props
// =============================================================================

/** Props for {@link DeveloperIdBanner}. */
export interface IDeveloperIdBannerProps {
	/**
	 * The org's developer id: '' when the org has none (the banner shows),
	 * a value when it is set, undefined when the host cannot tell (nothing
	 * renders either way but '').
	 */
	developerId: string | undefined;
	/** Claims the id for the org (org admins; the server refuses others). Absent = this host cannot claim. */
	onRegister?: (developerId: string) => Promise<string>;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the developer-id onboarding banner while the org has no id.
 *
 * @param props - See {@link IDeveloperIdBannerProps}.
 * @returns The banner, or null when nothing needs claiming.
 */
export const DeveloperIdBanner: React.FC<IDeveloperIdBannerProps> = ({ developerId, onRegister }) => {
	const [slug, setSlug] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	// The id this banner claimed: the host's own view may lag the server's
	// account push, so the banner closes itself the moment the claim lands.
	const [claimed, setClaimed] = useState<string | null>(null);

	const register = useCallback(async (): Promise<void> => {
		if (!onRegister || !slug.trim()) return;
		setBusy(true);
		setError('');
		try {
			setClaimed(await onRegister(slug.trim()));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [onRegister, slug]);

	if (developerId !== '' || claimed) return null;

	return (
		<div style={styles.wrap}>
			<Banner variant="warning">
				<strong>Your organization has no developer id yet.</strong> Every pipeline address is <code>&lt;developerId&gt;.&lt;pipeId&gt;.&lt;source&gt;</code>, so nothing runs, deploys or publishes until an org admin claims one (letters, digits, _ or -; it names every app and pipeline the organization publishes, and cannot be changed casually).
				{onRegister ? (
					<>
						<div style={styles.row}>
							<input style={styles.input} placeholder="developer id (e.g. acme_labs)" value={slug} onChange={(e) => setSlug(e.target.value)} disabled={busy} />
							<Button small variant="primary" disabled={busy || !slug.trim()} onClick={() => void register()}>
								{busy ? 'Claiming…' : 'Claim developer id'}
							</Button>
						</div>
						{error ? <div style={styles.error}>{error} If you are not an org admin, ask one to claim it.</div> : null}
					</>
				) : (
					<div style={styles.row}>Ask your organization's admin to claim it (Settings › Account, or the App Builder's Deploy page).</div>
				)}
			</Banner>
		</div>
	);
};

export default DeveloperIdBanner;
