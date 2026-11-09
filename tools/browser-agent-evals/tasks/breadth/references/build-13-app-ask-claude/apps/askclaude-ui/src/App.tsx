// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Ask Claude — type a question, get Claude's answer from the app's own pipeline.
 */

import React, { useState } from 'react';
import type { ShellAppProps } from 'shell';
import { AppLayout, useShellConnection } from 'shell';
import { Question } from 'rocketride';

import askPipeline from './ask.pipe';
import type { PipelineConfig } from 'rocketride';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: { padding: 40, fontFamily: 'var(--rr-font-family, system-ui)' },
	title: { fontSize: 22, fontWeight: 600, color: 'var(--rr-text-primary)' },
	form: { display: 'flex', gap: 8, marginTop: 16 },
	input: { flex: 1, padding: '6px 8px', border: '1px solid var(--rr-border)', borderRadius: 6 },
	button: { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--rr-border)', background: 'var(--rr-bg-paper)', cursor: 'pointer' },
	answer: { marginTop: 20, whiteSpace: 'pre-wrap', color: 'var(--rr-text-primary)' },
	error: { marginTop: 20, color: 'var(--rr-error, #c00)' },
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Client-area content: the question box and the answer. */
const Content: React.FC<ShellAppProps> = ({ isConnected }) => {
	const { client } = useShellConnection();
	const [token, setToken] = useState<string | null>(null);
	const [draft, setDraft] = useState('');
	const [answer, setAnswer] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);

	const ask = async () => {
		const text = draft.trim();
		if (!text || !client) return;
		setBusy(true);
		setError('');
		try {
			// Start the pipeline once and keep its token for later questions.
			let current = token;
			if (!current) {
				// The scaffold types a .pipe import as Record<string, unknown>; use() takes a PipelineConfig.
				const started = await client.use({ pipeline: askPipeline as unknown as PipelineConfig, useExisting: true });
				current = started.token;
				setToken(current);
			}
			const question = new Question();
			question.addQuestion(text);
			const response = await client.chat({ token: current, question });
			setAnswer(String(response.answers?.[0] ?? 'No answer received.'));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div style={styles.wrap}>
			<h1 style={styles.title}>Ask Claude</h1>
			<div style={styles.form}>
				<input style={styles.input} value={draft} placeholder="Ask a question" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void ask()} />
				<button style={styles.button} onClick={() => void ask()} disabled={busy || !isConnected}>
					{busy ? 'Asking…' : 'Ask'}
				</button>
			</div>
			{error ? <div style={styles.error}>{error}</div> : <div style={styles.answer}>{answer}</div>}
		</div>
	);
};

/** Root view: the template's frame around the question box. */
const App: React.FC<ShellAppProps> = (props) => (
	<AppLayout showStatus>
		<Content {...props} />
	</AppLayout>
);

export default App;
