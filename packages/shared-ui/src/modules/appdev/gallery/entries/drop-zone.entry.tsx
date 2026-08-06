// MIT License
//
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
// DROP ZONE — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock DropZone file-drop target. */

import React, { useState } from 'react';
import { DropZone } from 'shell';
import { commonStyles } from 'shell/src/themes/styles';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a DropZone that reports how many files were dropped on it. */
const DropZoneDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [droppedCount, setDroppedCount] = useState<number | null>(null);
	return (
		<div style={{ maxWidth: 420 }}>
			<DropZone
				title={String(knobs.title)}
				hint={String(knobs.hint) || undefined}
				onFiles={(files) => setDroppedCount(files.length)}
			/>
			{droppedCount !== null && (
				<div style={{ ...commonStyles.textMuted, marginTop: 8 }}>
					{droppedCount} file{droppedCount === 1 ? '' : 's'} dropped (demo only - nothing is uploaded).
				</div>
			)}
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => {
	const hintAttr = knobs.hint ? `\n\thint="${String(knobs.hint)}"` : '';
	return `import { DropZone } from 'shared';

<DropZone
	title="${String(knobs.title)}"${hintAttr}
	onFiles={(files) => uploadFiles(files)}
/>`;
};

/** The DropZone gallery entry. */
export const dropZoneEntry: IGalleryEntry = {
	id: 'drop-zone',
	name: 'DropZone',
	group: 'content',
	blurb: 'Dashed file-drop target with a primary prompt and secondary hint - fires onFiles with the dropped FileList. Try dropping files on the live demo.',
	knobs: [
		{ id: 'title', label: 'Title', kind: 'text', defaultValue: 'Drop documents here to ingest' },
		{ id: 'hint', label: 'Hint', kind: 'text', defaultValue: 'Supports PDF, TXT, MD, HTML, CSV' },
	],
	demo: DropZoneDemo,
	code: buildCode,
	props: [
		{ name: 'title', type: 'string', dir: 'in', required: true, note: 'Primary prompt, e.g. "Drop documents here to ingest".' },
		{ name: 'hint', type: 'string', dir: 'in', note: 'Optional secondary hint, e.g. the supported formats.' },
		{ name: 'onFiles', type: '(files: FileList) => void', dir: 'out', required: true, note: 'Fired with the dropped files.' },
	],
};
