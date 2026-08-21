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

/**
 * File-store commands: `store dir/type/write/rm/mkdir/stat`.
 *
 * Thin wrappers over the client's fs* methods with DOS-dir-style listing
 * output (kept byte-compatible with the Python CLI's `store dir`).
 */

import * as fs from 'fs';
import { Command } from 'commander';
import { addConnectionOptions, connectClient, runCliCommand } from '../common';

/**
 * Register the `store` command group on the program.
 *
 * @param program - The root commander program.
 */
export function registerStoreCommands(program: Command): void {
	const storeCmd = program.command('store').description('File store operations');

	// ── store dir ────────────────────────────────────────────────────────
	const dirCmd = storeCmd
		.command('dir [path]')
		.description('List directory contents')
		.action(async (dirPath, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectClient(options);
				const result = await client.fsListDir(dirPath || '');
				const entries = result.entries || [];
				if (entries.length === 0) {
					const stat = dirPath ? await client.fsStat(dirPath) : { exists: true, type: 'dir' as const };
					if (stat.exists && stat.type === 'dir') {
						out.line(`    ${(0).toLocaleString().padStart(8)} File(s)  ${(0).toLocaleString().padStart(14)} bytes`);
						out.line(`    ${(0).toLocaleString().padStart(8)} Dir(s)`);
					} else {
						out.line('File Not Found');
					}
					out.result({ path: dirPath || '', entries: [] });
					return 0;
				}
				let totalSize = 0;
				let fileCount = 0;
				let dirCount = 0;
				for (const e of entries) {
					let dateStr = '                   ';
					if (e.modified) {
						const d = new Date(e.modified * 1000);
						const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
						const dd = String(d.getUTCDate()).padStart(2, '0');
						const yyyy = d.getUTCFullYear();
						let hh = d.getUTCHours();
						const min = String(d.getUTCMinutes()).padStart(2, '0');
						const ampm = hh >= 12 ? 'PM' : 'AM';
						hh = hh % 12 || 12;
						dateStr = `${mm}/${dd}/${yyyy}  ${String(hh).padStart(2, '0')}:${min} ${ampm}`;
					}
					if (e.type === 'dir') {
						out.line(`${dateStr}    <DIR>          ${e.name}`);
						dirCount++;
					} else {
						const size = e.size ?? 0;
						totalSize += size;
						out.line(`${dateStr}    ${size.toLocaleString().padStart(14)} ${e.name}`);
						fileCount++;
					}
				}
				out.line(`    ${fileCount.toLocaleString().padStart(8)} File(s)  ${totalSize.toLocaleString().padStart(14)} bytes`);
				out.line(`    ${dirCount.toLocaleString().padStart(8)} Dir(s)`);
				out.result({ path: dirPath || '', entries });
				return 0;
			});
		});
	addConnectionOptions(dirCmd);

	// ── store type ───────────────────────────────────────────────────────
	const typeCmd = storeCmd
		.command('type <path>')
		.description('Display file contents')
		.action(async (filePath, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectClient(options);
				const text = await client.fsReadString(filePath);
				if (!out.jsonRequested) {
					process.stdout.write(text);
				}
				out.result({ path: filePath, content: text });
				return 0;
			});
		});
	addConnectionOptions(typeCmd);

	// ── store write ──────────────────────────────────────────────────────
	const writeCmd = storeCmd
		.command('write <path>')
		.description('Write a file')
		.option('--file <localFile>', 'Local file to upload')
		.option('--content <text>', 'Inline text content')
		.action(async (filePath, options) => {
			await runCliCommand(options, async (out) => {
				if (!options.file && options.content === undefined) {
					return out.fail('Either --file or --content is required');
				}
				const client = await connectClient(options);
				if (options.file) {
					// Stream the local file through the store handle API
					const { handle } = await client.fsOpen(filePath, 'w');
					try {
						const stream = fs.createReadStream(options.file);
						for await (const chunk of stream) {
							await client.fsWrite(handle, chunk as Uint8Array);
						}
						await client.fsClose(handle, 'w');
					} catch (err) {
						try {
							await client.fsClose(handle, 'w');
						} catch {
							/* best-effort */
						}
						throw err;
					}
				} else {
					await client.fsWriteString(filePath, options.content);
				}
				out.line(`Written: ${filePath}`);
				out.result({ path: filePath, written: true });
				return 0;
			});
		});
	addConnectionOptions(writeCmd);

	// ── store rm ─────────────────────────────────────────────────────────
	const rmCmd = storeCmd
		.command('rm <path>')
		.description('Delete a file')
		.action(async (filePath, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectClient(options);
				await client.fsDelete(filePath);
				out.line(`Deleted: ${filePath}`);
				out.result({ path: filePath, deleted: true });
				return 0;
			});
		});
	addConnectionOptions(rmCmd);

	// ── store mkdir ──────────────────────────────────────────────────────
	const mkdirCmd = storeCmd
		.command('mkdir <path>')
		.description('Create a directory')
		.action(async (dirPath, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectClient(options);
				await client.fsMkdir(dirPath);
				out.line(`Created: ${dirPath}/`);
				out.result({ path: dirPath, created: true });
				return 0;
			});
		});
	addConnectionOptions(mkdirCmd);

	// ── store stat ───────────────────────────────────────────────────────
	const statCmd = storeCmd
		.command('stat <path>')
		.description('Get file/directory metadata')
		.action(async (filePath, options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectClient(options);
				const result = await client.fsStat(filePath);
				if (!result.exists) {
					out.line(`${filePath}: not found`);
				} else {
					const details: string[] = [];
					if (result.size !== undefined) details.push(`size: ${result.size.toLocaleString()}`);
					if (result.modified) details.push(`modified: ${new Date(result.modified * 1000).toISOString()}`);
					out.line(`${filePath}: ${result.type}${details.length ? ` (${details.join(', ')})` : ''}`);
				}
				out.result({ path: filePath, ...result });
				return 0;
			});
		});
	addConnectionOptions(statCmd);
}
