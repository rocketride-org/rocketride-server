// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** Gallery entry for Pagination. */

import React, { useState } from 'react';
import { Pagination } from 'shell';
import type { IGalleryDemoProps, IGalleryEntry, KnobValues } from '../galleryTypes';

/** Live demo: 134 items with a page-size picker. */
const PaginationDemo: React.FC<IGalleryDemoProps> = ({ knobs }) => {
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(10);
	const totalItems = Number(knobs.totalItems);
	const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
	return (
		<div style={{ maxWidth: 640 }}>
			<Pagination
				page={Math.min(page, pageCount)}
				pageCount={pageCount}
				onChange={setPage}
				totalItems={totalItems}
				pageSize={pageSize}
				pageSizes={[10, 25, 50]}
				onPageSizeChange={(size) => {
					setPageSize(size);
					setPage(1);
				}}
				siblingCount={Number(knobs.siblingCount)}
			/>
		</div>
	);
};

/** Snippet builder mirroring the current knob state. */
function buildCode(knobs: KnobValues): string {
	return `import { Pagination } from 'shell';

<Pagination
	page={page}
	pageCount={Math.ceil(total / pageSize)}
	onChange={setPage}
	totalItems={total}
	pageSize={pageSize}
	pageSizes={[10, 25, 50]}
	onPageSizeChange={setPageSize}
	siblingCount={${Number(knobs.siblingCount)}}
/>`;
}

/** The Pagination gallery entry. */
export const paginationEntry: IGalleryEntry = {
	id: 'pagination',
	name: 'Pagination',
	group: 'content',
	blurb: 'Page controls for lists and card grids outside DataGrid. Constant width with first/last pages and gaps; optional range text and page-size picker.',
	knobs: [
		{ id: 'totalItems', label: 'Total items', kind: 'number', defaultValue: 134 },
		{ id: 'siblingCount', label: 'Siblings', kind: 'number', defaultValue: 1 },
	],
	demo: PaginationDemo,
	code: buildCode,
	props: [
		{ name: 'page / pageCount', type: 'number', dir: 'in', required: true, note: 'Current page (1-based) and total pages.' },
		{ name: 'siblingCount', type: 'number', dir: 'in', note: 'Pages each side of the current one. Default 1.' },
		{ name: 'totalItems / pageSize', type: 'number', dir: 'in', note: 'Show the "21-40 of 134" range.' },
		{ name: 'pageSizes', type: 'number[]', dir: 'in', note: 'Page-size choices (with onPageSizeChange).' },
		{ name: 'ariaLabel', type: 'string', dir: 'in', note: "Nav landmark name. Default 'Pagination'." },
		{ name: 'onChange', type: '(page: number) => void', dir: 'out', required: true, note: 'Fired with the new page.' },
		{ name: 'onPageSizeChange', type: '(pageSize: number) => void', dir: 'out', note: 'Fired with a new page size.' },
	],
};
