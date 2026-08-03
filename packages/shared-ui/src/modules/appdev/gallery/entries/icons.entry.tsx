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
// ICONS — GALLERY ENTRY (ICON BROWSER)
// =============================================================================

/** Gallery entry browsing the full Bx* icon set with click-to-copy names. */

import React, { useState } from 'react';
import * as BoxIcon from 'shell/src/components/BoxIcon';
import type { IconComponent } from 'shell/src/components/BoxIcon';
import { commonStyles } from 'shell/src/themes/styles';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Every exported Bx* glyph, enumerated from the module itself so the
    browser can never drift from the real export list. */
const ALL_ICONS: Array<[string, IconComponent]> = Object.entries(BoxIcon)
	.filter(([name, value]) => name.startsWith('Bx') && typeof value === 'function')
	.map(([name, value]) => [name, value as IconComponent]);

/** One icon tile: glyph over its mono name, click copies the name. */
const TILE_STYLE: React.CSSProperties = {
	display: 'flex',
	flexDirection: 'column',
	alignItems: 'center',
	gap: 6,
	width: 92,
	padding: '10px 4px',
	border: '1px solid var(--rr-border)',
	borderRadius: 6,
	cursor: 'pointer',
};

/** The tile's mono name label. */
const TILE_NAME_STYLE: React.CSSProperties = {
	...commonStyles.fontMono,
	fontSize: 9.5,
	color: 'var(--rr-text-secondary)',
	maxWidth: 86,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
};

/** Live demo: the filterable icon grid; clicking a tile copies its name. */
const IconBrowserDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [copiedName, setCopiedName] = useState<string | null>(null);
	const filter = String(knobs.filter).toLowerCase();
	const size = Number(knobs.size);
	const shown = ALL_ICONS.filter(([name]) => name.toLowerCase().includes(filter));

	/** Copies the clicked icon's import name and flashes its tile. */
	const copyName = (name: string): void => {
		void navigator.clipboard.writeText(name).then(() => {
			setCopiedName(name);
			setTimeout(() => setCopiedName(null), 1200);
		});
	};

	return (
		<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
			{shown.map(([name, Icon]) => (
				<div key={name} style={TILE_STYLE} onClick={() => copyName(name)} title={`Copy "${name}"`}>
					<Icon size={size} />
					<span style={TILE_NAME_STYLE}>{copiedName === name ? 'copied' : name}</span>
				</div>
			))}
			{shown.length === 0 && <span style={commonStyles.textMuted}>No icon matches "{filter}"</span>}
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => `import { BxRocket } from 'shell';

<BxRocket${Number(knobs.size) !== 24 ? ` size={${Number(knobs.size)}}` : ''} />
// color defaults to currentColor - icons follow the surrounding text colour.`;

/** The Icons gallery entry. */
export const iconsEntry: IGalleryEntry = {
	id: 'icons',
	name: 'Icons',
	group: 'utils',
	blurb: 'The full Bx* icon set on the shell surface - every glyph browsable here; click a tile to copy its import name.',
	doc: `All icons share one prop contract (\`IconProps\`) and inherit \`currentColor\`, so they recolor with the surrounding text and theme automatically. The whole set flows through the surface star-export — import any glyph by name from \`'shell'\`.`,
	knobs: [
		{ id: 'filter', label: 'Filter', kind: 'text', defaultValue: '' },
		{ id: 'size', label: 'Size', kind: 'number', defaultValue: 24 },
	],
	demo: IconBrowserDemo,
	code: buildCode,
	propsLabel: 'IconProps',
	props: [
		{ name: 'size', type: 'number', dir: 'in', note: 'Rendered width/height in px. Default 24.' },
		{ name: 'color', type: 'string', dir: 'in', note: 'Fill colour. Default currentColor.' },
		{ name: 'className / style', type: 'string / CSSProperties', dir: 'in', note: 'Pass-through class name and inline style overrides.' },
	],
};
