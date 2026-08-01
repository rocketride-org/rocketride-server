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
// DATA GRID — LAZY GALLERY DEMO
// =============================================================================

/**
 * Lazily-loaded DataGrid demo: this file drags Tabulator in, so the gallery
 * loads it only when the DataGrid entry is first viewed (React.lazy via the
 * entry's lazyDemo loader). Static in-memory rows - no server round-trip.
 */

import React from 'react';
import { DataGrid } from '../../../../../components/data-grid/DataGrid';
import type { GridColumnDefinition } from '../../../../../components/data-grid/defaults';
import type { IGalleryDemoProps } from '../../galleryTypes';

/** Demo row shape. */
interface IDemoRow extends Record<string, unknown> {
	name: string;
	type: string;
	documents: number;
	updated: string;
}

/** Static demo rows - enough to exercise sorting and the footer auto-hide. */
const DEMO_ROWS: IDemoRow[] = [
	{ name: 'chat.pipe', type: 'Pipeline', documents: 1284, updated: '2026-07-30' },
	{ name: 'ingest.pipe', type: 'Pipeline', documents: 20941, updated: '2026-07-29' },
	{ name: 'transcribe.pipe', type: 'Pipeline', documents: 512, updated: '2026-07-28' },
	{ name: 'summarize.pipe', type: 'Pipeline', documents: 77, updated: '2026-07-26' },
	{ name: 'classify.pipe', type: 'Pipeline', documents: 4310, updated: '2026-07-22' },
	{ name: 'redact.pipe', type: 'Pipeline', documents: 158, updated: '2026-07-19' },
];

/** Demo columns - typed so the header popups pick the right filter controls. */
const DEMO_COLUMNS: GridColumnDefinition[] = [
	{ title: 'Name', field: 'name', rrType: 'string', rrDefault: true, rrDescription: 'Pipeline file name.' },
	{ title: 'Type', field: 'type', rrType: 'string', rrDefault: true, rrDescription: 'Artifact kind.' },
	{ title: 'Documents', field: 'documents', rrType: 'number', rrDefault: true, rrDescription: 'Documents processed by the last run.' },
	{ title: 'Updated', field: 'updated', rrType: 'date', rrDefault: true, rrDefaultSort: 'desc', rrDescription: 'Date of the last run.' },
];

/** Live demo: a static-data DataGrid with the stock title bar. */
const DataGridDemo: React.FC<IGalleryDemoProps> = () => (
	<div style={{ maxWidth: 720 }}>
		<DataGrid title="Pipelines" columns={DEMO_COLUMNS} data={DEMO_ROWS} />
	</div>
);

export default DataGridDemo;
