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

import type { Attachment } from '../types/Attachment';

/** 2 MB — half of FileStore.MAX_CHUNK_SIZE (4 MB) to leave protocol headroom. */
export const CHUNK_SIZE = 2 * 1024 * 1024;

/**
 * Minimal slice of the RocketRide client surface required to upload a file
 * via the chunked filestore protocol. Kept structural so tests can pass a
 * lightweight stub without depending on the full SDK.
 */
export interface UploadClient {
	fsOpen(path: string, mode: 'r' | 'w'): Promise<{ handle: string; size?: number }>;
	fsWrite(handle: string, bytes: Uint8Array): Promise<number>;
	fsClose(handle: string, mode: 'r' | 'w'): Promise<void>;
}

/**
 * Derive a sensible file extension from the filename, falling back to the
 * MIME subtype when the filename is bare. Always lowercase, never empty.
 */
function extFromFilename(filename: string, mime: string): string {
	const dot = filename.lastIndexOf('.');
	if (dot >= 0 && dot < filename.length - 1) return filename.slice(dot + 1).toLowerCase();
	return mime.split('/')[1]?.split(';')[0] ?? 'bin';
}

/**
 * Upload a single file to the user's filestore under the chat's directory
 * using chunked `fsOpen` / `fsWrite` / `fsClose` calls, and return an
 * `Attachment` record ready to attach to a `chat.send()` turn.
 *
 * The handle is always closed (success or failure) to avoid leaks on the
 * server side.
 */
export async function uploadAttachment(opts: {
	client: UploadClient;
	chatId: string;
	file: File;
}): Promise<Attachment> {
	const { client, chatId, file } = opts;
	const attachment_id = crypto.randomUUID();
	const mime = file.type || 'application/octet-stream';
	const ext = extFromFilename(file.name, mime);
	const path = `.chats/${chatId}/${attachment_id}.${ext}`;
	const bytes = new Uint8Array(await file.arrayBuffer());

	// METRIC attachment.upload_start — fired before the first write so
	// the orphan-volume signal (upload_starts − Σ count_per_message)
	// is computable from production logs without a reaper in v1.
	// Privacy: MIME + size only, never filename.
	console.info(
		`METRIC attachment.upload_start mime=${mime} size_bytes=${bytes.byteLength}`,
	);
	// METRIC attachment.bytes — histogram bucket source.
	console.info(`METRIC attachment.bytes size_bytes=${bytes.byteLength}`);

	const { handle } = await client.fsOpen(path, 'w');
	try {
		for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
			const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
			await client.fsWrite(handle, chunk);
		}
	} catch (err) {
		// METRIC attachment.upload_error — MIME + error class only.
		console.info(
			`METRIC attachment.upload_error mime=${mime} error_class=${err instanceof Error ? err.constructor.name : 'Unknown'}`,
		);
		throw err;
	} finally {
		await client.fsClose(handle, 'w');
	}

	return {
		attachment_id,
		mime,
		filename: file.name,
		size_bytes: bytes.byteLength,
		path,
	};
}
