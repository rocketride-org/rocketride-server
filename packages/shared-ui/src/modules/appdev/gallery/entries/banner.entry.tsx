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
// BANNER — GALLERY ENTRY
// =============================================================================

/** Gallery entry for the stock Banner callout strip. */

import React from 'react';
import { Banner } from '../../../../components/banner/Banner';
import type { BannerVariant } from '../../../../components/banner/Banner';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: one Banner driven by the knob values. */
const BannerDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<Banner variant={knobs.variant as BannerVariant}>{String(knobs.text)}</Banner>
);

/** Snippet builder mirroring the current knob state. */
const buildCode = (knobs: KnobValues): string => `import { Banner } from 'shared';

<Banner variant="${String(knobs.variant)}">${String(knobs.text)}</Banner>`;

/** The Banner gallery entry. */
export const bannerEntry: IGalleryEntry = {
	id: 'banner',
	name: 'Banner',
	group: 'content',
	blurb: 'Info / warning / error callout strip - a tinted, bordered message row for inline notices inside a view.',
	knobs: [
		{ id: 'variant', label: 'Variant', kind: 'select', options: ['info', 'warning', 'error'], defaultValue: 'info' },
		{ id: 'text', label: 'Message', kind: 'text', defaultValue: 'Deploys are paused while the pipeline rebuilds.' },
	],
	demo: BannerDemo,
	code: buildCode,
	props: [
		{ name: 'variant', type: "'info' | 'warning' | 'error'", dir: 'in', required: true, note: 'Semantic variant - selects border, text, and tinted background token.' },
		{ name: 'children', type: 'ReactNode', dir: 'in', required: true, note: 'Message content.' },
	],
};
