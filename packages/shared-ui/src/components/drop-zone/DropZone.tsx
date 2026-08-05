// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DropZone — the platform's stock dashed file-drop target.
 *
 * A centred dashed panel with a plus glyph, a title, and an optional hint. Files
 * dropped onto it are forwarded via `onFiles`. While a drag is over the target
 * the dashed border highlights with the brand colour. Clicking the target (or
 * pressing Enter / Space while it is focused) opens the native file picker, so
 * keyboard, screen-reader, and touch users are not locked out of drop-only input.
 */

import React, { CSSProperties, DragEvent, KeyboardEvent, useRef, useState } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link DropZone} component. */
export interface IDropZoneProps {
	/** Primary prompt, e.g. "Drop documents here to ingest". */
	title: string;
	/** Optional secondary hint, e.g. "Supports PDF, TXT, MD, HTML, CSV". */
	hint?: string;
	/** Fired with the dropped files. */
	onFiles: (files: FileList) => void;
}

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	// Dashed panel; the border highlights to brand while dragging over.
	zone: (dragging: boolean): CSSProperties => ({
		border: `2px dashed ${dragging ? 'var(--rr-brand)' : 'var(--rr-border-hover)'}`,
		borderRadius: 10,
		padding: '34px 24px',
		textAlign: 'center',
		color: 'var(--rr-text-secondary)',
		cursor: 'pointer',
	}),

	// Hidden file input backing the click-to-browse fallback.
	input: {
		display: 'none',
	} as CSSProperties,

	plus: {
		fontSize: 26,
		color: 'var(--rr-text-disabled)',
		lineHeight: 1,
		marginBottom: 8,
	} as CSSProperties,

	title: {
		fontSize: 14.5,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	hint: {
		fontSize: 12.5,
		marginTop: 4,
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a dashed file-drop target.
 *
 * @param props - {@link IDropZoneProps}.
 * @returns The drop-zone element.
 */
export function DropZone({ title, hint, onFiles }: IDropZoneProps): React.ReactElement {
	// Tracks whether a drag is currently over the target (drives the highlight).
	const [dragging, setDragging] = useState(false);
	// Hidden input powering click / keyboard file selection.
	const inputRef = useRef<HTMLInputElement>(null);

	// Open the native picker (click-to-browse fallback).
	const openPicker = (): void => inputRef.current?.click();

	// Keyboard twin of the click: Enter / Space open the picker.
	const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			openPicker();
		}
	};

	// Prevent default so the browser allows a drop and show the highlight.
	const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
		e.preventDefault();
		setDragging(true);
	};

	// Clear the highlight when the drag leaves the target.
	const handleDragLeave = (e: DragEvent<HTMLDivElement>): void => {
		e.preventDefault();
		setDragging(false);
	};

	// Forward dropped files and clear the highlight.
	const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
		e.preventDefault();
		setDragging(false);
		if (e.dataTransfer && e.dataTransfer.files.length > 0) {
			onFiles(e.dataTransfer.files);
		}
	};

	return (
		<div
			style={styles.zone(dragging)}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
			// Click-to-browse fallback: the whole target is a button that opens
			// the native picker, keyboard-operable via Enter / Space.
			role="button"
			tabIndex={0}
			aria-label={title}
			onClick={openPicker}
			onKeyDown={handleKeyDown}
		>
			<input
				ref={inputRef}
				type="file"
				multiple
				style={styles.input}
				onChange={(e) => {
					if (e.target.files && e.target.files.length > 0) onFiles(e.target.files);
					// Reset so picking the same file again still fires onChange.
					e.target.value = '';
				}}
			/>
			<div style={styles.plus}>+</div>
			<div style={styles.title}>{title}</div>
			{hint && <div style={styles.hint}>{hint}</div>}
		</div>
	);
}
