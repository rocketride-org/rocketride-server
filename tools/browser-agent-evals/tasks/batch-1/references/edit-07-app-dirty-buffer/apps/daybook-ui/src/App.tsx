// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Daybook — a simple journal: write an entry, see today's and earlier entries.
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
	form: { display: 'flex', gap: 8, marginTop: 16 },
	input: { flex: 1, padding: '6px 8px', border: '1px solid var(--rr-border)', borderRadius: 6 },
	button: { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--rr-border)', background: 'var(--rr-bg-paper)', cursor: 'pointer' },
	list: { marginTop: 20, listStyle: 'none', padding: 0 },
	item: { padding: '8px 0', borderBottom: '1px solid var(--rr-border)', color: 'var(--rr-text-primary)' },
	when: { fontSize: 11, color: 'var(--rr-text-secondary)' },
};

// =============================================================================
// TYPES
// =============================================================================

/** One journal entry. */
interface Entry {
	id: number;
	text: string;
	when: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Client-area content: the entry form and the list, newest first. */
const Content: React.FC<ShellAppProps> = () => {
	const [entries, setEntries] = useState<Entry[]>([]);
	const [draft, setDraft] = useState('');

	const add = () => {
		const text = draft.trim();
		if (!text) return;
		setEntries((prev) => [{ id: Date.now(), text, when: new Date().toLocaleString() }, ...prev]);
		setDraft('');
	};

	return (
		<div style={styles.wrap}>
			<h1 style={styles.title}>My Daybook</h1>
			<div style={styles.form}>
				<input style={styles.input} value={draft} placeholder="Write about your day" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
				<button style={styles.button} onClick={add}>
					Add entry
				</button>
				<button style={styles.button} onClick={() => setEntries([])} disabled={entries.length === 0}>
					Clear all
				</button>
			</div>
			<ul style={styles.list}>
				{entries.map((entry) => (
					<li key={entry.id} style={styles.item}>
						<div style={styles.when}>{entry.when}</div>
						<div>{entry.text}</div>
					</li>
				))}
			</ul>
		</div>
	);
};

/** Root view: the template's frame around the journal. */
const App: React.FC<ShellAppProps> = (props) => (
	<AppLayout showStatus>
		<Content {...props} />
	</AppLayout>
);

export default App;
