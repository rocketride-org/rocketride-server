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
// EXPORT — a result as CSV, JSON or Markdown, downloaded or copied
// =============================================================================
//
// The results card has its own Export button: CSV and JSON download, and
// Markdown is copied. Where downloads are refused (a VS Code webview), CSV
// and JSON are copied instead and the announcement says so. Every format
// follows the statement's CAPTURED columns, never the keys a row object has
// gained from the grid.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deliverExport, exportFileName, exportResult, toCsv, toJson, toMarkdown } from '../src/sql/export';

const view = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'views', 'QueryView.tsx'), 'utf8');

describe('toCsv', () => {
	it('writes a header and one CRLF-separated line per row, in column order', () => {
		assert.equal(toCsv(['id', 'name'], [{ name: 'a', id: 1 }, { id: 2, name: 'b' }]), 'id,name\r\n1,a\r\n2,b');
	});

	it('quotes a field holding a comma, a quote or a line break, doubling the quote', () => {
		assert.equal(toCsv(['v'], [{ v: 'a,b' }, { v: 'say "hi"' }, { v: 'two\nlines' }, { v: 'cr\rhere' }]), 'v\r\n"a,b"\r\n"say ""hi"""\r\n"two\nlines"\r\n"cr\rhere"');
		assert.equal(toCsv(['a,b'], []), '"a,b"');
	});

	it('writes NULL as an empty field and an empty string as "", so the two stay apart', () => {
		assert.equal(toCsv(['a', 'b', 'c'], [{ a: null, b: '', c: undefined }]), 'a,b,c\r\n,"",');
	});

	it('writes objects and arrays as JSON text, quoted', () => {
		assert.equal(toCsv(['doc', 'tags'], [{ doc: { k: 1, s: 'x' }, tags: [1, 2] }]), 'doc,tags\r\n"{""k"":1,""s"":""x""}","[1,2]"');
	});

	it('writes numbers and booleans as they are', () => {
		assert.equal(toCsv(['n', 'f', 'b'], [{ n: 42, f: 0.5, b: true }]), 'n,f,b\r\n42,0.5,true');
	});

	it('puts a \' before text that a spreadsheet would run as a formula (= + - @, tab, CR)', () => {
		assert.equal(
			toCsv(['v'], [{ v: '=1+1' }, { v: '+1' }, { v: '-2' }, { v: '@SUM(A1)' }, { v: '\tx' }, { v: '\rx' }, { v: '=HYPERLINK("http://x")' }]),
			'v\r\n\'=1+1\r\n\'+1\r\n\'-2\r\n\'@SUM(A1)\r\n\'\tx\r\n"\'\rx"\r\n"\'=HYPERLINK(""http://x"")"',
		);
	});

	it('leaves numbers, and text that only contains those characters later, alone', () => {
		assert.equal(toCsv(['n', 's'], [{ n: -5, s: 'a=b' }, { n: 1.5, s: 'x-1' }]), 'n,s\r\n-5,a=b\r\n1.5,x-1');
	});

	it('guards CSV only: JSON and Markdown keep the text as it is', () => {
		assert.deepEqual(JSON.parse(toJson(['v'], [{ v: '=1+1' }])), [{ v: '=1+1' }]);
		assert.equal(toMarkdown(['v'], [{ v: '=1+1' }]), '| v |\n| --- |\n| =1+1 |');
	});

	it('ignores keys that are not columns (the grid writes some into the rows it renders)', () => {
		assert.equal(toCsv(['id'], [{ id: 1, extra: undefined }]), 'id\r\n1');
	});
});

describe('toJson', () => {
	it('is an array of objects in column order, with a missing value as null', () => {
		const text = toJson(['id', 'name', 'doc'], [{ name: 'a', id: 1, doc: { k: [1] }, extra: undefined }, { id: 2 }]);
		const parsed = JSON.parse(text) as Record<string, unknown>[];
		assert.deepEqual(parsed, [{ id: 1, name: 'a', doc: { k: [1] } }, { id: 2, name: null, doc: null }]);
		assert.deepEqual(Object.keys(parsed[0] as object), ['id', 'name', 'doc']);
	});
});

describe('toMarkdown', () => {
	it('is a pipe table with a header separator', () => {
		assert.equal(toMarkdown(['id', 'name'], [{ id: 1, name: 'a' }]), '| id | name |\n| --- | --- |\n| 1 | a |');
	});

	it('escapes pipes, turns line breaks into <br> and spells NULL', () => {
		assert.equal(toMarkdown(['v', 'n'], [{ v: 'a|b\nc', n: null }]), '| v | n |\n| --- | --- |\n| a\\|b<br>c | NULL |');
	});

	it('writes objects as JSON text', () => {
		assert.equal(toMarkdown(['doc'], [{ doc: { k: 1 } }]), '| doc |\n| --- |\n| {"k":1} |');
	});
});

