/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { uploadAttachment, CHUNK_SIZE } from './uploadAttachment';

describe('uploadAttachment', () => {
	function mkClient() {
		let nextHandle = 0;
		const writes: Array<{ handle: string; bytes: Uint8Array }> = [];
		return {
			writes,
			async fsOpen(_path: string, _mode: 'r' | 'w') { return { handle: `h${++nextHandle}` }; },
			async fsWrite(handle: string, bytes: Uint8Array) { writes.push({ handle, bytes }); return bytes.byteLength; },
			async fsClose(_h: string, _m: 'r' | 'w') {},
		};
	}

	test('uploads bytes in CHUNK_SIZE pieces and returns an Attachment with correct metadata', async () => {
		const client = mkClient();
		const bytes = new Uint8Array(CHUNK_SIZE * 2 + 17).map((_, i) => i % 256);
		const file = new File([bytes], 'shot.png', { type: 'image/png' });

		const att = await uploadAttachment({ client, chatId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', file });

		expect(att.mime).toBe('image/png');
		expect(att.filename).toBe('shot.png');
		expect(att.size_bytes).toBe(bytes.byteLength);
		expect(att.path).toMatch(/^\.chats\/aaaaaaaa-.*\/[0-9a-f-]+\.png$/);
		expect(att.attachment_id).toMatch(/^[0-9a-f-]{36}$/);

		expect(client.writes).toHaveLength(3);
		expect(client.writes[0].bytes.byteLength).toBe(CHUNK_SIZE);
		expect(client.writes[1].bytes.byteLength).toBe(CHUNK_SIZE);
		expect(client.writes[2].bytes.byteLength).toBe(17);
	});

	test('files at or below CHUNK_SIZE upload in one chunk', async () => {
		const client = mkClient();
		const bytes = new Uint8Array(CHUNK_SIZE).fill(7);
		const file = new File([bytes], 'tiny.bin', { type: 'application/octet-stream' });
		await uploadAttachment({ client, chatId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', file });
		expect(client.writes).toHaveLength(1);
		expect(client.writes[0].bytes.byteLength).toBe(CHUNK_SIZE);
	});

	test('closes the handle on failure mid-upload (no leaked handle)', async () => {
		const closes: string[] = [];
		const client = {
			async fsOpen() { return { handle: 'h1' }; },
			async fsWrite() { throw new Error('network'); },
			async fsClose(handle: string) { closes.push(handle); },
		};
		const file = new File([new Uint8Array(10)], 'x.bin', { type: 'application/octet-stream' });
		await expect(uploadAttachment({ client, chatId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', file })).rejects.toThrow('network');
		expect(closes).toEqual(['h1']);
	});
});
