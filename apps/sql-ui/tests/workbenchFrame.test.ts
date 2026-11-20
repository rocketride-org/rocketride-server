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
// WORKBENCH FRAME — which pages show the workbench header, and the diagram's height
// =============================================================================
//
// Query, Data and Design carry their own header, so the workbench header above
// them made two stacked headers (and padding on padding). The diagram is
// React Flow, which needs a definite height: its root and every wrapper
// around its empty states must be `height: 100%` with `minHeight: 0`. The
// views have no DOM harness here, so the wiring is checked in the source.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pageHasOwnHeader, showsWorkbenchHeader } from '../src/pageFrame';

const src = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, '..', 'src', ...parts), 'utf8');

describe('which pages show the workbench header', () => {
	it('is Overview, Insights and Diagram only', () => {
		assert.deepEqual(['overview', 'insights', 'diagram'].filter(showsWorkbenchHeader), ['overview', 'insights', 'diagram']);
		for (const page of ['query', 'data', 'design']) assert.equal(showsWorkbenchHeader(page), false, page);
	});

	it('marks the pages that carry their own header, which the panel does not pad again', () => {
		for (const page of ['query', 'data', 'design']) assert.equal(pageHasOwnHeader(page), true, page);
		for (const page of ['overview', 'insights', 'diagram']) assert.equal(pageHasOwnHeader(page), false, page);
	});
});

