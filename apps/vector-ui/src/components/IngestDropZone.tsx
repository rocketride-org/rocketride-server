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

// =============================================================================
// VECTOR-UI — IngestDropZone (drop files or folders, or pick them)
// =============================================================================
//
// The app's own drop zone (the shell's takes files only): folders dropped on
// it keep their relative paths (dropTraversal.ts), and two buttons open the
// file and folder pickers for keyboard and pointer users. Disabled, it says
// why. Shell tokens only.
// =============================================================================

import React, { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { commonStyles } from 'shell';
import { ACCEPT_ATTRIBUTE, UPLOAD_HINT } from '../vector/uploads';
import type { DataTransferLike } from '../ingest/dropTraversal';

/** Props of {@link IngestDropZone}. */
export interface IngestDropZoneProps {
	/** The collection files are added to (named in the title). */
	collection: string | null;
	/** Shown instead of accepting drops. */
	disabledReason: string | null;
	/** Something was dropped (called inside the drop handler). */
	onDrop(transfer: DataTransferLike): void;
	/** Files were picked with "Add files" or "Add folder". */
	onPick(files: ArrayLike<File>): void;
}

const S = {
	zone: { border: '1px dashed var(--rr-border-input)', borderRadius: 6, padding: '12px 14px', background: 'var(--rr-bg-paper)', display: 'flex', flexDirection: 'column', gap: 6 } as CSSProperties,
	over: { borderColor: 'var(--rr-border-focus)', borderStyle: 'solid', background: 'var(--rr-bg-widget-hover)' } as CSSProperties,
	disabled: { opacity: 0.7 } as CSSProperties,
	title: { fontSize: 13, fontWeight: 600, color: 'var(--rr-text-primary)', margin: 0, overflowWrap: 'anywhere' } as CSSProperties,
	hint: { fontSize: 12, color: 'var(--rr-text-secondary)', margin: 0 } as CSSProperties,
	reason: { fontSize: 12, color: 'var(--rr-text-secondary)', margin: 0 } as CSSProperties,
	buttons: { display: 'flex', gap: 8, flexWrap: 'wrap' } as CSSProperties,
};

/** The folder picker attribute React does not type. */
const FOLDER_PICKER: Record<string, string> = { webkitdirectory: '', directory: '' };

/**
 * The drop zone.
 *
 * @param props - {@link IngestDropZoneProps}.
 * @returns The zone.
 */
export function IngestDropZone({ collection, disabledReason, onDrop, onPick }: IngestDropZoneProps): React.ReactElement {
	const files = useRef<HTMLInputElement>(null);
	const folder = useRef<HTMLInputElement>(null);
	const [over, setOver] = useState(false);
	const disabled = disabledReason !== null;
	const target = collection ?? 'this collection';

	/**
	 * Hand picked files over and reset the input, so picking the same file again fires.
	 *
	 * @param event - The input's change event.
	 */
	const picked = (event: React.ChangeEvent<HTMLInputElement>): void => {
		const list = event.currentTarget.files;
		if (list && list.length > 0) onPick(Array.from(list));
		event.currentTarget.value = '';
	};

	return (
		<div
			role="group"
			aria-label={`Add documents to ${target}`}
			aria-disabled={disabled || undefined}
			data-drop-active={over ? 'true' : undefined}
			style={{ ...S.zone, ...(over && !disabled ? S.over : null), ...(disabled ? S.disabled : null) }}
			onDragOver={(event) => {
				event.preventDefault();
				event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
				if (!over) setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(event) => {
				event.preventDefault();
				setOver(false);
				if (!disabled) onDrop(event.dataTransfer);
			}}
		>
			<p style={S.title}>{`Drop files or folders here to add them to ${target}`}</p>
			<p style={S.hint}>{UPLOAD_HINT}</p>
			{disabled && <p style={S.reason}>{disabledReason}</p>}
			<div style={S.buttons}>
				<button type="button" style={commonStyles.buttonSecondary} disabled={disabled} onClick={() => files.current?.click()}>
					Add files
				</button>
				<button type="button" style={commonStyles.buttonSecondary} disabled={disabled} onClick={() => folder.current?.click()}>
					Add folder
				</button>
			</div>
			<input ref={files} type="file" multiple accept={ACCEPT_ATTRIBUTE} hidden aria-label={`Choose files to add to ${target}`} onChange={picked} disabled={disabled} />
			<input ref={folder} type="file" multiple hidden aria-label={`Choose a folder to add to ${target}`} onChange={picked} disabled={disabled} {...FOLDER_PICKER} />
		</div>
	);
}

export default IngestDropZone;
