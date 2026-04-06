#!/usr/bin/env node

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
 * RocketRide Unified CLI Client.
 *
 * This module provides a comprehensive command-line interface for managing RocketRide pipelines,
 * uploading files, monitoring task status, and controlling pipeline execution using the
 * Debug Adapter Protocol (DAP).
 *
 * Features:
 * - Start and manage RocketRide data processing pipelines
 * - Upload files with parallel processing and progress tracking
 * - Monitor real-time pipeline status and metrics
 * - Stop running pipelines gracefully
 * - Environment-based configuration via .env files
 *
 * Configuration:
 * The client supports configuration via .env file with the following variables:
 * - ROCKETRIDE_APIKEY: Your RocketRide API key (required for authentication)
 * - ROCKETRIDE_URI: The RocketRide server URI (defaults to wss://cloud.rocketride.ai)
 * - ROCKETRIDE_PIPELINE: Path to your default pipeline configuration file
 * - ROCKETRIDE_TOKEN: Task token for existing pipelines
 *
 * Commands:
 * - start: Start a new pipeline from configuration file
 * - upload: Upload files to a pipeline (with --pipeline or --token)
 * - status: Monitor real-time status of a running pipeline
 * - stop: Terminate a running pipeline gracefully
 *
 * @example
 * ```bash
 * # Start a pipeline
 * rocketride start --pipeline ./my-pipeline.json --apikey YOUR_KEY
 *
 * # Upload files with progress tracking
 * rocketride upload files/*.csv --pipeline ./pipeline.json --max-concurrent 10
 *
 * # Monitor pipeline status
 * rocketride status --token TASK_TOKEN
 *
 * # Stop a pipeline
 * rocketride stop --token TASK_TOKEN
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import * as glob from 'glob';
import * as process from 'process';
import { Command } from 'commander';
import { RocketRideClient } from '../client/client';
import { DAPMessage, PipelineConfig, UPLOAD_RESULT } from '../client/types';
import { CONST_DEFAULT_WEB_LOCAL } from '../client/constants';

// ANSI Color and Control Codes for terminal formatting
const ANSI_RESET = '\x1b[0m';
const ANSI_RED = '\x1b[91m';
const ANSI_GREEN = '\x1b[92m';
const ANSI_YELLOW = '\x1b[93m';
const ANSI_BLUE = '\x1b[94m';
const ANSI_GRAY = '\x1b[90m';

const ANSI_CLEAR_SCREEN = '\x1b[2J';
const ANSI_CURSOR_HOME = '\x1b[1;1H';

// Global character mapping
const CHR_TL = '┌';
const CHR_TR = '┐';
const CHR_BL = '└';
const CHR_BR = '┘';
const CHR_HORIZ = '─';
const CHR_VERT = '│';
const CHR_BLOCK = '█';
const CHR_LIGHT_BLOCK = '░';
const CHR_CHECK = '✓';
const CHR_CROSS = '✗';

const ESC = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(ESC + '\\[[0-9;]*[mK]', 'g');

class Box {
	private title: string;
	private lines: string[];
	private width: number;

	constructor(title: string, lines: string[], width: number = 75) {
		this.title = title;
		this.lines = lines || [];
		this.width = width;
	}

	private visualLength(text: string): number {
		return text.replace(ANSI_ESCAPE_PATTERN, '').length;
	}

	private boxTop(): string {
		const titlePart = ` ${this.title} `;
		const remainingWidth = this.width - 3 - titlePart.length;
		return CHR_TL + CHR_HORIZ + titlePart + CHR_HORIZ.repeat(Math.max(0, remainingWidth)) + CHR_TR;
	}

	private boxMiddle(content: string): string {
		const visualWidth = this.visualLength(content);
		const availableWidth = this.width - 3;

		let finalContent = content;
		if (visualWidth > availableWidth) {
			finalContent = content.substring(0, availableWidth - 3) + '...';
		}

		const padding = availableWidth - this.visualLength(finalContent);
		return CHR_VERT + ' ' + finalContent + ' '.repeat(Math.max(0, padding)) + CHR_VERT;
	}

	private boxBottom(): string {
		return CHR_BL + CHR_HORIZ.repeat(this.width - 2) + CHR_BR;
	}

	render(): string[] {
		if (this.lines.length === 0) {
			return [];
		}

		const output: string[] = [];
		output.push(this.boxTop());

		for (const line of this.lines) {
			output.push(this.boxMiddle(line));
		}

		output.push(this.boxBottom());
		return output;
	}
}

abstract class BoxMonitor {
	protected commandTitle: string;
	protected width: number;
	protected height: number;
	protected boxes: Box[] = [];
	protected lastLineCount: number = 0;
	protected screenCleared: boolean = false;
	protected commandStatus: string[] = ['Initializing...'];
	protected cli: RocketRideCLI;
	protected isTerminal: boolean;

	constructor(cli: RocketRideCLI, commandTitle: string, width?: number, height?: number) {
		this.cli = cli;
		this.commandTitle = commandTitle;

		if (width === undefined || height === undefined) {
			const [detectedWidth, detectedHeight] = this.detectTerminalSize();
			this.width = width ?? detectedWidth;
			this.height = height ?? detectedHeight;
		} else {
			this.width = width;
			this.height = height;
		}

		this.isTerminal = this.isTerminalCheck();
	}

	private detectTerminalSize(): [number, number] {
		try {
			const size = process.stdout.getWindowSize();
			const width = size[0];
			const height = size[1];

			if (width >= 20 && width <= 300 && height >= 10 && height <= 100) {
				return [Math.max(width - 1, 20), Math.max(height - 2, 10)];
			}
		} catch {
			// Ignore errors
		}

		return [79, 41];
	}

	private isTerminalCheck(): boolean {
		return process.stdout.isTTY && process.stderr.isTTY;
	}

	private updateTerminalSize(): void {
		const [width, height] = this.detectTerminalSize();
		this.width = width;
		this.height = height;
	}

	clear(): void {
		this.boxes = [];
	}

	clearScreen(): void {
		this.screenCleared = false;
		this.lastLineCount = 0;
	}

	setCommandStatus(status: string | string[]): void {
		if (typeof status === 'string') {
			this.commandStatus = [status];
		} else {
			this.commandStatus = status;
		}
	}

	addBox(title: string, lines: string[]): void {
		if (lines.length > 0) {
			const box = new Box(title, lines, this.width);
			this.boxes.push(box);
		}
	}

	private positionToTop(): void {
		process.stdout.write(ANSI_CURSOR_HOME);
	}

	draw(): void {
		this.updateTerminalSize();

		if (!this.screenCleared) {
			process.stdout.write(ANSI_CLEAR_SCREEN);
			this.screenCleared = true;
		}

		this.positionToTop();

		const allBoxes: Box[] = [];
		if (this.commandStatus.length > 0) {
			const commandBox = new Box(this.commandTitle, this.commandStatus, this.width);
			allBoxes.push(commandBox);
		}

		allBoxes.push(...this.boxes);

		const allLines: string[] = [];
		for (let i = 0; i < allBoxes.length; i++) {
			const boxLines = allBoxes[i].render();
			allLines.push(...boxLines);

			if (i < allBoxes.length - 1 && boxLines.length > 0) {
				allLines.push(' '.repeat(this.width));
			}
		}

		for (const line of allLines) {
			console.log(line + ' ');
		}

		const currentLineCount = allLines.length;
		if (currentLineCount < this.lastLineCount) {
			for (let i = currentLineCount; i < this.lastLineCount; i++) {
				console.log(' '.repeat(this.width));
			}
		}

		this.lastLineCount = currentLineCount;
		process.stdout.write('');
	}

	public formatSize(sizeBytes: number): string {
		if (sizeBytes === 0) return '0 B';

		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let unitIndex = 0;
		let size = sizeBytes;

		while (size >= 1024 && unitIndex < units.length - 1) {
			size /= 1024;
			unitIndex++;
		}

		if (unitIndex === 0) {
			return `${Math.floor(size)} ${units[unitIndex]}`;
		} else {
			return `${size.toFixed(1)} ${units[unitIndex]}`;
		}
	}

	onEvent(_message: DAPMessage): void {
		// Override in subclasses
	}
}

class GenericMonitor extends BoxMonitor {
	constructor(cli: RocketRideCLI, commandTitle: string, width?: number, height?: number) {
		super(cli, commandTitle, width, height);
	}
}

class StatusMonitor extends BoxMonitor {
	private token: string;

	constructor(cli: RocketRideCLI, token: string, width?: number, height?: number) {
		super(cli, 'RocketRide Task Monitor', width, height);
		this.token = token;
		this.setCommandStatus(`Token: ${this.token}`);
	}

	private formatDuration(startTime: number, endTime?: number): string {
		if (startTime === 0) return 'Not started';

		const end = endTime || Date.now() / 1000;
		const totalSeconds = Math.floor(end - startTime);

		if (totalSeconds < 60) {
			return `${totalSeconds}secs`;
		} else if (totalSeconds < 3600) {
			const minutes = Math.floor(totalSeconds / 60);
			const seconds = totalSeconds % 60;
			return `${minutes}min, ${seconds}secs`;
		} else {
			const hours = Math.floor(totalSeconds / 3600);
			const minutes = Math.floor((totalSeconds % 3600) / 60);
			const seconds = totalSeconds % 60;
			return `${hours}hr, ${minutes}min, ${seconds}secs`;
		}
	}

	private getStateDisplay(state: number): [string, string] {
		const stateMap: Record<number, [string, string]> = {
			0: ['Offline', ANSI_GRAY],
			1: ['Offline', ANSI_GRAY],
			2: ['Initializing', ANSI_BLUE],
			3: ['Online', ANSI_GREEN],
			4: ['Stopping', ANSI_YELLOW],
			5: ['Offline', ANSI_GRAY],
			6: ['Offline', ANSI_GRAY],
		};
		return stateMap[state] || ['Unknown', ANSI_RESET];
	}

	private hasCountData(status: Record<string, unknown>): boolean {
		return (Number(status.totalSize) || 0) > 0 || (Number(status.totalCount) || 0) > 0 || (Number(status.completedSize) || 0) > 0 || (Number(status.completedCount) || 0) > 0 || (Number(status.failedSize) || 0) > 0 || (Number(status.failedCount) || 0) > 0 || (Number(status.rateSize) || 0) > 0 || (Number(status.rateCount) || 0) > 0;
	}

	private hasMetricsData(status: Record<string, unknown>): boolean {
		const metrics = (status.metrics || {}) as Record<string, unknown>;
		return Object.values(metrics).some((value) => typeof value === 'number' && value > 0);
	}

	onEvent(message: DAPMessage): void {
		const eventType = message.event || '';

		if (eventType !== 'apaevt_status_update') {
			return;
		}

		const status = (message.body || {}) as Record<string, unknown>;
		this.displayStatus(status);
	}

	displayStatus(status: Record<string, unknown>): void {
		this.clear();

		if (status) {
			const pipelineLines = this.buildPipelineLines(status);
			this.addBox('Pipeline Status', pipelineLines);

			const metricsLines = this.buildMetricsLines(status);
			this.addBox('Metrics', metricsLines);

			const errorLines = this.buildErrorLines((status.errors || []) as string[], 'Error');
			this.addBox('Errors', errorLines);

			const warningLines = this.buildErrorLines((status.warnings || []) as string[], 'Warning');
			this.addBox('Warnings', warningLines);

			const noteLines = this.buildNoteLines((status.notes || []) as string[]);
			this.addBox('Notes', noteLines);
		} else {
			this.addBox('Status', ['No status available']);
		}

		this.draw();
	}

	private buildPipelineLines(status: Record<string, unknown>): string[] {
		const lines: string[] = [];

		if (status.name) {
			lines.push(String(status.name));
			lines.push('');
		}

		if (status.status) {
			lines.push(String(status.status));
			lines.push('');
		}

		const state = Number(status.state) || 0;
		const [stateName, stateColor] = this.getStateDisplay(state);
		lines.push(`State: ${stateColor}${stateName}${ANSI_RESET}`);

		const startTime = Number(status.startTime) || 0;
		if (startTime > 0) {
			const startStr = new Date(startTime * 1000).toLocaleString();
			lines.push(`Started: ${startStr}`);

			const endTime = status.completed ? Number(status.endTime) || 0 : undefined;
			const duration = this.formatDuration(startTime, endTime);
			lines.push(`Elapsed: ${duration}`);
		}

		if (this.hasCountData(status)) {
			lines.push('');
			const dataTypes = [
				['total', 'Total'],
				['completed', 'Completed'],
				['failed', 'Failed'],
			];

			for (const [keyBase, label] of dataTypes) {
				const count = Number(status[`${keyBase}Count`]) || 0;
				const size = Number(status[`${keyBase}Size`]) || 0;
				if (count > 0 || size > 0) {
					lines.push(`${label}: ${count} items (${this.formatSize(size)})`);
				}
			}

			const rateSize = Number(status.rateSize) || 0;
			const rateCount = Number(status.rateCount) || 0;
			if (rateSize > 0 || rateCount > 0) {
				lines.push(`Rate: ${this.formatSize(rateSize)}/s (${rateCount}/s items)`);
			}
		}

		return lines.length > 0 ? lines : ['No pipeline data available'];
	}

	private buildMetricsLines(status: Record<string, unknown>): string[] {
		if (!this.hasMetricsData(status)) {
			return [];
		}

		const lines: string[] = [];
		const metrics = (status.metrics || {}) as Record<string, unknown>;

		for (const [key, value] of Object.entries(metrics)) {
			if (typeof value === 'number' && value > 0) {
				const label = key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
				lines.push(`${label}: ${value}`);
			}
		}

		return lines;
	}

	private buildErrorLines(items: string[], errorType: string): string[] {
		if (!items || items.length === 0) {
			return [];
		}

		const lines: string[] = [];
		const color = errorType === 'Error' ? ANSI_RED : ANSI_YELLOW;

		for (const item of items.slice(-5)) {
			const parts = item.split('*');
			if (parts.length >= 3) {
				const errType = parts[0].trim();
				const message = parts[1].replace(/`/g, '').trim();
				const fileInfo = parts[2].trim();
				const filename = fileInfo.includes('\\') || fileInfo.includes('/') ? path.basename(fileInfo) : fileInfo;

				lines.push(`${color}${errType}${ANSI_RESET}: ${message}`);
				if (filename) {
					lines.push(`  -> ${filename}`);
				}
			} else {
				lines.push(`${color}• ${ANSI_RESET}${item}`);
			}
		}

		return lines;
	}

	private buildNoteLines(items: string[]): string[] {
		if (!items || items.length === 0) {
			return [];
		}

		return items.slice(-5).map((item) => `• ${item}`);
	}

	displayConnecting(url: string, attempt: number): void {
		this.clear();

		const retry = attempt > 0 ? ` (attempt ${attempt})` : '';
		const connectionLines = [`Connecting to ${url}${retry}...`];
		this.addBox('Connection Status', connectionLines);

		this.addBox('Controls', ['Press Ctrl+C to stop monitoring...']);
		this.draw();
	}
}

