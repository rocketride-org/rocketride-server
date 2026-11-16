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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * UploadWidget — an `upload` leaf stores the chosen file as a data URL with
 * the file name embedded (`data:<mime>;name=<encoded>;base64,...`), the shape
 * the nodes decode (`_decode_blob`). Shows the stored file's name with
 * Replace / Remove; the stock DropZone carries the pick itself.
 */

import { CSSProperties, ReactElement, useEffect, useRef } from 'react';
import { Button, commonStyles } from 'shell';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	row: {
		...commonStyles.inputField,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: 8,
	} as CSSProperties,

	name: {
		...commonStyles.textEllipsis,
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	actions: {
		display: 'flex',
		gap: 4,
	} as CSSProperties,

	// Visually hidden, NOT display:none: the native file input stays in the
	// accessibility tree so the frame's label, help and error reach it.
	hidden: {
		position: 'absolute',
		width: 1,
		height: 1,
		padding: 0,
		margin: -1,
		overflow: 'hidden',
		clip: 'rect(0 0 0 0)',
		whiteSpace: 'nowrap',
		border: 0,
	} as CSSProperties,
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Embeds the file name into a data URL's MIME segment so it survives the
 * round trip through the config.
 *
 * @param dataURL - The FileReader data URL.
 * @param name - The original file name.
 * @returns The data URL carrying the name.
 */
export function addNameToDataURL(dataURL: string, name: string): string {
	return dataURL.replace(';base64', `;name=${encodeURIComponent(name)};base64`);
}

/**
 * Reads the embedded file name back out of a stored data URL.
 *
 * @param value - The stored value.
 * @returns The file name, or a generic label.
 */
export function fileNameOf(value: unknown): string {
	if (typeof value !== 'string') return '';
	const match = /;name=([^;]+);/.exec(value);
	if (match) {
		try {
			return decodeURIComponent(match[1]);
		} catch {
			return match[1];
		}
	}
	return value.startsWith('data:') ? 'Uploaded file' : 'Stored value';
}

/**
 * Reads one File into a named data URL.
 *
 * @param file - The chosen file.
 * @returns The data URL with the name embedded.
 */
function readFile(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = reject;
		reader.onload = (event) => {
			const result = event.target?.result;
			if (typeof result === 'string') resolve(addNameToDataURL(result, file.name));
			else reject(new Error('Unreadable file'));
		};
		reader.readAsDataURL(file);
	});
}

// =============================================================================
// Props
// =============================================================================

/** Props for {@link UploadWidget}. */
export interface IUploadWidgetProps {
	/** The control's element id. */
	id: string;
	/** The stored value (a data URL), or undefined. */
	stored: unknown;
	/** The value lives in the engine's encrypted section. */
	storedSecurely?: boolean;
	/** Accepted file types (`options.accept`). */
	accept?: string;
	/** Stores the data URL; undefined removes the file. */
	onChange: (value: string | undefined) => void;
	/** Disabled state. */
	disabled?: boolean;
	/** Invalid state. */
	invalid?: boolean;
	/** Ids of the message / help elements the control is described by. */
	describedBy?: string;
	/** Required state, announced on the control. */
	required?: boolean;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the upload control.
 *
 * @param props - {@link IUploadWidgetProps}.
 * @returns The control.
 */
export default function UploadWidget({ id, stored, storedSecurely, accept, onChange, disabled, invalid, describedBy, required }: IUploadWidgetProps): ReactElement {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const hasFile = storedSecurely || (typeof stored === 'string' && stored.length > 0);

	// Only the latest action commits: a read superseded by another pick, a
	// Remove, or unmount is dropped when it completes.
	const generation = useRef(0);
	useEffect(() => () => { generation.current++; }, []);

	const pick = (): void => inputRef.current?.click();
	const remove = (): void => {
		generation.current++;
		onChange(undefined);
	};

	return (
		<div style={{ ...styles.row, position: 'relative', ...(invalid ? { borderColor: 'var(--rr-color-error)' } : {}) }}>
			<span style={{ ...styles.name, ...(hasFile ? {} : commonStyles.textMuted) }}>{hasFile ? (storedSecurely ? 'Saved securely' : fileNameOf(stored)) : 'No file chosen'}</span>
			<div style={styles.actions}>
				{!disabled && (
					<Button variant="secondary" small onClick={pick}>
						{hasFile ? 'Replace' : 'Choose file'}
					</Button>
				)}
				{!disabled && hasFile && (
					<Button variant="ghost" small onClick={remove} title="Remove">
						×
					</Button>
				)}
			</div>
			<input
				id={id}
				ref={inputRef}
				type="file"
				accept={accept}
				style={styles.hidden}
				disabled={disabled}
				aria-describedby={describedBy}
				aria-required={required || undefined}
				aria-invalid={invalid || undefined}
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = '';
					if (!file) return;
					const mine = ++generation.current;
					readFile(file)
						.then((dataURL) => {
							if (generation.current === mine) onChange(dataURL);
						})
						.catch((error: unknown) => console.error('Error reading upload:', error));
				}}
			/>
		</div>
	);
}
