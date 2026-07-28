import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IExecuteFunctions,
	type IHttpRequestOptions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';

import {
	buildChatBody,
	buildRunBody,
	coerceJsonObject,
	formatBytes,
	isConnectionError,
	MAX_UPLOAD_BYTES,
	normalizeRunResult,
	parseRocketRideResponse,
	reachabilityMessage,
	type RocketRideDocument,
	type RocketRidePayloadMode,
} from './helpers';

export class RocketRide implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'RocketRide',
		name: 'rocketRide',
		icon: { light: 'file:rocketride.svg', dark: 'file:rocketride.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Run RocketRide AI pipelines for document parsing, OCR, data extraction, PII anonymization, transformation, RAG, chat, and agents.',
		defaults: {
			name: 'RocketRide',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'rocketRideApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'run',
				options: [
					{
						name: 'Chat',
						value: 'chat',
						action: 'Chat with a pipeline',
						description: 'Send a question to a chat-enabled RocketRide pipeline and return the answer',
					},
					{
						name: 'Run Pipeline',
						value: 'run',
						action: 'Run a pipeline',
						description: 'Send data to a deployed RocketRide pipeline and return its result',
					},
					{
						name: 'Upload Files',
						value: 'uploadFiles',
						action: 'Upload files',
						description: 'Send binary files (multipart) to a deployed RocketRide pipeline',
					},
				],
			},
			{
				displayName: 'Send',
				name: 'payloadMode',
				type: 'options',
				default: 'text',
				displayOptions: { show: { operation: ['run'] } },
				options: [
					{
						name: 'JSON',
						value: 'json',
						description: 'Send a JSON body to the pipeline',
					},
					{
						name: 'Structured (Text and Documents)',
						value: 'structured',
						description: 'Send text plus documents with metadata, for RAG and document pipelines',
					},
					{
						name: 'Text',
						value: 'text',
						description: 'Send plain text to the pipeline',
					},
				],
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				displayOptions: { show: { operation: ['run'], payloadMode: ['text', 'structured'] } },
				description: 'The text to send to the pipeline',
			},
			{
				displayName: 'JSON Body',
				name: 'jsonBody',
				type: 'json',
				default: '{}',
				displayOptions: { show: { operation: ['run'], payloadMode: ['json'] } },
				description: 'The JSON body to send to the pipeline',
			},
			{
				displayName: 'Documents',
				name: 'documents',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Document',
				displayOptions: { show: { operation: ['run'], payloadMode: ['structured'] } },
				options: [
					{
						name: 'document',
						displayName: 'Document',
						values: [
							{
								displayName: 'Content',
								name: 'content',
								type: 'string',
								typeOptions: { rows: 2 },
								default: '',
								description: 'The document text',
							},
							{
								displayName: 'Metadata',
								name: 'metadata',
								type: 'json',
								default: '{}',
								description: 'Optional metadata for the document, as a JSON object',
							},
						],
					},
				],
			},
			{
				displayName: 'Input Binary Field',
				name: 'inputDataFieldName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { operation: ['uploadFiles'] } },
				description:
					'Name of the input binary field(s) to upload. Use a comma-separated list to send multiple files.',
			},
			{
				displayName: 'Text',
				name: 'uploadText',
				type: 'string',
				default: '',
				displayOptions: { show: { operation: ['uploadFiles'] } },
				description: 'Optional text to send alongside the files, such as a question or instruction',
			},
			{
				displayName: 'Question',
				name: 'question',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: { show: { operation: ['chat'] } },
				description: 'The question to ask the chat-enabled pipeline',
			},
			{
				displayName: 'Expect JSON',
				name: 'expectJson',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['chat'] } },
				description: 'Whether to ask the pipeline for a structured JSON answer instead of text',
			},
			{
				displayName: 'Role',
				name: 'role',
				type: 'string',
				default: '',
				displayOptions: { show: { operation: ['chat'] } },
				description: 'Optional AI role or persona, for example "You are a financial analyst"',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('rocketRideApi');
		const baseUrl = String(credentials.baseUrl ?? '').replace(/\/+$/, '');
		const skipSsl = credentials.ignoreSslIssues === true;

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;

				let requestOptions: IHttpRequestOptions;

				if (operation === 'run') {
					const payloadMode = this.getNodeParameter('payloadMode', i) as RocketRidePayloadMode;

					let documents: RocketRideDocument[] | undefined;
					if (payloadMode === 'structured') {
						const entries = this.getNodeParameter('documents.document', i, []) as Array<{
							content?: string;
							metadata?: unknown;
						}>;
						documents = entries.map((entry) => ({
							content: String(entry.content ?? ''),
							metadata: coerceJsonObject(entry.metadata),
						}));
					}

					const { body, contentType } = buildRunBody(payloadMode, {
						text: this.getNodeParameter('text', i, '') as string,
						jsonBody:
							payloadMode === 'json' ? this.getNodeParameter('jsonBody', i, {}) : undefined,
						documents,
					});

					requestOptions = {
						method: 'POST',
						url: `${baseUrl}/webhook`,
						headers: { 'Content-Type': contentType, Accept: 'application/json' },
						body,
						json: false,
						skipSslCertificateValidation: skipSsl,
					};
				} else if (operation === 'uploadFiles') {
					const fieldNames = (this.getNodeParameter('inputDataFieldName', i, 'data') as string)
						.split(',')
						.map((name) => name.trim())
						.filter((name) => name.length > 0);

					if (fieldNames.length === 0) {
						throw new NodeOperationError(
							this.getNode(),
							'Specify at least one binary property to upload',
							{ itemIndex: i },
						);
					}

					const form = new FormData();
					let totalBytes = 0;
					for (const fieldName of fieldNames) {
						const binary = this.helpers.assertBinaryData(i, fieldName);
						const buffer = await this.helpers.getBinaryDataBuffer(i, fieldName);
						totalBytes += buffer.length;
						if (totalBytes > MAX_UPLOAD_BYTES) {
							throw new NodeOperationError(
								this.getNode(),
								`Upload exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} limit (got ${formatBytes(totalBytes)}). Reduce the file size or upload fewer files at once.`,
								{ itemIndex: i },
							);
						}
						form.append(
							fieldName,
							new Blob([new Uint8Array(buffer)], { type: binary.mimeType || 'application/octet-stream' }),
							binary.fileName || fieldName,
						);
					}

					const uploadText = this.getNodeParameter('uploadText', i, '') as string;
					if (uploadText) {
						form.append('text', uploadText);
					}

					requestOptions = {
						method: 'POST',
						url: `${baseUrl}/webhook`,
						body: form,
						json: false,
						skipSslCertificateValidation: skipSsl,
					};
				} else if (operation === 'chat') {
					const { body, contentType } = buildChatBody({
						question: this.getNodeParameter('question', i, '') as string,
						expectJson: this.getNodeParameter('expectJson', i, false) as boolean,
						role: this.getNodeParameter('role', i, '') as string,
					});

					requestOptions = {
						method: 'POST',
						url: `${baseUrl}/webhook`,
						headers: { 'Content-Type': contentType, Accept: 'application/json' },
						body,
						json: false,
						skipSslCertificateValidation: skipSsl,
					};
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported`,
						{ itemIndex: i },
					);
				}

				const raw = await this.helpers.httpRequestWithAuthentication.call(
					this,
					'rocketRideApi',
					requestOptions,
				);

				returnData.push({
					json: normalizeRunResult(parseRocketRideResponse(raw)),
					pairedItem: { item: i },
				});
			} catch (error) {
				const message = isConnectionError(error)
					? reachabilityMessage(baseUrl, (error as Error).message || 'connection error')
					: (error as Error).message;

				if (this.continueOnFail()) {
					returnData.push({ json: { error: message }, pairedItem: { item: i } });
					continue;
				}
				if (isConnectionError(error)) {
					throw new NodeOperationError(this.getNode(), message, { itemIndex: i });
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
