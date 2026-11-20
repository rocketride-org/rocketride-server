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
// README CLAIMS — the final round's lines
// =============================================================================
//
// Lines the devil's advocate's final round found inaccurate or missing, pinned
// to the code that makes them true: which keys count as binary, where a lower
// safety level asks, what text matching does before the database is known,
// that saved connections are last-writer-wins across windows, and which
// column widths a grid keeps.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isBinarySqlType } from '../src/sql/resultTypes';
import { textMatchHint } from '../src/sql/filters';
import { MIN_SAVED_WIDTH } from '../src/sql/gridLayout';

const prose = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');

describe('README claims: the final round', () => {
	it('lists the binary key types as reflected, and says a VARCHAR(n) BINARY key stays editable', () => {
		assert.match(prose, /binary column \(`binary`, `varbinary`, the blob types, `bytea`, `bit` or `varbit`\)/);
		assert.match(prose, /A MySQL `VARCHAR\(n\) BINARY` key is not one of these: the database reports it as text with a `_bin` collation, so it stays editable\./);
		// MySQL reflects VARCHAR(n) BINARY with a quoted _bin collation: no binary token.
		assert.equal(isBinarySqlType('VARCHAR(20) COLLATE "utf8mb4_bin"'), false);
		assert.equal(isBinarySqlType('VARCHAR(20) COLLATE utf8mb4_bin'), false);
	});

	it('says a lower level asks first in both places that set it', () => {
		assert.match(prose, /Lowering the level asks first, from the Query page or the connection editor\./);
	});

	it('says text matching follows the database\'s own LIKE until the database is known', () => {
		assert.match(prose, /Until the app knows the database, text matches follow the database's own `LIKE`\./);
		assert.match(textMatchHint('unknown'), /until the database is known/);
	});

	it('says saved connections are last-writer-wins across windows', () => {
		assert.match(prose, /Change connections in one window at a time: each window writes the whole list it holds, so the last to save wins, an older safety level included\./);
	});

	it('says which column widths a grid keeps', () => {
		assert.equal(MIN_SAVED_WIDTH, 60);
		assert.match(prose, /\(a column that stretches to fit is not kept at a width, and neither is a width under 60 px\)/);
	});
});
