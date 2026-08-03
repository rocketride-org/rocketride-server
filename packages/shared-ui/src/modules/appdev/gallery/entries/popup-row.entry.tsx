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
// POPUP ROW — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the PopupRow popup-menu item. */

import React from 'react';
import { BxCog, BxTrash, PopupRow } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry } from '../galleryTypes';

/** Menu-shaped container so the rows read as a real popup. */
const MENU_STYLE: React.CSSProperties = {
	width: 200,
	padding: 4,
	border: '1px solid var(--rr-border)',
	borderRadius: 6,
	background: 'var(--rr-bg-surface-alt)',
};

/** Row label style pairing an icon with its text. */
const ROW_LABEL_STYLE: React.CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	gap: 8,
};

/** Live demo: a static popup body built from PopupRows. */
const PopupRowDemo: React.FC<IGalleryDemoProps> = () => (
	<div style={MENU_STYLE}>
		<PopupRow onClick={() => undefined}>
			<span style={ROW_LABEL_STYLE}><BxCog size={16} /> Settings</span>
		</PopupRow>
		<PopupRow onClick={() => undefined}>
			<span style={ROW_LABEL_STYLE}><BxTrash size={16} /> Delete</span>
		</PopupRow>
	</div>
);

/** The PopupRow gallery entry. */
export const popupRowEntry: IGalleryEntry = {
	id: 'popup-row',
	name: 'PopupRow',
	group: 'content',
	blurb: 'A single clickable item inside a popup menu: the hover-highlighted flex row used by every kebab / footer / context menu.',
	doc: `The row is intentionally minimal — content is free-form children (icon + label + chevron), so it composes into any popup body. Pair it with \`useFixedPopupPosition\` for the anchored container and \`useClickOutside\` for dismissal.`,
	demo: PopupRowDemo,
	code: `import { PopupRow, BxCog } from 'shell';

<div style={popupStyle}>
	<PopupRow onClick={openSettings}>
		<BxCog size={16} /> Settings
	</PopupRow>
	<PopupRow onClick={remove}>
		<BxTrash size={16} /> Delete
	</PopupRow>
</div>`,
	props: [
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'Row content - icons, label, trailing chevron.' },
		{ name: 'onClick', type: '(e: MouseEvent) => void', dir: 'out', note: 'Row activation handler.' },
	],
};