describe('ConnectionView frame', () => {
	const view = src('views', 'ConnectionView.tsx');

	it('renders the workbench ContentHeader only through showsWorkbenchHeader', () => {
		assert.match(view, /showsWorkbenchHeader\(activePage\)\s*&&\s*\(\s*<ContentHeader/);
		assert.equal((view.match(/<ContentHeader/g) ?? []).length, 1);
	});

	it('takes the panel padding off the pages that pad themselves', () => {
		assert.match(view, /pageHasOwnHeader\(activePage\)\s*\?\s*styles\.panelsBare\s*:\s*styles\.panels/);
	});

	it('hands the diagram the way to open a table, rather than navigating inside it', () => {
		assert.match(view, /<DiagramView endpoint=\{endpoint\} onOpenTable=\{pageNav\.openTableData\}/);
	});
});

// Live L2 (1440x900): the editor had 285 px (14 lines) but the results
// 132 px of rows, so 5 of 10 rows showed. The page now sizes both from a
// basis: 13 editor lines and 10 result rows, sharing what is left, and the
// notes that sat under the grid ride its header line.
describe('the editor and results regions (live L2)', () => {
	const query = src('views', 'QueryView.tsx');
	const block = (name: string): string => {
		const found = new RegExp(`\\t${name}: \\{([\\s\\S]*?)\\} as CSSProperties`).exec(query);
		assert.ok(found, `${name} not found`);
		return found[1]!;
	};
	const px = (text: string, re: RegExp): number => Number(re.exec(text)?.[1] ?? NaN);

	it('the editor keeps 13 lines and the results 10 rows at 1440x900', () => {
		// Monaco's line is 20 px; a result row is 23 px under a 34 px grid
		// header and the 51 px card header.
		const editor = px(block('editorRegion'), /flex: '1 1 (\d+)px'/);
		const results = px(block('resultsRegion'), /flex: '1 1 (\d+)px'/);
		assert.ok(editor >= 13 * 20, `editor basis ${editor}`);
		assert.ok(results >= 51 + 34 + 10 * 23, `results basis ${results}`);
		assert.ok(px(block('editorRegion'), /minHeight: (\d+)/) >= 10 * 20, 'at least 10 lines when banners take room');
		// What the page has at 1440x900, measured live: the body is 666 px
		// under the doc tabs (36), workbench tabs (53), query strip (34),
		// page header (79) and over the status bar (32).
		const body = block('body');
		const pad = /padding: '(\d+)px \d+px (\d+)px'/.exec(body);
		const gap = px(body, /gap: (\d+),/);
		const askRow = 34;
		// The line under the editor: 13 px of text, and the safety level's
		// button (the shell's small button, 26 px) held to the line by
		// negative margins on its anchor, so it adds no height while its
		// click target stays 26 px (live run at 28159f633: a bare 26 px
		// button cost 13 px and clipped the tenth row).
		const anchor = block('safetyAnchor');
		const pull = px(anchor, /margin: '-(\d+)px 0'/);
		const willRun = Math.max(13, 26 - 2 * pull);
		assert.ok(26 >= 24, 'the button keeps a 24 px target');
		assert.ok(willRun <= 14, `the line is ${willRun} px`);
		const inner = 666 - Number(pad?.[1]) - Number(pad?.[2]);
		const needed = askRow + editor + willRun + results + 3 * gap;
		assert.ok(needed + 4 <= inner, `${needed} px needed, ${inner} px there (4 px to spare)`);
		assert.doesNotMatch(block('willRun'), /paddingTop/);
	});

	it('the line under the editor never wraps: its text ellipsizes, the full text is in the title', () => {
		const text = block('willRunText');
		assert.match(text, /whiteSpace: 'nowrap'/);
		assert.match(text, /textOverflow: 'ellipsis'/);
		assert.match(text, /minWidth: 0/);
		assert.match(query, /<span style=\{styles\.willRunText\} title=\{preview\.text\}>\{preview\.text\}<\/span>/);
		assert.match(query, /<span ref=\{safetyAnchorRef\} style=\{styles\.safetyAnchor\}>/);
		assert.match(query, /<GatedButton\s+variant="ghost"\s+small\s+ariaExpanded=\{safetyMenuOpen\}/);
	});

	it('the result notes ride the results header line, not a line under the grid', () => {
		const header = /actions=\{\s*<span style=\{styles\.meta\}>([\s\S]*?)<\/span>\s*\}\s*columns=\{columns\}/.exec(query);
		assert.ok(header, 'results header not found');
		assert.match(header[1]!, /\{showPrecisionNote && <span>\{PRECISION_NOTE\}<\/span>\}/);
		assert.match(header[1]!, /\{showMergedNote && <span>\{MERGED_COLUMNS_NOTE\}<\/span>\}/);
		assert.equal((query.match(/showPrecisionNote &&/g) ?? []).length, 1);
	});
});

describe('the diagram', () => {
	const diagram = src('views', 'DiagramView.tsx');

	it('gives the root and the empty-state wrapper a definite height', () => {
		for (const name of ['root', 'emptyWrap']) {
			const block = new RegExp(`${name}: \\{([\\s\\S]*?)\\} as CSSProperties`).exec(diagram);
			assert.ok(block, `${name} style not found`);
			assert.match(block[1]!, /height: '100%'/, `${name} has no height`);
			assert.match(block[1]!, /minHeight: 0/, `${name} has no minHeight`);
		}
	});

	it('draws the minimap with theme tints, not a solid selection blue (live bug 9)', () => {
		const minimap = /<MiniMap([\s\S]*?)\/>/.exec(diagram);
		assert.ok(minimap, 'MiniMap not found');
		assert.doesNotMatch(minimap[1]!, /--rr-bg-list-active/);
		assert.match(minimap[1]!, /maskColor="color-mix\(in srgb, var\(--rr-text-primary\) 8%, transparent\)"/);
		assert.match(minimap[1]!, /nodeColor="color-mix\(in srgb, var\(--rr-color-info\) 30%, var\(--rr-bg-paper\)\)"/);
	});

	it('keeps its toolbar above the canvas, so no table sits under it (live L1)', () => {
		const toolbar = /\ttoolbar: \{([\s\S]*?)\} as CSSProperties/.exec(diagram);
		assert.ok(toolbar, 'toolbar style not found');
		assert.doesNotMatch(toolbar[1]!, /position: 'absolute'/);
		assert.match(/\troot: \{([\s\S]*?)\} as CSSProperties/.exec(diagram)![1]!, /flexDirection: 'column'/);
		const canvas = /\tcanvas: \{([\s\S]*?)\} as CSSProperties/.exec(diagram);
		assert.ok(canvas, 'canvas style not found');
		assert.match(canvas[1]!, /flex: 1/);
		assert.match(canvas[1]!, /minHeight: 0/);
		assert.match(diagram, /<div style=\{styles\.canvas\}>\s*<ReactFlow/);
	});

	it('opens a table when its node is clicked, through the prop', () => {
		assert.match(diagram, /onNodeClick=\{/);
		assert.match(diagram, /onOpenTable\(/);
		assert.ok(!/useSqlPageNav/.test(diagram), 'the diagram must not call useSqlPageNav');
	});

	it('colours the minimap from the theme', () => {
		const mini = /<MiniMap[\s\S]*?\/>/.exec(diagram);
		assert.ok(mini, 'MiniMap not found');
		for (const prop of ['nodeColor', 'maskColor', 'bgColor']) {
			// A theme variable, alone or mixed (a tint).
			assert.match(mini[0], new RegExp(`${prop}="[^"]*var\\(--rr-`), prop);
		}
	});

	it('says "Reading the schema" and "Could not read the schema"', () => {
		assert.match(diagram, /title="Reading the schema…"/);
		assert.match(diagram, /title="Could not read the schema"/);
		assert.ok(!/Reverse engineering/.test(diagram.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')), 'old wording remains');
	});
});
