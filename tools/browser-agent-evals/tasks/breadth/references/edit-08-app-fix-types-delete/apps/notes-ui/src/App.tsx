// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Notes — jot down short notes.
 */

import React, { useState } from 'react';
import type { ShellAppProps } from 'shell';
import { AppLayout } from 'shell';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: { padding: 40, fontFamily: 'var(--rr-font-family, system-ui)' },
	title: { fontSize: 22, fontWeight: 600, color: 'var(--rr-text-primary)' },
	count: { marginTop: 8, fontSize: 13, color: 'var(--rr-text-secondary)' },
	item: { padding: '6px 0', borderBottom: '1px solid var(--rr-border)' },
};

/** Formats a note's time for the list. */
function formatTime(when: Date): string {
	return when.toLocaleTimeString();
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Client-area content: the note box and the list. */
const Content: React.FC<ShellAppProps> = () => {
	const [notes, setNotes] = useState<Array<{ text: string; when: Date }>>([]);
	const [draft, setDraft] = useState('');
	const total: number = notes.length;

	return (
		<div style={styles.wrap}>
			<h1 style={styles.title}>Notes</h1>
			<input value={draft} onChange={(e) => setDraft(e.target.value)} />
			<button
				onClick={() => {
					if (draft.trim()) setNotes((prev) => [...prev, { text: draft.trim(), when: new Date() }]);
					setDraft('');
				}}
			>
				Add
			</button>
			<div style={styles.count}>{total} notes</div>
			{notes.map((note, i) => (
				<div key={i} style={styles.item}>
					{note.text} <small>{formatTime(note.when)}</small>
				</div>
			))}
		</div>
	);
};

/** Root view. */
const App: React.FC<ShellAppProps> = (props) => (
	<AppLayout showStatus>
		<Content {...props} />
	</AppLayout>
);

export default App;
