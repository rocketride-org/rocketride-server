// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Skeleton. */

import React from 'react';
import { Skeleton } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: a loading list row and a paragraph. */
const SkeletonDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => (
	<div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 360 }}>
		<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
			<Skeleton circle width={32} />
			<div style={{ flex: 1 }}>
				<Skeleton lines={2} />
			</div>
		</div>
		<Skeleton lines={Number(knobs.lines)} />
	</div>
);

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	return `import { Skeleton } from 'shell';

<div aria-busy="true">
	<Skeleton circle width={32} />
	<Skeleton lines={${Number(knobs.lines)}} />
</div>`;
}

/** The Skeleton gallery entry. */
export const skeletonEntry: IGalleryEntry = {
	id: 'skeleton',
	name: 'Skeleton',
	group: 'content',
	blurb: 'Shimmering placeholder in the shape of loading content, so layout does not jump. Hidden from screen readers.',
	docNote: 'Mark the loading region with aria-busy="true"; use a Spinner for short in-place waits.',
	knobs: [{ id: 'lines', label: 'Lines', kind: 'number', defaultValue: 3 }],
	demo: SkeletonDemo,
	code: buildCode,
	props: [
		{ name: 'width / height', type: 'number | string', dir: 'in', note: "Size. Default '100%' x 12." },
		{ name: 'circle', type: 'boolean', dir: 'in', note: 'Circle; width is the diameter.' },
		{ name: 'lines', type: 'number', dir: 'in', note: 'A paragraph of this many lines (last one shorter).' },
	],
};