describe('exportResult and exportFileName', () => {
	it('names the type and the extension per format', () => {
		assert.deepEqual(
			[exportResult('csv', ['a'], []).mime, exportResult('json', ['a'], []).mime, exportResult('markdown', ['a'], []).mime],
			['text/csv;charset=utf-8', 'application/json', 'text/markdown;charset=utf-8'],
		);
		assert.equal(exportFileName('Query 3', 1, 'csv'), 'query-3-statement-2.csv');
		assert.equal(exportFileName('  Orders / daily  ', 0, 'json'), 'orders-daily-statement-1.json');
		assert.equal(exportFileName('', 0, 'markdown'), 'query-statement-1.md');
	});
});

describe('deliverExport', () => {
	/**
	 * A delivery spy.
	 *
	 * @param opts - How the fakes behave.
	 * @param opts.refused - Downloads are refused here.
	 * @param opts.downloadThrows - The download fails.
	 * @param opts.copyFails - The clipboard refuses.
	 * @returns The deps and what they saw.
	 */
	const spy = (opts: { refused?: boolean; downloadThrows?: boolean; copyFails?: boolean } = {}) => {
		const seen = { downloaded: [] as string[], copied: [] as string[] };
		return {
			seen,
			deps: {
				downloadsRefused: opts.refused === true,
				download: (text: string, _mime: string, name: string) => {
					if (opts.downloadThrows) throw new Error('blocked');
					seen.downloaded.push(`${name}:${text}`);
				},
				copy: async (text: string) => {
					if (opts.copyFails) throw new Error('denied');
					seen.copied.push(text);
				},
			},
		};
	};
	const csv = { ...exportResult('csv', ['a'], [{ a: 1 }]), fileName: 'q.csv' };
	const md = { ...exportResult('markdown', ['a'], [{ a: 1 }]), fileName: 'q.md' };

	it('downloads CSV and JSON where downloads work', async () => {
		const { seen, deps } = spy();
		assert.equal(await deliverExport(csv, deps), 'downloaded');
		assert.deepEqual(seen.downloaded, ['q.csv:a\r\n1']);
		assert.deepEqual(seen.copied, []);
	});

	it('copies instead where downloads are refused (VS Code webviews)', async () => {
		const { seen, deps } = spy({ refused: true });
		assert.equal(await deliverExport(csv, deps), 'copied');
		assert.deepEqual(seen.copied, ['a\r\n1']);
		assert.deepEqual(seen.downloaded, []);
	});

	it('copies when the download itself fails', async () => {
		const { seen, deps } = spy({ downloadThrows: true });
		assert.equal(await deliverExport(csv, deps), 'copied');
		assert.deepEqual(seen.copied, ['a\r\n1']);
	});

	it('always copies Markdown', async () => {
		const { seen, deps } = spy();
		assert.equal(await deliverExport(md, deps), 'copied');
		assert.deepEqual(seen.copied, ['| a |\n| --- |\n| 1 |']);
	});

	it('reports a failure when the clipboard refuses too', async () => {
		const { deps } = spy({ refused: true, copyFails: true });
		assert.equal(await deliverExport(csv, deps), 'failed');
	});
});

describe('QueryView: the Export button', () => {
	it('is a visible button on the results card, in place of the gear-menu hint', () => {
		assert.doesNotMatch(view, /Export: grid menu \(gear\)/);
		assert.match(view, /ariaExpanded=\{exportOpen\}/);
		assert.match(view, />\s*Export\s*</);
	});

	it('exports the shown statement\'s own rows by its captured columns', () => {
		assert.match(view, /exportResult\(format, resultCols, rows\)/);
	});

	it('moves focus into the menu (a portal) when it opens, and back to the button when it closes from the keyboard', () => {
		assert.match(view, /requestAnimationFrame\(\(\) => exportMenuRef\.current\?\.querySelector\('button'\)\?\.focus\(\)\)/);
		assert.match(view, /if \(event\.key === 'Escape'\) exportAnchorRef\.current\?\.querySelector\('button'\)\?\.focus\(\);/);
	});

	it('says a download started (a blocked one cannot be detected), and says the CSV guard in the menu', () => {
		assert.match(view, /announce\(`Download started: \$\{what\}`\)/);
		assert.doesNotMatch(view, /`Downloaded /);
		assert.match(view, /CSV_FORMULA_NOTE/);
	});

	it('copies instead of downloading in a VS Code webview', () => {
		assert.match(view, /const copiesExports = useMemo\(\(\) => isInVSCode\(\), \[\]\);/);
		assert.match(view, /downloadsRefused: copiesExports/);
	});
});

describe('the README on export', () => {
	it('says CSV guards formula text, and that JSON and Markdown do not change it', () => {
		const readme = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');
		assert.match(readme, /text that starts with `=`, `\+`, `-` or `@` \(or a tab or a carriage return\) gets a leading `'`/);
		assert.match(readme, /JSON and Markdown keep the text as it is/);
	});
});

describe('browserDownload', () => {
	const exportSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'sql', 'export.ts'), 'utf8');

	it('releases the object URL after the click has been handled, not during it', () => {
		assert.match(exportSource, /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), DOWNLOAD_URL_LIFETIME_MS\);/);
	});

	it('adds no byte-order mark', () => {
		assert.doesNotMatch(exportSource, /\\uFEFF|\uFEFF/);
	});
});
