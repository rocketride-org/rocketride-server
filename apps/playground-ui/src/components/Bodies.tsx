// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The bubble bodies the Playground draws inside the shell's chat bubbles:
 *   - the caller's upload list, each file with its progress (BODY_UPLOAD);
 *   - the agent's answer: a progress line and the thinking messages while
 *     it runs, then "Thought for N s ▸" and the results, with Copy and
 *     Download (Advanced adds Raw) (BODY_ANSWER);
 *   - the agent's one-sentence refusal of files it does not take (BODY_REFUSAL).
 */

import React, { useEffect, useState, type CSSProperties } from 'react';
import { Button, formatBytes } from 'shell';
import type { ChatMessage, ChatMessageBodyRenderer } from 'shell';
import { JsonTree } from 'shared/components/json-tree/JsonTree';
import { elapsedWords } from '../core/friendly';
import { BODY_ANSWER, BODY_REFUSAL, BODY_UPLOAD } from '../core/model';
import type { AnswerBodyData, RefusalBodyData, UploadBodyData, UploadFile } from '../core/model';
import { plainTextOf } from '../core/results';
import { ResultView } from './results/ResultView';

// =============================================================================
// STYLES
// =============================================================================

// The spinner's keyframes, injected once at module load (the shell's
// TypingIndicator pattern; the shell has no spinner control).
const SPIN_ID = 'rr-playground-spin';
if (typeof document !== 'undefined' && !document.getElementById(SPIN_ID)) {
	const el = document.createElement('style');
	el.id = SPIN_ID;
	el.textContent = '@keyframes rr-playground-spin{to{transform:rotate(360deg)}}';
	document.head.appendChild(el);
}

/** Upload rows shown before the rest are counted as waiting. */
const UPLOAD_ROWS = 5;
/** Thinking rows shown while a request runs. */
const THINKING_ROWS = 3;
/** File rows shown while several files run. */
const FILE_ROWS = 6;

