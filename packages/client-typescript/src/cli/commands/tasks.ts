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
 * Task lifecycle commands: start, stop, upload, list.
 *
 * All output is plain, line-oriented, append-only text (or `--json`) —
 * continuous monitoring belongs to the platform's monitor apps, not the
 * CLI.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as glob from 'glob';
import { Command } from 'commander';
import { DAPMessage, UPLOAD_RESULT } from '../../client/types';
import { addConnectionOptions, connectClient, loadPipelineConfig, runCliCommand, formatSize } from '../common';

/**
 * Expand file arguments (files, directories, glob patterns) into a
 * de-duplicated list of absolute file paths.
 *
 * @param patterns - CLI file arguments.
 * @returns Absolute paths of every matched file.
 */
function findFiles(patterns: string[]): string[] {
	const files: string[] = [];
	for (const pattern of patterns) {
		const fullPath = path.resolve(pattern);
		try {
			const stat = fs.statSync(fullPath);
			if (stat.isFile()) {
				files.push(fullPath);
			} else if (stat.isDirectory()) {
				const dirFiles = glob.sync(path.join(fullPath, '**/*'), { nodir: true });
				files.push(...dirFiles.map((f) => path.resolve(f)));
			}
		} catch {
			// Not a literal path — treat as a glob pattern
			const matches = glob.sync(pattern, { nodir: true });
			files.push(...matches.map((f) => path.resolve(f)));
		}
	}
	return [...new Set(files)];
}

/**
 * Split a file list into readable files and per-file error strings.
 *
 * @param filesList - Absolute paths to validate.
 * @returns Tuple of [valid paths, error messages].
 */
function validateFiles(filesList: string[]): [string[], string[]] {
	const validFiles: string[] = [];
	const invalidFiles: string[] = [];
	for (const filepath of filesList) {
		try {
			if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
				// Open/close to surface permission problems before upload
				const fd = fs.openSync(filepath, 'r');
				fs.closeSync(fd);
				validFiles.push(filepath);
			} else {
				invalidFiles.push(`File not found: ${path.basename(filepath)}`);
			}
		} catch (error) {
			invalidFiles.push(`Cannot read ${path.basename(filepath)}: ${error}`);
		}
	}
	return [validFiles, invalidFiles];
}

/**
 * Register the task lifecycle commands on the program.
 *
 * @param program - The root commander program.
 */
