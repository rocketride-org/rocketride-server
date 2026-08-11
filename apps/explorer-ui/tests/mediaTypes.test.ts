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
// MEDIA TYPES — unit tests for the extension → viewer mapping
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getMediaInfo } from '../src/mediaTypes';

describe('getMediaInfo', () => {
	it('maps known extensions to the right category and content mode', () => {
		assert.deepEqual(getMediaInfo('photo.png'), { category: 'image', mime: 'image/png', contentMode: 'blob' });
		assert.equal(getMediaInfo('clip.mp4').category, 'video');
		assert.equal(getMediaInfo('clip.mp4').contentMode, 'link'); // streamed, not prefetched
		assert.equal(getMediaInfo('song.mp3').category, 'audio');
		assert.equal(getMediaInfo('data.json').category, 'json');
		assert.equal(getMediaInfo('data.json').contentMode, 'inline'); // read as text
		assert.equal(getMediaInfo('notes.md').category, 'markdown');
		assert.equal(getMediaInfo('main.ts').category, 'code');
		assert.equal(getMediaInfo('report.pdf').category, 'pdf');
		assert.equal(getMediaInfo('sheet.xlsx').category, 'spreadsheet');
		assert.equal(getMediaInfo('doc.docx').category, 'docx');
		assert.equal(getMediaInfo('archive.zip').category, 'binary');
	});

	it('is case-insensitive on the extension', () => {
		assert.equal(getMediaInfo('IMG.PNG').category, 'image');
		assert.equal(getMediaInfo('DATA.JSON').category, 'json');
	});

	it('resolves the extension from the last dot in a path', () => {
		assert.equal(getMediaInfo('src/config/app.pipe').category, 'json');
		assert.equal(getMediaInfo('backup.tar.gz').category, 'binary'); // .gz, not .tar
	});

	it('falls back to inline plain text for unknown or extensionless files', () => {
		assert.deepEqual(getMediaInfo('README'), { category: 'text', mime: 'text/plain', contentMode: 'inline' });
		assert.deepEqual(getMediaInfo('mystery.xyz'), { category: 'text', mime: 'text/plain', contentMode: 'inline' });
	});
});
