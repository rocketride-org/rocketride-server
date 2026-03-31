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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * session.ts - Debug Adapter Using RocketRideClient from the Shared SDK
 *
 * Each debug session gets its own RocketRideClient connection.
 * The adapter focuses on DAP message handling and pipeline-specific logic.
 * Emits custom events for webview providers to consume.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { RocketRideClient, DAPMessage, ConnectionException } from 'rocketride';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';
import { ConfigManager } from '../config';
import { GenericEvent, GenericResponse, GenericRequest } from '../shared/types/protocol';

import { LaunchRequest, AttachRequest } from '../shared/types/protocol';

/**
 * Debug Adapter with individual RocketRideClient connection
 */
export class RocketRideDebugAdapter implements vscode.DebugAdapter {
	// Connection and configuration
	private client?: RocketRideClient;
	private configManager = ConfigManager.getInstance();
	private logger = getLogger();
	private config: Record<string, unknown>;

	// Pipeline and debugging context
	private pipeline?: Record<string, unknown>;
	private fileUri?: vscode.Uri;
	private apiHost?: string;

	// Token management (stored locally instead of on the connection)
	private token?: string;

	// Debug session reference for emitting custom events
	private debugSession?: vscode.DebugSession;

	// DAP sequence number tracking for proper protocol compliance
	private responseSeq = 0;

	// VS Code DAP integration
	private readonly messageEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	public onDidSendMessage = this.messageEmitter.event;

	constructor(config: Record<string, unknown>) {
		this.config = config;
	}

	private getNextSeq(): number {
		return ++this.responseSeq;
	}

	private async initializeConnection(): Promise<void> {
		const rocketrideConfig = this.configManager.getConfig();
		const uri = this.configManager.getHttpUrl();

		let apiKey: string | undefined;
		if (rocketrideConfig.connectionMode === 'cloud' || rocketrideConfig.connectionMode === 'onprem') {
			apiKey = rocketrideConfig.apiKey;
		} else {
			apiKey = 'MYAPIKEY';
		}

		this.client = new RocketRideClient({
			auth: apiKey,
			uri,
			module: 'CONN-DBG',
			onEvent: async (message: DAPMessage) => {
				this.emitEvent(message as unknown as GenericEvent);
			},
			onDisconnected: async () => {
				this.logger.output(`${icons.warning} Debug session disconnected`);
				this.emitEvent({
					type: 'event',
					event: 'terminated',
					body: {},
				});
			},
			onConnectError: async (error: ConnectionException) => {
				this.logger.output(`${icons.error} ${error.message}`);

				this.emitEvent({
					type: 'event',
					event: 'output',
					body: {
						category: 'stderr',
						output: `Connection error: ${error.message}\n`,
					},
				});

				this.emitEvent({
					type: 'event',
					event: 'terminated',
					body: {},
				});
			},
		});
	}

	private emitResponse(message: GenericResponse): void {
		this.messageEmitter.fire({
			...message,
			seq: this.getNextSeq(),
		});
	}

	private emitEvent(message: GenericEvent): void {
		this.messageEmitter.fire({
			...message,
			seq: this.getNextSeq(),
		});
	}

	public async connect(session: vscode.DebugSession): Promise<void> {
		try {
			this.debugSession = session;

			const type = (session.configuration.request ?? 'launch').toLowerCase();

			if (type !== 'launch' && type !== 'attach') {
				throw new Error(`Unsupported request type: ${type}`);
			}

			await this.initializeConnection();

			if (!this.client) {
				throw new Error('Failed to initialize client connection');
			}

			await this.client.connect();

			this.apiHost = this.configManager.getHttpUrl();

			if (type === 'launch') {
				const [uri, content] = await this.loadPipeline(session);
				this.pipeline = content;
				this.fileUri = uri;
			}

			this.logger.output(`${icons.success} Debug adapter ready`);
		} catch (err) {
			this.logger.output(`${icons.error} ${err}`);
			throw err;
		}
	}