class UploadProgressMonitor extends BoxMonitor {
	private totalFiles: number = 0;
	private activeUploads: Map<string, Record<string, unknown>> = new Map();
	private completedUploads: Map<string, Record<string, unknown>> = new Map();
	private failedUploads: Map<string, Record<string, unknown>> = new Map();

	constructor(cli: RocketRideCLI, width?: number, height?: number) {
		super(cli, 'RocketRide File Upload', width, height);
		this.setCommandStatus('Preparing upload...');
	}

	private createProgressBar(percent: number, width: number = 30): string {
		const filledLength = Math.floor((width * percent) / 100);
		const bar = CHR_BLOCK.repeat(filledLength) + CHR_LIGHT_BLOCK.repeat(width - filledLength);
		return `[${bar}] ${percent.toFixed(1).padStart(5)}%`;
	}

	private truncateFilename(filename: string, maxLength: number): string {
		if (filename.length <= maxLength) {
			return filename;
		}

		const ext = path.extname(filename);
		const name = path.basename(filename, ext);

		if (ext.length < maxLength - 3) {
			const available = maxLength - ext.length - 3;
			return `${name.substring(0, available)}...${ext}`;
		} else {
			return `${filename.substring(0, maxLength - 3)}...`;
		}
	}

	setTotalFiles(totalFiles: number): void {
		this.totalFiles = totalFiles;
	}

