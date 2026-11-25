// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * BottomBar — what the agent's source takes, as one bar under the thread:
 *   - typed input only  → the shell's ChatInputField;
 *   - files only        → the drop bar (the shell's compact DropZone), with
 *                         no text field, caret or Send;
 *   - both              → ChatInputField with an attach button in its
 *                         leadingInputSlot; a file dropped on the bar is
 *                         attached the same way.
 * Dragging files anywhere over the window lights the bar; nothing covers
 * the conversation.
 */

import React, { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { BxPlus, Button, Chip, ChatInputField, DropZone } from 'shell';
import type { AgentSource } from '../core/model';
import { takesFiles, takesHint } from '../core/sources';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	dropFoot: {
		flexShrink: 0,
		borderTop: '1px solid var(--rr-border)',
		padding: '12px 16px 10px',
		backgroundColor: 'var(--rr-bg-paper)',
	} as CSSProperties,
	dropInner: {
		maxWidth: 720,
		margin: '0 auto',
	} as CSSProperties,
	hint: {
		marginTop: 6,
		fontSize: 11,
		color: 'var(--rr-text-caption)',
		textAlign: 'center',
	} as CSSProperties,
	attachSlot: {
		display: 'flex',
		alignItems: 'center',
		gap: 6,
		flexWrap: 'wrap',
		maxWidth: '50%',
	} as CSSProperties,
	hiddenInput: {
		display: 'none',
	} as CSSProperties,
	litWrap: (lit: boolean): CSSProperties => ({
		flexShrink: 0,
		boxShadow: lit ? 'inset 0 0 0 2px var(--rr-brand)' : 'none',
		transition: 'box-shadow 0.15s',
	}),
};

// =============================================================================
// WINDOW DRAG
// =============================================================================

/**
 * True while files are dragged anywhere over the window (enter/leave are
 * counted, since every child fires its own pair).
 *
 * @returns Whether a file drag is over the window.
 */
export function useWindowFileDrag(): boolean {
	const [over, setOver] = useState(false);
	useEffect(() => {
		let depth = 0;
		const hasFiles = (e: globalThis.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
		const enter = (e: globalThis.DragEvent) => {
			if (!hasFiles(e)) return;
			depth++;
			setOver(true);
		};
		const leave = (e: globalThis.DragEvent) => {
			if (!hasFiles(e)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) setOver(false);
		};
		const end = () => {
			depth = 0;
			setOver(false);
		};
		window.addEventListener('dragenter', enter);
		window.addEventListener('dragleave', leave);
		window.addEventListener('drop', end);
		window.addEventListener('dragend', end);
		return () => {
			window.removeEventListener('dragenter', enter);
			window.removeEventListener('dragleave', leave);
			window.removeEventListener('drop', end);
			window.removeEventListener('dragend', end);
		};
	}, []);
	return over;
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link BottomBar}. */
export interface IBottomBarProps {
	/** The connection's source. */
	source: AgentSource;
	/** The agent's name, for the placeholder and the drop title. */
	agentName: string;
	/** Whether the client is connected. */
	connected: boolean;
	/** Sends typed text. */
	onText: (text: string) => void;
	/** Sends files. */
	onFiles: (files: File[]) => void;
}

/**
 * Renders the bar for what the source takes.
 *
 * @param props - {@link IBottomBarProps}.
 * @returns The bar, or null when the source takes nothing a caller can type or drop.
 */
export const BottomBar: React.FC<IBottomBarProps> = ({ source, agentName, connected, onText, onFiles }) => {
	const dragging = useWindowFileDrag();
	const [attached, setAttached] = useState<File[]>([]);
	const pickerRef = useRef<HTMLInputElement>(null);
	const files = takesFiles(source);
	const hint = takesHint(source);

	// ── Files only: the drop bar ─────────────────────────────────────────
	if (files && !source.typed) {
		return (
			<div style={styles.dropFoot}>
				<div style={styles.dropInner}>
					<DropZone compact highlighted={dragging} title={`Drop files for ${agentName}`} hint="or click to choose" onFiles={(list) => onFiles(Array.from(list))} />
					{hint && <div style={styles.hint}>{hint}</div>}
				</div>
			</div>
		);
	}

	// ── Typed input only: the chat input ─────────────────────────────────
	if (!files) {
		if (!source.typed) return null;
		return <ChatInputField disabled={!connected} placeholder={`Ask ${agentName} a question…`} onSend={onText} />;
	}

	// ── Both: the chat input with an attach button; a drop on the bar attaches ──
	const attach = (list: FileList | null) => {
		if (list && list.length > 0) setAttached((cur) => [...cur, ...Array.from(list)]);
	};
	const send = (text: string) => {
		if (text) onText(text);
		if (attached.length > 0) onFiles(attached);
		setAttached([]);
	};
	const slot = (
		<div style={styles.attachSlot}>
			<Button variant="ghost" small title="Attach files" onClick={() => pickerRef.current?.click()}>
				<BxPlus size={16} />
			</Button>
			{/* The shell has no file-picker control; this hidden input backs the attach button. */}
			<input
				ref={pickerRef}
				type="file"
				multiple
				style={styles.hiddenInput}
				onChange={(e) => {
					attach(e.target.files);
					e.target.value = '';
				}}
			/>
			{attached.map((f, i) => (
				<Chip key={`${f.name}-${i}`} label={f.name} onRemove={() => setAttached((cur) => cur.filter((_x, k) => k !== i))} />
			))}
		</div>
	);
	return (
		// A drop target around the bar (the shell has no drop-target wrapper).
		<div
			style={styles.litWrap(dragging)}
			onDragOver={(e: DragEvent<HTMLDivElement>) => e.preventDefault()}
			onDrop={(e: DragEvent<HTMLDivElement>) => {
				e.preventDefault();
				attach(e.dataTransfer?.files ?? null);
			}}
		>
			<ChatInputField disabled={!connected} placeholder={`Ask ${agentName} a question…`} leadingInputSlot={slot} allowEmpty={attached.length > 0} hint={hint} onSend={send} />
		</div>
	);
};
