// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// FILE TYPES: the allowlist, type labels and sizes
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOWED_EXTENSIONS, extensionOf, fileTypeOf, formatSize, isAllowedFile, mimeTypeOf } from '../src/vector/fileType';

test('the allowlist: PDF, DOCX, PPTX, XLSX, ODT, RTF, TXT, MD, CSV, HTML, JSON, matched case-insensitively', () => {
	assert.deepEqual([...ALLOWED_EXTENSIONS], ['pdf', 'docx', 'pptx', 'xlsx', 'odt', 'rtf', 'txt', 'md', 'csv', 'html', 'json']);
	assert.equal(isAllowedFile('Report.PDF'), true);
	assert.equal(isAllowedFile('notes.md'), true);
	assert.equal(isAllowedFile('archive.tar.gz'), false);
	assert.equal(isAllowedFile('noextension'), false);
	assert.equal(isAllowedFile('.md'), false, 'a dot file is not a markdown file');
	assert.equal(extensionOf('C:\\a.b\\c'), null, 'a dot in a folder name is not an extension');
	assert.equal(extensionOf('C:/demo/handbook.MD'), 'md');
});

test('type labels and MIME types for the directory and the upload', () => {
	assert.equal(fileTypeOf('C:/demo/finance/budget_2026.xlsx'), 'Excel workbook');
	assert.equal(fileTypeOf('report.pdf'), 'PDF');
	assert.equal(fileTypeOf('unknown.bin'), 'File');
	assert.equal(mimeTypeOf('a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
	assert.equal(mimeTypeOf('a.md'), 'text/markdown');
	assert.equal(mimeTypeOf('a.exe'), undefined);
});

test('sizes in binary units, en-US', () => {
	assert.equal(formatSize(0), '0 B');
	assert.equal(formatSize(7419), '7.2 KB');
	assert.equal(formatSize(1048211), '1,023.6 KB', 'just under 1 MiB');
	assert.equal(formatSize(1048576), '1 MB');
	assert.equal(formatSize(52428800), '50 MB');
	assert.equal(formatSize(null), '—');
});