export function registerTaskCommands(program: Command): void {
	// ── start ────────────────────────────────────────────────────────────
	const startCmd = program
		.command('start')
		.description('Start a new pipeline')
		.option('--pipeline <file>', 'Path to pipeline configuration file (can use ROCKETRIDE_PIPELINE in .env or env var)', process.env.ROCKETRIDE_PIPELINE)
		.option('--token <token>', 'Optional existing task token for pipeline resume/control (can use ROCKETRIDE_TOKEN in .env or env var)', process.env.ROCKETRIDE_TOKEN)
		.option('--threads <num>', 'Number of threads to use for pipeline execution', '4')
		.option('--args <args...>', 'Additional arguments to pass to pipeline execution')
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				if (!options.pipeline) {
					return out.fail('Pipeline file is required for the start command', 'pass --pipeline or set ROCKETRIDE_PIPELINE in .env');
				}
				const pipelineData = loadPipelineConfig(options.pipeline);
				out.line(`Starting pipeline from ${options.pipeline}...`);
				const client = await connectClient(options);
				const result = await client.use({
					pipeline: pipelineData,
					threads: parseInt(options.threads, 10),
					token: options.token,
					args: options.args || [],
				});
				const token = result.token;
				out.line('Pipeline started.');
				out.line(`Token: ${token}`);
				out.line(`Stop it with: rocketride stop --token ${token}`);
				out.result({ token });
				return 0;
			});
		});
	addConnectionOptions(startCmd);

	// ── stop ─────────────────────────────────────────────────────────────
	const stopCmd = program
		.command('stop')
		.description('Stop a running task')
		.option('--token <token>', 'Task token to stop (can use ROCKETRIDE_TOKEN in .env or env var)', process.env.ROCKETRIDE_TOKEN)
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				if (!options.token) {
					return out.fail('Token is required for the stop command', 'pass --token or set ROCKETRIDE_TOKEN in .env');
				}
				const client = await connectClient(options);
				await client.terminate(options.token);
				out.line(`Task ${options.token} terminated.`);
				out.result({ token: options.token, terminated: true });
				return 0;
			});
		});
	addConnectionOptions(stopCmd);

	// ── list ─────────────────────────────────────────────────────────────
	const listCmd = program
		.command('list')
		.description('List all active tasks')
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectClient(options);
				const tasks = await client.getTasks();
				if (tasks.length === 0) {
					out.line('No active tasks found');
				} else {
					out.line(`Found ${tasks.length} active task(s):`);
					out.line('');
					tasks.forEach((task, i) => {
						out.line(`Task ${i + 1}:`);
						out.line(`  Name: ${String(task.name ?? 'N/A')}`);
						out.line(`  Token: ${String(task.token ?? 'N/A')}`);
						out.line(`  Source: ${String(task.source ?? 'N/A')}`);
						out.line(`  Status: ${String(task.status ?? 'N/A')}`);
						const description = String(task.description ?? '');
						if (description && description !== 'N/A') {
							out.line(`  Description: ${description}`);
						}
						out.line('');
					});
				}
				out.result({ tasks });
				return 0;
			});
		});
	addConnectionOptions(listCmd);

	// ── upload ───────────────────────────────────────────────────────────
	const uploadCmd = program
		.command('upload')
		.description('Upload files using --pipeline or an existing task token')
		.argument('<files...>', 'Files, wildcards, or directories to upload')
		.option('--pipeline <file>', 'Pipeline file to start new task (can use ROCKETRIDE_PIPELINE in .env or env var)', process.env.ROCKETRIDE_PIPELINE)
		.option('--token <token>', 'Existing task token to use for uploads (can use ROCKETRIDE_TOKEN in .env or env var)', process.env.ROCKETRIDE_TOKEN)
		.option('--threads <num>', 'Number of threads to use for pipeline execution', '4')
		.option('--max-concurrent <num>', 'Maximum number of concurrent file uploads', '5')
		.option('--args <args...>', 'Additional arguments to pass to pipeline execution')
		.action(async (files, options) => {
			await runCliCommand(options, async (out) => {
				if (!options.pipeline && !options.token) {
					return out.fail('Either --pipeline or --token must be specified for the upload command', 'pass one of them or set ROCKETRIDE_PIPELINE/ROCKETRIDE_TOKEN in .env');
				}
				const maxConcurrent = Number(options.maxConcurrent || '5');
				if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
					return out.fail('--max-concurrent must be a positive integer');
				}

				// step: expand and validate the file arguments
				const allFiles = findFiles(files);
				if (allFiles.length === 0) {
					return out.fail('No files found matching the specified patterns');
				}
				const [validFiles, invalidFiles] = validateFiles(allFiles);
				for (const error of invalidFiles) {
					out.line(`skipped  ${error}`);
				}
				if (validFiles.length === 0) {
					return out.fail('No valid files found');
				}
				out.line(`Uploading ${validFiles.length} file(s)...`);

				// step: per-file progress lines from upload events (append-only)
				const onEvent = async (message: DAPMessage): Promise<void> => {
					if ((message.event || '') !== 'apaevt_status_upload') return;
					const body = (message.body || {}) as Record<string, unknown>;
					const action = String(body.action || '');
					const name = path.basename(String(body.filepath || 'unknown'));
					if (action === 'complete') {
						out.line(`uploaded ${name} (${formatSize(Number(body.file_size) || 0)})`);
					} else if (action === 'error') {
						out.line(`failed   ${name}: ${String(body.error || 'Unknown error')}`);
					}
				};
				const client = await connectClient(options, onEvent);

				// step: resolve the task token (start a pipeline when asked to)
				let taskToken: string | undefined = options.token;
				const managePipeline = Boolean(options.pipeline) && !options.token;
				if (managePipeline) {
					const pipelineConfig = loadPipelineConfig(options.pipeline);
					const useResult = await client.use({
						pipeline: pipelineConfig,
						threads: parseInt(options.threads, 10),
						token: 'UPLOAD_TASK',
						args: options.args || [],
					});
					taskToken = useResult.token;
				}

				// step: send the files and collect per-file results
				const startTime = Date.now();
				const fileObjects = validFiles.map((filePath) => {
					const stats = fs.statSync(filePath);
					const content = fs.readFileSync(filePath);
					return {
						file: new File([content], path.basename(filePath), {
							type: 'application/octet-stream',
							lastModified: stats.mtimeMs,
						}),
						objinfo: { filepath: filePath, size: stats.size },
					};
				});
				let results: UPLOAD_RESULT[];
				try {
					results = await client.sendFiles(fileObjects, taskToken!, maxConcurrent);
				} finally {
					// step: tear down a pipeline this command started — in a
					// finally so a failed send never strands the pipeline
					if (managePipeline && taskToken) {
						try {
							await client.terminate(taskToken);
						} catch (error) {
							out.line(`warning: failed to terminate upload pipeline: ${error}`);
						}
					}
				}
				const elapsedSeconds = (Date.now() - startTime) / 1000;

				// step: summarize
				const succeeded = results.filter((r) => r.action === 'complete');
				const failed = results.filter((r) => r.action !== 'complete');
				const totalBytes = succeeded.reduce((sum, r) => sum + (r.file_size || 0), 0);
				out.line('');
				out.line(`Uploaded ${succeeded.length} of ${results.length} file(s), ${formatSize(totalBytes)} in ${elapsedSeconds.toFixed(1)}s.`);
				if (failed.length > 0) {
					out.line(`Failed: ${failed.length} file(s).`);
				}
				out.result({
					uploaded: succeeded.length,
					failed: failed.length,
					totalBytes,
					elapsedSeconds,
					files: results.map((r) => ({
						filepath: r.filepath,
						action: r.action,
						size: r.file_size,
						...(r.error ? { error: r.error } : {}),
					})),
					...(invalidFiles.length > 0 ? { skipped: invalidFiles } : {}),
				});
				return failed.length > 0 ? 1 : 0;
			});
		});
	addConnectionOptions(uploadCmd);
}