	onUploadProgress(result: Record<string, unknown>): void {
		// Process UPLOAD_RESULT from sendFiles
		const filepath = String(result.filepath || 'unknown');
		const bytesSent = Number(result.bytes_sent) || 0;
		const fileSize = Number(result.file_size) || 0;
		const action = String(result.action || '');

		const filename = path.basename(filepath);

		if (action === 'open') {
			// Don't show pending opens
		} else if (action === 'write') {
			this.activeUploads.set(filename, {
				filepath,
				action,
				bytes_sent: bytesSent,
				file_size: fileSize,
			});
		} else if (action === 'close') {
			const existing = this.activeUploads.get(filename);
			if (existing) {
				this.activeUploads.set(filename, {
					...existing,
					action,
					bytes_sent: bytesSent,
					file_size: fileSize,
				});
			}
		} else if (action === 'complete') {
			this.activeUploads.delete(filename);
			this.completedUploads.set(filename, {
				filepath,
				action,
				file_size: fileSize,
			});
		} else if (action === 'error') {
			this.activeUploads.delete(filename);
			const errorMessage = String(result.error || 'Unknown error');
			this.failedUploads.set(filename, {
				filepath,
				action,
				file_size: fileSize,
				error: errorMessage,
			});
		}

		this.draw();
	}

	onEvent(message: DAPMessage): void {
		const eventType = message.event || '';

		if (eventType !== 'apaevt_status_upload') {
			return;
		}

		const body = (message.body || {}) as Record<string, unknown>;
		const filepath = String(body.filepath || 'unknown');
		const bytesSent = Number(body.bytes_sent) || 0;
		const fileSize = Number(body.file_size) || 0;
		const action = String(body.action || '');

		const filename = path.basename(filepath);

		if (action === 'open') {
			// Don't show pending opens
		} else if (action === 'write') {
			this.activeUploads.set(filename, {
				filepath,
				action,
				bytes_sent: bytesSent,
				file_size: fileSize,
			});
		} else if (action === 'close') {
			const existing = this.activeUploads.get(filename);
			if (existing) {
				this.activeUploads.set(filename, {
					...existing,
					action,
					bytes_sent: bytesSent,
					file_size: fileSize,
				});
			}
		} else if (action === 'complete') {
			this.activeUploads.delete(filename);
			this.completedUploads.set(filename, {
				filepath,
				action,
				file_size: fileSize,
			});
		} else if (action === 'error') {
			this.activeUploads.delete(filename);
			const errorMessage = String(body.error || 'Unknown error');
			this.failedUploads.set(filename, {
				filepath,
				action,
				file_size: fileSize,
				error: errorMessage,
			});
		}

		if (this.cli.isCancelled()) {
			this.setCommandStatus(`${ANSI_RED}Upload cancelling...${ANSI_RESET}`);
		} else {
			const totalProcessed = this.completedUploads.size + this.failedUploads.size;
			this.setCommandStatus(`Processed ${totalProcessed} of ${this.totalFiles} files...`);
		}

		this.renderUploadStatus();

		if (this.cli.isCancelled()) {
			throw new Error('Upload cancelled');
		}
	}