	private async loadPipeline(session: vscode.DebugSession): Promise<[vscode.Uri, Record<string, unknown>]> {
		const config = session.configuration;
		let fileUri: vscode.Uri;

		const ensurePipelineFile = (fsPath: string): void => {
			const lower = fsPath.toLowerCase();
			if (!lower.endsWith('.pipe') && !lower.endsWith('.pipe.json')) {
				this.logger.throwError(`File "${fsPath}" is not a .pipe file`);
			}
		};

		if (config.file && typeof config.file === 'string') {
			const filePath = config.file;

			if (path.isAbsolute(filePath)) {
				fileUri = vscode.Uri.file(filePath);
			} else {
				const workspaceFolders = vscode.workspace.workspaceFolders;

				if (!workspaceFolders || workspaceFolders.length === 0) {
					this.logger.throwError('No workspace folder is open to resolve relative pipeline file path.');
					return [vscode.Uri.file(''), {}];
				}

				const rootUri = workspaceFolders[0].uri;
				fileUri = vscode.Uri.joinPath(rootUri, filePath);
			}

			ensurePipelineFile(fileUri.fsPath);
		} else {
			const editor = vscode.window.activeTextEditor;

			if (!editor || !editor.document || editor.document.uri.scheme !== 'file') {
				this.logger.throwError('No pipeline file specified and no active editor with a file is open.');
				return [vscode.Uri.file(''), {}];
			}

			fileUri = editor.document.uri;
			ensurePipelineFile(fileUri.fsPath);
		}

		let contentBuffer: Uint8Array;
		try {
			contentBuffer = await vscode.workspace.fs.readFile(fileUri);
		} catch (err) {
			this.logger.throwError(`Unable to load pipeline file at "${fileUri.fsPath}": ${err instanceof Error ? err.message : String(err)}`);
			return [vscode.Uri.file(''), {}];
		}

		const content = new TextDecoder('utf-8').decode(contentBuffer);

		try {
			const fileContent = JSON.parse(content);

			if (!fileContent.pipeline) {
				this.logger.throwError(`Pipeline file does not contain a pipeline`);
			}

			const pipeline = fileContent.pipeline;

			if (!pipeline.components) {
				this.logger.throwError(`Pipeline file does not contain components`);
			}

			const configSource = config.source && typeof config.source === 'string' ? config.source : undefined;
			if (configSource) {
				pipeline.source = configSource;
			}
			if (!pipeline.source) {
				this.logger.throwError(`Pipeline file does not contain a source`);
			}

			return [fileUri, fileContent];
		} catch (err) {
			this.logger.throwError(`Pipeline file contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
			return [fileUri, {}];
		}
	}

	public async handleMessage(message: GenericRequest): Promise<void> {
		if (!this.client) {
			throw new Error('Connection not initialized');
		}

		try {
			if (this.isLaunchRequest(message)) {
				message.arguments.pipeline = this.pipeline;
				message.arguments.args = this.configManager.getEffectiveEngineArgs();
			} else if (this.isAttachRequest(message)) {
				this.token = message.arguments?.token;
			}

			// Include token in the request
			message.token = this.token;

			const response = await this.client.dapRequest(message.command, message.arguments, message.token);

			// Cast DAPMessage to GenericResponse
			const genericResponse = response as unknown as GenericResponse;

			if (this.isLaunchRequest(message) && genericResponse.body?.token) {
				this.token = genericResponse.body.token as string;
			}

			if (this.isAttachRequest(message) && genericResponse.body?.pipeline) {
				this.pipeline = genericResponse.body.pipeline as Record<string, unknown>;
			}

			this.emitResponse(genericResponse);
		} catch (error) {
			this.emitResponse({
				type: 'response',
				request_seq: message.seq,
				command: message.command,
				success: false,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private isLaunchRequest(message: GenericRequest): message is LaunchRequest {
		return message.type === 'request' && message.command === 'launch';
	}

	private isAttachRequest(message: GenericRequest): message is AttachRequest {
		return message.type === 'request' && message.command === 'attach';
	}

	public async dispose() {
		this.logger.output(`${icons.stop} Disposing debug adapter`);
		if (this.client) {
			await this.client.disconnect();
		}
	}
}