const styles = {
	uploads: {
		display: 'flex',
		flexDirection: 'column',
		gap: 6,
		minWidth: 280,
	} as CSSProperties,
	uploadRow: {
		display: 'grid',
		gridTemplateColumns: '30px 1fr auto 16px',
		gap: 8,
		alignItems: 'center',
		fontSize: 12,
	} as CSSProperties,
	typeBadge: {
		fontSize: 8,
		fontWeight: 700,
		border: '1px solid currentColor',
		borderRadius: 3,
		padding: '2px 0',
		textAlign: 'center',
		opacity: 0.85,
	} as CSSProperties,
	fileName: {
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	} as CSSProperties,
	struck: {
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		textDecoration: 'line-through',
		opacity: 0.7,
	} as CSSProperties,
	size: {
		fontSize: 11,
		opacity: 0.85,
		textAlign: 'right',
	} as CSSProperties,
	track: {
		gridColumn: '2 / 5',
		height: 3,
		borderRadius: 2,
		backgroundColor: 'currentColor',
		opacity: 0.3,
		position: 'relative',
	} as CSSProperties,
	fill: (fraction: number): CSSProperties => ({
		position: 'absolute',
		left: 0,
		top: 0,
		bottom: 0,
		width: `${Math.round(fraction * 100)}%`,
		borderRadius: 2,
		backgroundColor: 'currentColor',
	}),
	more: {
		fontSize: 11,
		opacity: 0.85,
	} as CSSProperties,
	progress: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	spinner: {
		width: 12,
		height: 12,
		borderRadius: '50%',
		border: '2px solid var(--rr-border)',
		borderTopColor: 'var(--rr-brand)',
		animation: 'rr-playground-spin 0.9s linear infinite',
		flexShrink: 0,
	} as CSSProperties,
	bar: {
		height: 4,
		borderRadius: 2,
		backgroundColor: 'var(--rr-border)',
		margin: '8px 0 4px',
		position: 'relative',
		overflow: 'hidden',
	} as CSSProperties,
	barFill: (fraction: number): CSSProperties => ({
		position: 'absolute',
		left: 0,
		top: 0,
		bottom: 0,
		width: `${Math.round(fraction * 100)}%`,
		backgroundColor: 'var(--rr-brand)',
	}),
	thinking: {
		marginTop: 6,
		paddingLeft: 10,
		borderLeft: '2px solid var(--rr-border)',
		fontSize: 12,
		color: 'var(--rr-text-caption)',
		fontStyle: 'italic',
		display: 'flex',
		flexDirection: 'column',
		gap: 2,
	} as CSSProperties,
	thinkingNow: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	fileRow: {
		display: 'grid',
		gridTemplateColumns: '16px minmax(0, 180px) 1fr',
		gap: 8,
		fontSize: 12,
		padding: '2px 0',
		alignItems: 'baseline',
	} as CSSProperties,
	fileRowText: {
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	mark: (color: string): CSSProperties => ({
		color,
		fontWeight: 700,
		textAlign: 'center',
	}),
	thought: {
		marginBottom: 6,
	} as CSSProperties,
	actions: {
		display: 'flex',
		gap: 4,
		marginTop: 8,
		marginLeft: -8,
	} as CSSProperties,
	sentence: {
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
	code: {
		marginTop: 4,
		fontSize: 11,
		color: 'var(--rr-text-caption)',
		fontFamily: 'var(--rr-font-family-mono, monospace)',
	} as CSSProperties,
	raw: {
		marginTop: 8,
		fontSize: 11.5,
	} as CSSProperties,
};

// =============================================================================
// UPLOADS
// =============================================================================

/**
 * A file's type as a short badge ("PDF").
 *
 * @param file - The file.
 * @returns The badge text.
 */
function typeBadge(file: UploadFile): string {
	const ext = file.name.includes('.') ? file.name.split('.').pop()! : (file.mime.split('/')[1] ?? '');
	return ext.slice(0, 4).toUpperCase();
}

/**
 * The caller's upload list.
 *
 * @param props - The bubble's data.
 * @returns The list.
 */
export const UploadBody: React.FC<{ data: UploadBodyData }> = ({ data }) => {
	const files = data.files ?? [];
	// step: every started or settled file, then the waiting ones counted
	const started = files.filter((f) => f.state !== 'waiting');
	const waiting = files.length - started.length;
	const rows = started.length > 0 ? started.slice(-UPLOAD_ROWS) : files.slice(0, UPLOAD_ROWS);
	const hidden = files.length - rows.length - (started.length > 0 ? waiting : 0);
	// step: the line under the rows counts the files they leave out; only files not yet started are called waiting
	const pending = started.length > 0 ? waiting : 0;
	const more = hidden > 0 && pending > 0 ? `and ${hidden + pending} more, ${pending} waiting` : pending > 0 ? `and ${pending} more waiting` : hidden > 0 ? `and ${hidden} more` : '';
	return (
		<div style={styles.uploads}>
			{rows.map((f, i) => (
				<div key={`${f.name}-${i}`} style={styles.uploadRow} title={f.reason}>
					<span style={styles.typeBadge}>{typeBadge(f)}</span>
					<span style={f.state === 'refused' || f.state === 'failed' ? styles.struck : styles.fileName}>{f.name}</span>
					<span style={styles.size}>{f.state === 'uploading' ? `${formatBytes(f.sent)} / ${formatBytes(f.size)}` : formatBytes(f.size)}</span>
					<span>{f.state === 'done' ? '✓' : f.state === 'failed' || f.state === 'refused' ? '✕' : ''}</span>
					{f.state === 'uploading' && (
						<span style={styles.track}>
							<span style={styles.fill(f.size > 0 ? f.sent / f.size : 0)} />
						</span>
					)}
				</div>
			))}
			{more && <div style={styles.more}>{more}</div>}
		</div>
	);
};

// =============================================================================
// ANSWERS
// =============================================================================

/**
 * The plain-words sentence for a failed request (Simple shows only this).
 *
 * @param data - The answer.
 * @param agentName - The agent's name.
 * @returns The sentence.
 */
function failureSentence(data: AnswerBodyData, agentName: string): string {
	if (data.code === 'SUBSCRIPTION_REQUIRED') return `${agentName} needs a subscription. Subscribe in the store, then send again.`;
	if (data.code === 'OUT_OF_CREDITS') return `Your organization is out of credits, so ${agentName} couldn't run. An organization admin can add credits.`;
	if (data.code === 'TASK_NOT_REGISTERED' || data.code === 'permission_denied') return "This agent isn't available to you. It may have been removed, or it isn't shared with you.";
	return `${agentName} couldn't answer: ${data.error ?? 'the request failed'}`;
}

/**
 * Copies text to the clipboard (best effort).
 *
 * @param text - The text.
 */
function copy(text: string): void {
	void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/**
 * Saves text as a file through a temporary link.
 *
 * @param name - The file name.
 * @param text - The content.
 */
function download(name: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Props for {@link AnswerBody}. */
export interface IAnswerBodyProps {
	data: AnswerBodyData;
	simple: boolean;
	agentName: string;
}

/**
 * The agent's answer bubble.
 *
 * @param props - {@link IAnswerBodyProps}.
 * @returns The body.
 */
export const AnswerBody: React.FC<IAnswerBodyProps> = ({ data, simple, agentName }) => {
	const [now, setNow] = useState(Date.now());
	const [showThinking, setShowThinking] = useState(false);
	const [showRaw, setShowRaw] = useState(false);
	const running = data.state === 'running';

	// step: the progress line's clock ticks while the request runs
	useEffect(() => {
		if (!running) return undefined;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);

	const files = data.files ?? [];
	const many = files.length > 1;

	// ── Running ───────────────────────────────────────────────────────────
	if (running) {
		const done = files.filter((f) => f.state === 'done').length;
		const failed = files.filter((f) => f.state === 'failed').length;
		const line = many ? `${done + failed} of ${files.length} done${failed ? ` · ${failed} couldn't be read` : ''} · ${elapsedWords(data.startedAt, now)}` : files.length === 1 ? `Working on ${files[0].name}… ${elapsedWords(data.startedAt, now)}` : `Thinking… ${elapsedWords(data.startedAt, now)}`;
		const recent = data.thinking.slice(-THINKING_ROWS);
		// step: the rows worth showing for many files: in progress first, then the latest settled, then the next waiting
		const fileRows = many ? [...files.filter((f) => f.state === 'working'), ...files.filter((f) => f.state === 'done' || f.state === 'failed').slice(-2), ...files.filter((f) => f.state === 'waiting').slice(0, 1)].slice(0, FILE_ROWS) : [];
		return (
			<div>
				<div style={styles.progress}>
					<span style={styles.spinner} />
					{line}
				</div>
				{many && (
					<div style={styles.bar}>
						<div style={styles.barFill(files.length ? (done + failed) / files.length : 0)} />
					</div>
				)}
				{many
					? fileRows.map((f) => (
							<div key={f.name} style={styles.fileRow}>
								<span style={styles.mark(f.state === 'failed' ? 'var(--rr-color-error)' : f.state === 'done' ? 'var(--rr-color-success)' : 'var(--rr-text-secondary)')}>{f.state === 'done' ? '✓' : f.state === 'failed' ? '!' : f.state === 'working' ? '↻' : '·'}</span>
								<span style={styles.fileRowText}>{f.name}</span>
								<span style={styles.fileRowText}>{f.state === 'failed' ? `Couldn't read: ${f.error ?? ''}` : f.state === 'working' ? (f.latest ?? 'working') : f.state}</span>
							</div>
						))
					: recent.length > 0 && (
							<div style={styles.thinking}>
								{recent.map((t, i) => (
									<span key={i} style={i === recent.length - 1 ? styles.thinkingNow : undefined}>
										{t}
									</span>
								))}
							</div>
						)}
			</div>
		);
	}

	// ── Settled ───────────────────────────────────────────────────────────
	const seconds = data.endedAt ? Math.max(1, Math.round((data.endedAt - data.startedAt) / 1000)) : null;
	const rawBody = files.length > 0 ? files.map((f) => ({ file: f.name, ...(f.result ? { result: f.result } : { error: f.error }) })) : (data.result ?? { error: data.error });
	const text =
		files.length > 0
			? files
					.map((f) => plainTextOf(f.result))
					.filter(Boolean)
					.join('\n\n')
			: plainTextOf(data.result);

	return (
		<div>
			{data.thinking.length > 0 && seconds !== null && (
				<div style={styles.thought}>
					<Button variant="ghost" mini onClick={() => setShowThinking((s) => !s)}>
						{`Thought for ${seconds} s ${showThinking ? '▾' : '▸'}`}
					</Button>
					{showThinking && (
						<div style={styles.thinking}>
							{data.thinking.map((t, i) => (
								<span key={i}>{t}</span>
							))}
						</div>
					)}
				</div>
			)}

			{data.state === 'interrupted' && <div style={styles.sentence}>This request was interrupted before it finished.</div>}
			{data.state === 'failed' && files.length === 0 && (
				<div>
					<div style={styles.sentence}>{failureSentence(data, agentName)}</div>
					{!simple && data.code && <div style={styles.code}>{data.code}</div>}
				</div>
			)}
			{data.state !== 'interrupted' && !(data.state === 'failed' && files.length === 0) && <ResultView result={data.result} files={files.length > 0 ? files : undefined} simple={simple} agentName={agentName} />}

			{data.state !== 'interrupted' && (
				<div style={styles.actions}>
					{text && (
						<Button variant="ghost" mini onClick={() => copy(text)}>
							Copy
						</Button>
					)}
					<Button variant="ghost" mini onClick={() => download(`${agentName.replace(/\W+/g, '-').toLowerCase() || 'answer'}.json`, JSON.stringify(rawBody, null, 2))}>
						Download
					</Button>
					{!simple && (
						<Button variant="ghost" mini pressed={showRaw} onClick={() => setShowRaw((s) => !s)}>
							Raw
						</Button>
					)}
				</div>
			)}
			{showRaw && !simple && (
				<div style={styles.raw}>
					<JsonTree data={rawBody} defaultExpanded={1} />
				</div>
			)}
		</div>
	);
};

// =============================================================================
// RENDERER
// =============================================================================

/**
 * The shell MessageList's body renderer for the Playground's bodies.
 *
 * @param simple - Simple view.
 * @param agentName - The agent's name.
 * @returns The renderer.
 */
export function playgroundBodies(simple: boolean, agentName: string): ChatMessageBodyRenderer {
	return (message: ChatMessage) => {
		const body = message.body;
		if (!body) return null;
		if (body.kind === BODY_UPLOAD) return <UploadBody data={body.data as UploadBodyData} />;
		if (body.kind === BODY_ANSWER) return <AnswerBody data={body.data as AnswerBodyData} simple={simple} agentName={agentName} />;
		if (body.kind === BODY_REFUSAL) return <div style={styles.sentence}>{(body.data as RefusalBodyData).text}</div>;
		return null;
	};
}