	private renderUploadStatus(): void {
		this.clear();

		// Add active uploads box
		if (this.activeUploads.size > 0) {
			const uploadLines: string[] = [];
			const activeEntries = Array.from(this.activeUploads.entries());

			for (const [filename, data] of activeEntries.slice(0, 10)) {
				const displayName = this.truncateFilename(filename, 20).padEnd(20);
				const action = String(data.action || '');
				const phase = action === 'write' ? 'Writing ' : action === 'close' ? 'Finalize' : '        ';

				const bytesSent = Number(data.bytes_sent) || 0;
				const fileSize = Number(data.file_size) || 1;
				const percent = fileSize > 0 ? (bytesSent / fileSize) * 100 : 0;

				const progressBar = this.createProgressBar(percent, 12);
				const sizeInfo = `${this.formatSize(bytesSent)}/${this.formatSize(fileSize)}`;

				uploadLines.push(`${displayName} ${phase} ${progressBar} ${sizeInfo}`);
			}

			if (this.activeUploads.size > 10) {
				const remaining = this.activeUploads.size - 10;
				uploadLines.push(`... and ${remaining} more uploads in progress`);
			}

			this.addBox(`Active Uploads (${this.activeUploads.size})`, uploadLines);
		}

		// Add summary box
		if (this.completedUploads.size > 0 || this.failedUploads.size > 0) {
			const summaryLines: string[] = [];
			if (this.completedUploads.size > 0) {
				summaryLines.push(`Completed: ${this.completedUploads.size} files`);
			}
			if (this.failedUploads.size > 0) {
				summaryLines.push(`Failed: ${this.failedUploads.size} files`);
			}

			const totalBytes = Array.from(this.completedUploads.values()).reduce((sum, data) => sum + (Number(data.file_size) || 0), 0);
			summaryLines.push(`Total size: ${this.formatSize(totalBytes)}`);

			this.addBox('Upload Summary', summaryLines);
		}

		// Add failed uploads box
		if (this.failedUploads.size > 0) {
			const failedLines: string[] = [];
			const failedEntries = Array.from(this.failedUploads.entries());

			const displayCount = failedEntries.length > 5 ? 4 : 5;

			for (const [filename, data] of failedEntries.slice(-displayCount)) {
				const displayName = this.truncateFilename(filename, 25);
				const errorStr = String(data.error || '');
				const errorMsg = errorStr.length > 30 ? `${errorStr.substring(0, 30)}...` : errorStr;
				failedLines.push(`${ANSI_RED}${CHR_CROSS}${ANSI_RESET} ${displayName} - ${errorMsg}`);
			}

			if (failedEntries.length > 5) {
				const remaining = failedEntries.length - 4;
				failedLines.push(`... and ${remaining} more files have failed`);
			}

			this.addBox(`Failed Uploads (${this.failedUploads.size})`, failedLines);
		}

		// Add recently completed box
		if (this.completedUploads.size > 0) {
			const completedLines: string[] = [];
			const completedEntries = Array.from(this.completedUploads.entries());

			for (const [filename, data] of completedEntries.slice(-3)) {
				const displayName = this.truncateFilename(filename, 35);
				const sizeStr = this.formatSize(Number(data.file_size) || 0);
				completedLines.push(`${ANSI_GREEN}${CHR_CHECK}${ANSI_RESET} ${displayName} (${sizeStr})`);
			}

			this.addBox('Recently Completed', completedLines);
		}

		this.draw();
	}

	reset(): void {
		this.activeUploads.clear();
		this.completedUploads.clear();
		this.failedUploads.clear();
		this.setCommandStatus('Preparing upload...');
		this.clearScreen();
	}
}

interface CLIArgs {
	command?: string;
	host?: string;
	port?: number;
	apikey?: string;
	pipeline?: string;
	token?: string;
	threads?: number;
	files?: string[];
	max_concurrent?: number;
	pipeline_args?: string[];
	[key: string]: unknown;
}

interface UploadStats {
	files_processed: number;
	total_bytes: number;
	successful_uploads: number;
	failed_uploads: number;
	upload_times: number[];
}

export class RocketRideCLI {
	private client?: RocketRideClient;
	private args: CLIArgs = {};
	private uploadStats: UploadStats = {
		files_processed: 0,
		total_bytes: 0,
		successful_uploads: 0,
		failed_uploads: 0,
		upload_times: [],
	};
	private uri: string = '';
	private monitor?: BoxMonitor;
	private connected: boolean = false;
	private attempt: number = 0;
	private cancelled: boolean = false;

	constructor() {
		this.setupSignalHandlers();
	}

	cancel(): void {
		this.cancelled = true;
	}

	isCancelled(): boolean {
		return this.cancelled;
	}

	private setupSignalHandlers(): void {
		// TODO: Enable proper signal handling
		// const signalHandler = () => {
		// 	this.cancel();
		// };
		// process.on('SIGINT', signalHandler);
		// process.on('SIGTERM', signalHandler);
	}

