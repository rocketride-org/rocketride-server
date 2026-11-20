// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Chat — the shell app (browser mode, plan 3.6).
 *
 * The shell has already signed the person in (or consumed a one-shot `auth=`
 * hand-off) before this mounts; the account on the connection is the caller
 * and pays. With `pipe=<address>` in the URL the app binds to that pipe. With
 * no `pipe=` the landing view is the shared pipe picker: the caller's own-org
 * publications and a store search, then the picked pipe's chat sources; the
 * choice is written back as `pipe=` so the page is shareable.
 */

import React, { useCallback, useState } from 'react';
import type { ShellAppProps } from 'shell';
import { AppLayout } from 'shell';
import { PipePicker, pipeLinkFromLocation } from 'shared/components/pipe-picker';
import type { IPipeChoice } from 'shared/components/pipe-picker';
import { ChatDocument } from './ChatDocument';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	landing: {
		height: '100%',
		overflowY: 'auto',
		padding: 32,
		boxSizing: 'border-box',
	},
};

// =============================================================================
// APP
// =============================================================================

/**
 * Root view: one AppLayout, the bound conversation or the picker.
 *
 * @param props - The shell's app props (connection state, identity).
 */
const App: React.FC<ShellAppProps> = () => {
	const [address, setAddress] = useState<string | null>(() => pipeLinkFromLocation()?.pipe ?? null);

	// The picker has already written pipe= into the URL
	const handleChoose = useCallback((choice: IPipeChoice) => setAddress(choice.address), []);

	return (
		<AppLayout showStatus>
			{address ? (
				<ChatDocument address={address} />
			) : (
				<div style={styles.landing}>
					<PipePicker interfaceType="chat" interfaceLabel="chat" title="Choose a pipeline to chat with" subtitle="Pipelines published to you and your teams, or search the store. Each one's Open Chat button in the Builder opens it here too." onChoose={handleChoose} />
				</div>
			)}
		</AppLayout>
	);
};

export default App;
