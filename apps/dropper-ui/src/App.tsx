// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Dropper — the shell app (browser mode, plan 3.6).
 *
 * The shell has already signed the person in (or consumed a one-shot `auth=`
 * hand-off) before this mounts; the account on the connection is the caller
 * and pays. With `pipe=<address>` in the URL the app binds to that pipe. With
 * no `pipe=` there is nothing to drop into yet: the landing view says so and
 * takes an address by hand. The publication picker (own-org `@me`/`@team`
 * rows, store search) lands with the merged publication table (plan C.16c).
 */

import React, { useCallback, useState } from 'react';
import type { ShellAppProps } from 'shell';
import { AppLayout, Button, EmptyState, InputField } from 'shell';
import { DropperDocument } from './DropperDocument';
import { looksLikeAddress, pipeFromLocation, writePipeToLocation } from './pipeParam';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	landing: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		height: '100%',
		padding: 40,
		fontFamily: 'var(--rr-font-family, system-ui)',
	},
	form: {
		display: 'flex',
		gap: 8,
		alignItems: 'center',
		marginTop: 12,
	},
	input: {
		minWidth: 280,
		fontFamily: 'var(--rr-font-mono, monospace)',
	},
	error: {
		marginTop: 8,
		fontSize: 12,
		color: 'var(--rr-error, #d33)',
	},
};

// =============================================================================
// LANDING — no pipe named yet
// =============================================================================

/** Props for {@link Landing}. */
interface ILandingProps {
	/** Called with a syntactically valid address the person typed. */
	onOpen: (address: string) => void;
}

/**
 * The no-`pipe=` view: how to get here with a pipe, and an address field.
 *
 * @param props - {@link ILandingProps}.
 */
const Landing: React.FC<ILandingProps> = ({ onOpen }) => {
	const [draft, setDraft] = useState('');
	const [error, setError] = useState('');

	const submit = useCallback(() => {
		const value = draft.trim();
		if (!looksLikeAddress(value)) {
			setError('An address is developerId.pipelineId or developerId.pipelineId.source');
			return;
		}
		setError('');
		onOpen(value);
	}, [draft, onOpen]);

	return (
		<div style={styles.landing}>
			<EmptyState
				title="Nothing to drop into yet"
				description="Open this app from a pipeline's Open Dropper button in the Builder, or from a link that names a pipe (?appid=rocketride.dropper&pipe=<address>). You can also enter an address."
				action={
					<div>
						<div style={styles.form}>
							<InputField
								style={styles.input}
								value={draft}
								placeholder="acme.docBrain.drop"
								spellCheck={false}
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') submit();
								}}
							/>
							<Button variant="primary" onClick={submit} disabled={draft.trim().length === 0}>
								Open
							</Button>
						</div>
						{error && <div style={styles.error}>{error}</div>}
					</div>
				}
			/>
		</div>
	);
};

// =============================================================================
// APP
// =============================================================================

/**
 * Root view: one AppLayout, the bound drop zone or the landing view.
 *
 * @param props - The shell's app props (connection state, identity).
 */
const App: React.FC<ShellAppProps> = () => {
	const [address, setAddress] = useState<string | null>(() => pipeFromLocation());

	const handleOpen = useCallback((value: string) => {
		writePipeToLocation(value);
		setAddress(value);
	}, []);

	return <AppLayout showStatus>{address ? <DropperDocument address={address} /> : <Landing onOpen={handleOpen} />}</AppLayout>;
};

export default App;