	private createProgram(): Command {
		const program = new Command();

		program.name('rocketride').description('RocketRide Unified Pipeline and File Management CLI').version('1.3.0');

		// Common options
		const addCommonOptions = (cmd: Command) => {
			return cmd.option('--uri <uri>', 'RocketRide server URI (can use ROCKETRIDE_URI env var)', process.env.ROCKETRIDE_URI || CONST_DEFAULT_WEB_LOCAL).option('--apikey <key>', 'API key for RocketRide server authentication (can use ROCKETRIDE_APIKEY in .env or env var)', process.env.ROCKETRIDE_APIKEY);
		};

		// Start command
		const startCmd = program
			.command('start')
			.description('Start a new pipeline')
			.option('--pipeline <file>', 'Path to .pipeline file containing pipeline configuration (can use ROCKETRIDE_PIPELINE in .env or env var)', process.env.ROCKETRIDE_PIPELINE)
			.option('--token <token>', 'Optional existing task token for pipeline resume/control (can use ROCKETRIDE_TOKEN in .env or env var)', process.env.ROCKETRIDE_TOKEN)
			.option('--threads <num>', 'Number of threads to use for pipeline execution', '4')
			.option('--args <args...>', 'Additional arguments to pass to pipeline execution')
			.action(async (options) => {
				// Validate required arguments - validation will happen in createAndConnectClient
				if (!options.pipeline) {
					console.error('Error: Pipeline file is required for start command. Use --pipeline or set ROCKETRIDE_PIPELINE in .env file');
					process.exit(1);
				}

				this.args = {
					command: 'start',
					...options,
					pipeline: options.pipeline,
					threads: parseInt(options.threads),
				};
				this.uri = options.uri;

				try {
					const exitCode = await this.cmdStart();
					process.exit(exitCode);
				} finally {
					this.cancel();
					await this.cleanupClient();
				}
			});

		addCommonOptions(startCmd);

		// Upload command
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
				// Validate required arguments - validation will happen in createAndConnectClient
				if (!options.pipeline && !options.token) {
					console.error('Error: Either --pipeline or --token must be specified for upload command. Use --pipeline/--token or set ROCKETRIDE_PIPELINE/ROCKETRIDE_TOKEN in .env file');
					process.exit(1);
				}

				this.args = {
					command: 'upload',
					...options,
					files,
					threads: parseInt(options.threads),
					max_concurrent: parseInt(options.maxConcurrent || '5'),
					pipeline_args: options.args,
				};
				this.uri = options.uri;

				try {
					const exitCode = await this.cmdUpload();
					process.exit(exitCode);
				} finally {
					this.cancel();
					await this.cleanupClient();
				}
			});

		addCommonOptions(uploadCmd);

		// Status command
		const statusCmd = program
			.command('status')
			.description('Monitor task status continuously')
			.option('--token <token>', 'Task token to monitor (can use ROCKETRIDE_TOKEN in .env or env var)', process.env.ROCKETRIDE_TOKEN)
			.action(async (options) => {
				// Validate required arguments - validation will happen in createAndConnectClient
				if (!options.token) {
					console.error('Error: Token is required for status command. Use --token or set ROCKETRIDE_TOKEN in .env file');
					process.exit(1);
				}

				this.args = {
					command: 'status',
					...options,
				};
				this.uri = options.uri;

				try {
					const exitCode = await this.cmdStatus();
					process.exit(exitCode);
				} finally {
					this.cancel();
					await this.cleanupClient();
				}
			});

		addCommonOptions(statusCmd);

		// Stop command
		const stopCmd = program
			.command('stop')
			.description('Stop a running task')
			.option('--token <token>', 'Task token to stop (can use ROCKETRIDE_TOKEN in .env or env var)', process.env.ROCKETRIDE_TOKEN)
			.action(async (options) => {
				// Validate required arguments - validation will happen in createAndConnectClient
				if (!options.token) {
					console.error('Error: Token is required for stop command. Use --token or set ROCKETRIDE_TOKEN in .env file');
					process.exit(1);
				}

				this.args = {
					command: 'stop',
					...options,
				};
				this.uri = options.uri;

				try {
					const exitCode = await this.cmdStop();
					process.exit(exitCode);
				} finally {
					this.cancel();
					await this.cleanupClient();
				}
			});

		addCommonOptions(stopCmd);

		// Store command with file system subcommands
		const storeCmd = program.command('store').description('File store operations');

		// store dir
		const storeDirCmd = storeCmd
			.command('dir [path]')
			.description('List directory contents')
			.action(async (path, options) => {
				this.args = { command: 'store', subcommand: 'dir', path: path || '', ...options };
				this.uri = options.uri;
				try {
					const client = await this.createAndConnectClient();
					const result = await client.fsListDir(path || '');
					const entries = result.entries || [];
					if (entries.length === 0) {
						const stat = path ? await client.fsStat(path) : { exists: true, type: 'dir' as const };
						if (stat.exists && stat.type === 'dir') {
							console.log(`    ${(0).toLocaleString().padStart(8)} File(s)  ${(0).toLocaleString().padStart(14)} bytes`);
							console.log(`    ${(0).toLocaleString().padStart(8)} Dir(s)`);
						} else {
							console.log('File Not Found');
						}
					} else {
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
								console.log(`${dateStr}    <DIR>          ${e.name}`);
								dirCount++;
							} else {
								const size = e.size ?? 0;
								totalSize += size;
								console.log(`${dateStr}    ${size.toLocaleString().padStart(14)} ${e.name}`);
								fileCount++;
							}
						}
						console.log(`    ${fileCount.toLocaleString().padStart(8)} File(s)  ${totalSize.toLocaleString().padStart(14)} bytes`);
						console.log(`    ${dirCount.toLocaleString().padStart(8)} Dir(s)`);
					}
					process.exit(0);
				} finally {
					this.cancel();
					await this.cleanupClient();
				}
			});
		addCommonOptions(storeDirCmd);

		// store type
		const storeTypeCmd = storeCmd
			.command('type <path>')
			.description('Display file contents')
			.action(async (path, options) => {
				this.args = { command: 'store', subcommand: 'type', path, ...options };
				this.uri = options.uri;
				try {
					const client = await this.createAndConnectClient();
					const text = await client.fsReadString(path);
					process.stdout.write(text);
					process.exit(0);
				} finally {
					this.cancel();
					await this.cleanupClient();
				}
			});
		addCommonOptions(storeTypeCmd);

		// store write
		const storeWriteCmd = storeCmd
			.command('write <path>')
			.description('Write a file')
			.option('--file <localFile>', 'Local file to upload')
			.option('--content <text>', 'Inline text content')
			.action(async (path, options) => {
				this.args = { command: 'store', subcommand: 'write', path, ...options };
				this.uri = options.uri;
				try {
					const client = await this.createAndConnectClient();
					if (options.file) {
						const nodeFs = await import('fs');
						const { handle } = await client.fsOpen(path, 'w');
						try {
							const stream = nodeFs.createReadStream(options.file);
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
					} else if (options.content !== undefined) {
						await client.fsWriteString(path, options.content);
					} else {
						console.error('Error: Either --file or --content is required');
						process.exit(1);
					}
					console.log(`Written: ${path}`);
					process.exit(0);
				} finally {
					this.cancel();
					await this.cleanupClient();
				}
			});
		addCommonOptions(storeWriteCmd);

		// store rm
		const storeRmCmd = storeCmd
			.command('rm <path>')
			.description('Delete a file')
			.action(async (path, options) => {
				this.args = { command: 'store', subcommand: 'rm', path, ...options };
				this.uri = options.uri;
				try {
					const client = await this.createAndConnectClient();
					await client.fsDelete(path);
					console.log(`Deleted: ${path}`);
					process.exit(0);
				} finally {
					this.cancel();
					await this.cleanupClient();
				}
			});
		addCommonOptions(storeRmCmd);

		// store mkdir
		const storeMkdirCmd = storeCmd
			.command('mkdir <path>')
			.description('Create a directory')
			.action(async (path, options) => {
				this.args = { command: 'store', subcommand: 'mkdir', path, ...options };
				this.uri = options.uri;
				try {
					const client = await this.createAndConnectClient();
					await client.fsMkdir(path);
					console.log(`Created: ${path}/`);
					process.exit(0);
				} finally {
					this.cancel();
					await this.cleanupClient();
				}
			});
		addCommonOptions(storeMkdirCmd);

		// store stat
		const storeStatCmd = storeCmd
			.command('stat <path>')
			.description('Get file/directory metadata')
			.action(async (path, options) => {
				this.args = { command: 'store', subcommand: 'stat', path, ...options };
				this.uri = options.uri;
				try {
					const client = await this.createAndConnectClient();
					const result = await client.fsStat(path);
					if (!result.exists) {
						console.log(`${path}: not found`);
					} else {
						const details: string[] = [];
						if (result.size !== undefined) details.push(`size: ${result.size.toLocaleString()}`);
						if (result.modified) details.push(`modified: ${new Date(result.modified * 1000).toISOString()}`);
						console.log(`${path}: ${result.type}${details.length ? ` (${details.join(', ')})` : ''}`);
					}
					process.exit(0);
				} finally {
					this.cancel();
					await this.cleanupClient();
				}
			});
		addCommonOptions(storeStatCmd);

		return program;
	}

	private async handleEvent(message: DAPMessage): Promise<void> {
		if (this.monitor) {
			this.monitor.onEvent(message);
		}
	}

	private async createAndConnectClient(onConnected?: (connectionInfo?: string) => Promise<void>, onDisconnected?: (reason?: string, hasError?: boolean) => Promise<void>): Promise<RocketRideClient> {
		this.client = new RocketRideClient({
			uri: this.uri,
			auth: this.args.apikey,
			onEvent: this.handleEvent.bind(this),
			onConnected,
			onDisconnected,
		});

		await this.client.connect();
		return this.client;
	}

	private async sendMonitorCommand(subscribe: boolean, token?: string): Promise<boolean> {
		try {
			if (!this.client) return false;

			const arguments_ = { subscribe };
			const monitorRequest = this.client.buildRequest('rrext_monitor', {
				token,
				arguments: arguments_,
			});
			const monitorResponse = await this.client.request(monitorRequest);

			return !this.client.didFail(monitorResponse);
		} catch {
			return false;
		}
	}

	private async cleanupClient(): Promise<void> {
		if (this.client) {
			try {
				await this.client.disconnect();
			} catch {
				// Ignore cleanup errors
			} finally {
				this.client = undefined;
			}
		}
	}

	private loadPipelineConfig(pipelineFile: string): PipelineConfig {
		if (!fs.existsSync(pipelineFile) || !fs.statSync(pipelineFile).isFile()) {
			throw new Error(`Pipeline file not found: ${pipelineFile}`);
		}

		try {
			const content = fs.readFileSync(pipelineFile, 'utf-8');

			try {
				return JSON.parse(content);
			} catch (error) {
				throw new Error(`Invalid JSON format in ${pipelineFile}: ${error}`);
			}
		} catch (error) {
			if (error instanceof Error && (error.message.includes('not found') || error.message.includes('Invalid'))) {
				throw error;
			} else {
				throw new Error(`Error reading ${pipelineFile}: ${error}`);
			}
		}
	}

	async cmdStart(): Promise<number> {
		try {
			this.monitor = new GenericMonitor(this, 'RocketRide Pipeline Execution');

			this.monitor.setCommandStatus('Loading pipeline configuration...');
			this.monitor.draw();

			const pipelineData = this.loadPipelineConfig(this.args.pipeline!);

			this.monitor.setCommandStatus(['Pipeline loaded successfully', 'Connecting to server...']);
			this.monitor.draw();

			await this.createAndConnectClient();

			this.monitor.setCommandStatus(['Connected to server', 'Starting pipeline execution...']);
			this.monitor.draw();

			const taskToken = await this.client!.use({
				pipeline: pipelineData,
				threads: this.args.threads,
				token: this.args.token,
				args: this.args.pipeline_args || [],
			});

			const executionLines = ['Pipeline execution started successfully', `Task token: ${taskToken}`, '', 'Use the following command to monitor status:', `rocketride status --token ${taskToken} --apikey ${this.args.apikey}`];

			this.monitor.setCommandStatus(executionLines);
			this.monitor.draw();

			return 0;
		} catch (error) {
			if (!this.monitor) {
				this.monitor = new GenericMonitor(this, 'RocketRide Pipeline Execution');
			}

			if (error instanceof Error && (error.message.includes('not found') || error.message.includes('Invalid'))) {
				this.monitor.setCommandStatus('Configuration error occurred');
				this.monitor.addBox('Configuration Error', [error.message]);
			} else {
				this.monitor.setCommandStatus('Execution failed');
				this.monitor.addBox('Execution Error', [String(error)]);
			}
			this.monitor.draw();
			return 1;
		} finally {
			await this.cleanupClient();
		}
	}

	async cmdUpload(): Promise<number> {
		try {
			this.monitor = new UploadProgressMonitor(this);
			this.uploadStats = {
				files_processed: 0,
				total_bytes: 0,
				successful_uploads: 0,
				failed_uploads: 0,
				upload_times: [],
			};

			let pipelineConfig: PipelineConfig | undefined;
			let taskToken: string | undefined;
			let shouldManagePipeline = false;

			if (this.args.pipeline) {
				this.monitor.setCommandStatus('Loading pipeline configuration...');
				this.monitor.draw();
				pipelineConfig = this.loadPipelineConfig(this.args.pipeline);
				shouldManagePipeline = true;
			} else if (this.args.token) {
				taskToken = this.args.token;
				this.monitor.setCommandStatus('Using existing task token...');
				this.monitor.draw();
			} else {
				this.monitor.setCommandStatus('Configuration error');
				this.monitor.addBox('Upload Error', ['Either --pipeline or --token must be specified for upload command']);
				this.monitor.draw();
				return 1;
			}

			// Find and validate files
			this.monitor.setCommandStatus(`Discovering files from ${(this.args.files || []).length} patterns...`);
			this.monitor.draw();

			const allFiles = this.findFiles(this.args.files || []);
			if (allFiles.length === 0) {
				this.monitor.setCommandStatus('File discovery failed');
				this.monitor.addBox('Upload Error', ['No files found matching the specified patterns!']);
				this.monitor.draw();
				return 1;
			}

			this.monitor.setCommandStatus(`Validating ${allFiles.length} files...`);
			this.monitor.draw();

			const [validFiles, invalidFiles] = this.validateFiles(allFiles);

			if (invalidFiles.length > 0) {
				const validationErrorLines: string[] = [];
				const displayCount = Math.min(invalidFiles.length, 15);

				for (const error of invalidFiles.slice(0, displayCount)) {
					validationErrorLines.push(`${ANSI_RED}${CHR_CROSS}${ANSI_RESET} ${error}`);
				}

				if (invalidFiles.length > 15) {
					const remaining = invalidFiles.length - 15;
					validationErrorLines.push(`... and ${remaining} more validation errors`);
				}

				this.monitor.setCommandStatus('File validation completed with errors');
				this.monitor.addBox('File Validation Errors', validationErrorLines);
				this.monitor.draw();

				// Wait briefly to show errors
				await new Promise((resolve) => setTimeout(resolve, 3000));
			}

			if (validFiles.length === 0) {
				this.monitor.setCommandStatus('File validation failed');
				this.monitor.addBox('Upload Error', ['No valid files found!']);
				this.monitor.draw();
				return 1;
			}

			// Connect and start
			this.monitor.setCommandStatus('Connecting to RocketRide server...');
			this.monitor.draw();

			await this.createAndConnectClient();

			if (shouldManagePipeline && pipelineConfig) {
				this.monitor.setCommandStatus('Starting pipeline...');
				this.monitor.draw();

				const result = await this.client!.use({
					pipeline: pipelineConfig,
					threads: this.args.threads,
					token: 'UPLOAD_TASK',
					args: this.args.pipeline_args || [],
				});

				taskToken = result.token;
			}

			// Start upload
			(this.monitor as UploadProgressMonitor).setTotalFiles(validFiles.length);
			this.monitor.draw();

			const startTime = Date.now();

			// Convert file paths to File objects for sendFiles
			const fileObjects = validFiles.map((filePath) => {
				const stats = fs.statSync(filePath);
				const content = fs.readFileSync(filePath);

				return {
					file: new File([content], path.basename(filePath), {
						type: 'application/octet-stream',
						lastModified: stats.mtimeMs,
					}),
					objinfo: {
						filepath: filePath,
						size: stats.size,
					},
				};
			});

			// Upload files - progress events come through event subscription
			// Server handles concurrency automatically
			const results = await this.client!.sendFiles(fileObjects, taskToken!);

			const endTime = Date.now();

			// Analyze and show results
			this.analyzeUploadResults(results, startTime / 1000, endTime / 1000);

			// Cleanup pipeline if we created it
			if (shouldManagePipeline && taskToken) {
				try {
					this.monitor.setCommandStatus(['Upload completed successfully', 'Cleaning up...', 'Terminating pipeline...']);
					this.monitor.draw();

					await this.client!.terminate(taskToken);

					// Re-show results after cleanup
					this.analyzeUploadResults(results, startTime / 1000, endTime / 1000);
				} catch (error) {
					this.monitor.setCommandStatus('Upload completed with cleanup warning');
					this.monitor.addBox('Cleanup Warning', [`Failed to terminate pipeline: ${error}`]);
					this.monitor.draw();
				}
			}

			return 0;
		} catch (error) {
			if (!this.monitor) {
				this.monitor = new UploadProgressMonitor(this);
			}

			if (error instanceof Error && (error.message.includes('not found') || error.message.includes('Invalid'))) {
				this.monitor.setCommandStatus('Configuration error occurred');
				this.monitor.addBox('Configuration Error', [error.message]);
			} else {
				this.monitor.setCommandStatus('Upload operation failed');
				this.monitor.addBox('Upload Error', [String(error)]);
			}
			this.monitor.draw();
			return 1;
		} finally {
			await this.cleanupClient();
		}
	}

	private findFiles(patterns: string[]): string[] {
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
				// Try glob pattern
				const matches = glob.sync(pattern, { nodir: true });
				files.push(...matches.map((f) => path.resolve(f)));
			}
		}

		// Remove duplicates
		return [...new Set(files)];
	}

	private validateFiles(filesList: string[]): [string[], string[]] {
		const validFiles: string[] = [];
		const invalidFiles: string[] = [];

		for (const filepath of filesList) {
			try {
				if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
					// Try to read a byte to check accessibility
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

	private analyzeUploadResults(results: UPLOAD_RESULT[], startTime: number, endTime: number): void {
		if (!this.monitor) return;

		this.monitor.clear();

		const successfulFiles: Array<{ name: string; size: number; time: number }> = [];
		const failedFiles: Array<{ name: string; error: string }> = [];

		for (const result of results) {
			const filename = path.basename(result.filepath || '');

			if (result.action === 'complete') {
				this.uploadStats.successful_uploads++;
				this.uploadStats.total_bytes += result.file_size || 0;
				this.uploadStats.upload_times.push(result.upload_time || 0);

				successfulFiles.push({
					name: filename,
					size: result.file_size || 0,
					time: result.upload_time || 0,
				});
			} else {
				failedFiles.push({
					name: filename,
					error: result.error || 'Unknown error',
				});
				this.uploadStats.failed_uploads++;
			}
			this.uploadStats.files_processed++;
		}

		// Create summary
		const successful = this.uploadStats.successful_uploads;
		const failed = this.uploadStats.failed_uploads;
		const totalBytes = this.uploadStats.total_bytes;

		const summaryLines = [`Total files processed: ${successful + failed}`, `Successful uploads: ${ANSI_GREEN}${successful}${ANSI_RESET}`];

		if (failed > 0) {
			summaryLines.push(`Failed uploads: ${ANSI_RED}${failed}${ANSI_RESET}`);
		}

		summaryLines.push(`Total data uploaded: ${this.monitor.formatSize(totalBytes)}`);

		if (startTime && endTime && endTime > startTime) {
			const elapsedSeconds = endTime - startTime;
			let elapsedStr: string;

			if (elapsedSeconds < 60) {
				elapsedStr = `${elapsedSeconds.toFixed(1)} seconds`;
			} else if (elapsedSeconds < 3600) {
				const minutes = Math.floor(elapsedSeconds / 60);
				const seconds = elapsedSeconds % 60;
				elapsedStr = `${minutes}m ${seconds.toFixed(1)}s`;
			} else {
				const hours = Math.floor(elapsedSeconds / 3600);
				const minutes = Math.floor((elapsedSeconds % 3600) / 60);
				const seconds = elapsedSeconds % 60;
				elapsedStr = `${hours}h ${minutes}m ${seconds.toFixed(1)}s`;
			}

			summaryLines.push(`Total elapsed time: ${elapsedStr}`);

			if (totalBytes > 0 && elapsedSeconds > 0) {
				const throughputBps = totalBytes / elapsedSeconds;
				const throughputStr = this.monitor.formatSize(Math.floor(throughputBps));
				summaryLines.push(`Average throughput: ${throughputStr}/s`);
			}
		}

		this.monitor.addBox('Upload Summary', summaryLines);

		// Show failed files if any
		if (failedFiles.length > 0) {
			const failureLines: string[] = [];

			for (const failedFile of failedFiles.slice(0, 10)) {
				const filename = failedFile.name.length > 25 ? `${failedFile.name.substring(0, 25)}...` : failedFile.name;
				const errorMsg = failedFile.error.length > 40 ? `${failedFile.error.substring(0, 40)}...` : failedFile.error;

				failureLines.push(`${ANSI_RED}${CHR_CROSS}${ANSI_RESET} ${filename} - ${errorMsg}`);
			}

			if (failedFiles.length > 10) {
				failureLines.push(`... and ${failedFiles.length - 10} more failures`);
			}

			this.monitor.addBox(`Failed Uploads (${failedFiles.length})`, failureLines);
		}

		// Show successful files summary
		if (successfulFiles.length > 0) {
			const successLines: string[] = [];

			for (const successFile of successfulFiles.slice(-5)) {
				const truncatedName = successFile.name.length > 35 ? `${successFile.name.substring(0, 35)}...` : successFile.name;
				const sizeStr = this.monitor.formatSize(successFile.size);
				const timeStr = `${successFile.time.toFixed(1)}s`;

				successLines.push(`${ANSI_GREEN}${CHR_CHECK}${ANSI_RESET} ${truncatedName} (${sizeStr}, ${timeStr})`);
			}

			if (successfulFiles.length > 5) {
				successLines.push(`... and ${successfulFiles.length - 5} more successful uploads`);
			}

			this.monitor.addBox('Recent Successful Uploads', successLines);
		}

		this.monitor.setCommandStatus('Completed');
		this.monitor.draw();
	}

	async cmdStatus(): Promise<number> {
		try {
			if (!this.args.token) {
				console.error('Error: --token is required for status command');
				return 1;
			}

			this.monitor = new StatusMonitor(this, this.args.token);

			const onConnected = async (_uri?: string) => {
				this.connected = true;
				this.attempt = 0;
				(this.monitor as StatusMonitor).displayStatus({});
				await this.sendMonitorCommand(true, this.args.token);
			};

			const onDisconnected = async (_reason?: string, _hasError?: boolean) => {
				this.connected = false;
			};

			// Auto-reconnection loop
			while (!this.isCancelled()) {
				if (!this.connected) {
					(this.monitor as StatusMonitor).displayConnecting(this.uri, this.attempt);
					try {
						await this.createAndConnectClient(onConnected, onDisconnected);
					} catch {
						this.attempt++;
						await new Promise((resolve) => setTimeout(resolve, 5000));
						continue;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}

			return 0;
		} catch {
			return 0;
		} finally {
			// Make sure we unsubscribe
			if (this.client && this.connected) {
				try {
					await this.sendMonitorCommand(false, this.args.token);
				} catch {
					// Ignore unsubscribe errors
				}
			}

			await this.cleanupClient();
		}
	}

	async cmdStop(): Promise<number> {
		try {
			if (!this.args.token) {
				console.error('Error: --token is required for stop command');
				return 1;
			}

			this.monitor = new GenericMonitor(this, 'RocketRide Task Management');

			this.monitor.setCommandStatus('Connecting to server...');
			this.monitor.draw();

			await this.createAndConnectClient();

			this.monitor.setCommandStatus(`Terminating task: ${this.args.token}`);
			this.monitor.draw();

			await this.client!.terminate(this.args.token);

			const stopLines = [`Task ${this.args.token} terminated successfully`, '', 'The task has been stopped and resources cleaned up.'];

			this.monitor.setCommandStatus(stopLines);
			this.monitor.draw();

			return 0;
		} catch (error) {
			if (!this.monitor) {
				this.monitor = new GenericMonitor(this, 'RocketRide Task Management');
			}

			this.monitor.setCommandStatus('Stop operation failed');
			this.monitor.addBox('Stop Error', [String(error)]);
			this.monitor.draw();
			return 1;
		} finally {
			await this.cleanupClient();
		}
	}

	async run(): Promise<number> {
		const program = this.createProgram();

		// Parse command line arguments - commander will handle command routing
		try {
			await program.parseAsync(process.argv);
			return 0; // If we get here, a command was executed successfully
		} catch (error) {
			if (error instanceof Error && error.message.includes('interrupted')) {
				console.log('\nOperation interrupted by user');
				return 1;
			} else {
				console.error(`Error: ${error}`);
				return 1;
			}
		}
	}
}

function formatError(e: Error): string {
	const stack = e.stack?.split('\n');
	if (stack && stack.length > 1) {
		const frame = stack[1];
		const match = frame.match(/at .+?\((.+):(\d+):\d+\)/) || frame.match(/at (.+):(\d+):\d+/);
		if (match) {
			const filename = path.basename(match[1]);
			const lineno = match[2];
			return `${e.constructor.name}: ${e.message} (in ${filename}:${lineno})`;
		}
	}
	return `${e.constructor.name}: ${e.message}`;
}

export async function main(): Promise<void> {
	try {
		const cli = new RocketRideCLI();
		const exitCode = await cli.run();
		process.exit(exitCode);
	} catch (error) {
		if (error instanceof Error && error.message.includes('interrupted')) {
			console.log('\n\nOperation interrupted by user');
		} else {
			console.log(`\nOperation failed: ${formatError(error as Error)}`);
			process.exit(1);
		}
	}
}

// Entry point when script is run directly
if (require.main === module) {
	main().catch((error) => {
		console.error('Fatal error:', error);
		process.exit(1);
	});
}
