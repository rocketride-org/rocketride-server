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
 * Templates Sidebar TreeView Provider
 *
 * Lists all available pipeline templates in the explorer sidebar.
 * Clicking a template creates a new .pipe file from that template
 * and opens it in the custom pipeline editor.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Provider options for `requires` slots
// ---------------------------------------------------------------------------

interface ProviderOption {
	label: string;
	provider: string;
}

const STORE_PROVIDERS: ProviderOption[] = [
	{ label: 'Chroma', provider: 'chroma' },
	{ label: 'Qdrant', provider: 'qdrant' },
	{ label: 'Pinecone', provider: 'pinecone' },
	{ label: 'Weaviate', provider: 'weaviate' },
	{ label: 'Milvus', provider: 'milvus' },
];

const LLM_PROVIDERS: ProviderOption[] = [
	{ label: 'OpenAI', provider: 'llm_openai' },
	{ label: 'Anthropic', provider: 'llm_anthropic' },
	{ label: 'Google Gemini', provider: 'llm_gemini' },
	{ label: 'Ollama (local)', provider: 'llm_ollama' },
	{ label: 'Perplexity', provider: 'llm_perplexity' },
	{ label: 'DeepSeek', provider: 'llm_deepseek' },
];

const PROVIDER_OPTIONS: Record<string, ProviderOption[]> = {
	store: STORE_PROVIDERS,
	llm: LLM_PROVIDERS,
};

// ---------------------------------------------------------------------------
// Template catalog (hard-coded from shared-ui/templates.json)
// ---------------------------------------------------------------------------

interface TemplateRequirement {
	classType: string;
	label: string;
}

interface TemplateComponent {
	id: string;
	provider?: string;
	ref?: string;
	position?: { x: number; y: number };
	input: { lane: string; from: string }[];
	control: { classType: string; from: string }[];
}

interface TemplateInfo {
	title: string;
	description: string;
	requires: Record<string, TemplateRequirement>;
	components: TemplateComponent[];
}

const TEMPLATES: Record<string, TemplateInfo> = {
	'rag-chat': {
		title: 'RAG Chat',
		description: 'Ingest + chat: webhook to vector store, then chat queries it via LLM',
		requires: {
			store: { classType: 'store', label: 'Vector Store' },
			llm: { classType: 'llm', label: 'LLM Provider' },
		},
		components: [
			{ id: 'webhook_1', provider: 'webhook', position: { x: -10, y: -190 }, input: [], control: [] },
			{ id: 'parse_1', provider: 'parse', position: { x: 252, y: -252 }, input: [{ lane: 'tags', from: 'webhook_1' }], control: [] },
			{
				id: 'preprocessor_langchain_1',
				provider: 'preprocessor_langchain',
				position: { x: 492, y: -170 },
				input: [
					{ lane: 'text', from: 'parse_1' },
					{ lane: 'text', from: 'webhook_1' },
				],
				control: [],
			},
			{
				id: 'embedding_transformer_1',
				provider: 'embedding_transformer',
				position: { x: 721, y: -163 },
				input: [{ lane: 'documents', from: 'preprocessor_langchain_1' }],
				control: [],
			},
			{
				id: 'store_1',
				ref: 'store',
				position: { x: 948, y: -79 },
				input: [
					{ lane: 'documents', from: 'embedding_transformer_1' },
					{ lane: 'questions', from: 'chat_1' },
				],
				control: [],
			},
			{ id: 'chat_1', provider: 'chat', position: { x: -15, y: 0 }, input: [], control: [] },
			{ id: 'llm_1', ref: 'llm', position: { x: 1161, y: -44 }, input: [{ lane: 'questions', from: 'store_1' }], control: [] },
			{ id: 'response_answers_1', provider: 'response_answers', position: { x: 1362, y: -42 }, input: [{ lane: 'answers', from: 'llm_1' }], control: [] },
		],
	},
	summarizer: {
		title: 'Document Summarizer',
		description: 'Upload a document via webhook, parse, chunk, and summarize with an LLM',
		requires: {
			llm: { classType: 'llm', label: 'LLM Provider' },
		},
		components: [
			{ id: 'webhook_1', provider: 'webhook', position: { x: 0, y: 0 }, input: [], control: [] },
			{ id: 'parse_1', provider: 'parse', position: { x: 240, y: 0 }, input: [{ lane: 'tags', from: 'webhook_1' }], control: [] },
			{ id: 'preprocessor_langchain_1', provider: 'preprocessor_langchain', position: { x: 480, y: 0 }, input: [{ lane: 'text', from: 'parse_1' }], control: [] },
			{
				id: 'summarization_1',
				provider: 'summarization',
				position: { x: 720, y: 0 },
				input: [{ lane: 'documents', from: 'preprocessor_langchain_1' }],
				control: [],
			},
			{ id: 'llm_1', ref: 'llm', position: { x: 480, y: 180 }, input: [], control: [{ classType: 'llm', from: 'summarization_1' }] },
			{ id: 'response_text_1', provider: 'response_text', position: { x: 960, y: 0 }, input: [{ lane: 'text', from: 'summarization_1' }], control: [] },
		],
	},
	'data-extractor': {
		title: 'Data Extractor',
		description: 'Extract structured JSON from documents using an LLM (invoices, contracts, receipts)',
		requires: {
			llm: { classType: 'llm', label: 'LLM Provider' },
		},
		components: [
			{ id: 'webhook_1', provider: 'webhook', position: { x: 0, y: 0 }, input: [], control: [] },
			{ id: 'parse_1', provider: 'parse', position: { x: 240, y: 0 }, input: [{ lane: 'tags', from: 'webhook_1' }], control: [] },
			{ id: 'extract_data_1', provider: 'extract_data', position: { x: 480, y: 0 }, input: [{ lane: 'text', from: 'parse_1' }], control: [] },
			{ id: 'llm_1', ref: 'llm', position: { x: 240, y: 180 }, input: [], control: [{ classType: 'llm', from: 'extract_data_1' }] },
			{
				id: 'response_table_1',
				provider: 'response_table',
				position: { x: 720, y: 0 },
				input: [{ lane: 'table', from: 'extract_data_1' }],
				control: [],
			},
		],
	},
	'web-scraper-rag': {
		title: 'Web Scraper to RAG',
		description: 'Scrape a URL with Firecrawl, parse, embed, and search with chat',
		requires: {
			store: { classType: 'store', label: 'Vector Store' },
			llm: { classType: 'llm', label: 'LLM Provider' },
		},
		components: [
			{ id: 'tool_firecrawl_1', provider: 'tool_firecrawl', position: { x: 0, y: -160 }, input: [], control: [] },
			{
				id: 'preprocessor_langchain_1',
				provider: 'preprocessor_langchain',
				position: { x: 280, y: -160 },
				input: [{ lane: 'text', from: 'tool_firecrawl_1' }],
				control: [],
			},
			{
				id: 'embedding_transformer_1',
				provider: 'embedding_transformer',
				position: { x: 540, y: -160 },
				input: [{ lane: 'documents', from: 'preprocessor_langchain_1' }],
				control: [],
			},
			{
				id: 'store_1',
				ref: 'store',
				position: { x: 800, y: -60 },
				input: [
					{ lane: 'documents', from: 'embedding_transformer_1' },
					{ lane: 'questions', from: 'chat_1' },
				],
				control: [],
			},
			{ id: 'chat_1', provider: 'chat', position: { x: 0, y: 40 }, input: [], control: [] },
			{ id: 'llm_1', ref: 'llm', position: { x: 1040, y: -20 }, input: [{ lane: 'questions', from: 'store_1' }], control: [] },
			{ id: 'response_answers_1', provider: 'response_answers', position: { x: 1280, y: -20 }, input: [{ lane: 'answers', from: 'llm_1' }], control: [] },
		],
	},
	'audio-transcription': {
		title: 'Audio Transcription',
		description: 'Upload audio files, transcribe with Whisper, and return text',
		requires: {},
		components: [
			{ id: 'webhook_1', provider: 'webhook', position: { x: 0, y: 0 }, input: [], control: [] },
			{ id: 'audio_transcribe_1', provider: 'audio_transcribe', position: { x: 280, y: 0 }, input: [{ lane: 'tags', from: 'webhook_1' }], control: [] },
			{ id: 'response_text_1', provider: 'response_text', position: { x: 560, y: 0 }, input: [{ lane: 'text', from: 'audio_transcribe_1' }], control: [] },
		],
	},
	'multi-agent-crew': {
		title: 'Multi-Agent Crew',
		description: 'Two agents with tools, memory, and a shared LLM — research and execute',
		requires: {
			llm: { classType: 'llm', label: 'LLM Provider' },
		},
		components: [
			{ id: 'chat_1', provider: 'chat', position: { x: 0, y: 0 }, input: [], control: [] },
			{
				id: 'agent_rocketride_1',
				provider: 'agent_rocketride',
				position: { x: 280, y: -60 },
				input: [{ lane: 'questions', from: 'chat_1' }],
				control: [],
			},
			{
				id: 'agent_rocketride_2',
				provider: 'agent_rocketride',
				position: { x: 280, y: 140 },
				input: [{ lane: 'questions', from: 'chat_1' }],
				control: [],
			},
			{
				id: 'memory_internal_1',
				provider: 'memory_internal',
				position: { x: 0, y: 280 },
				input: [],
				control: [
					{ classType: 'memory', from: 'agent_rocketride_1' },
					{ classType: 'memory', from: 'agent_rocketride_2' },
				],
			},
			{
				id: 'tool_http_request_1',
				provider: 'tool_http_request',
				position: { x: 560, y: 140 },
				input: [],
				control: [{ classType: 'tool', from: 'agent_rocketride_1' }],
			},
			{
				id: 'tool_python_1',
				provider: 'tool_python',
				position: { x: 560, y: 280 },
				input: [],
				control: [{ classType: 'tool', from: 'agent_rocketride_2' }],
			},
			{
				id: 'llm_1',
				ref: 'llm',
				position: { x: 280, y: 380 },
				input: [],
				control: [
					{ classType: 'llm', from: 'agent_rocketride_1' },
					{ classType: 'llm', from: 'agent_rocketride_2' },
				],
			},
			{
				id: 'response_answers_1',
				provider: 'response_answers',
				position: { x: 560, y: -60 },
				input: [{ lane: 'answers', from: 'agent_rocketride_1' }],
				control: [],
			},
		],
	},
	'document-parser': {
		title: 'Document Parser',
		description: 'Parse incoming webhook data and return structured table and text responses',
		requires: {},
		components: [
			{ id: 'webhook_1', provider: 'webhook', position: { x: 12, y: 80 }, input: [], control: [] },
			{ id: 'parse_1', provider: 'parse', position: { x: 242, y: 80 }, input: [{ lane: 'tags', from: 'webhook_1' }], control: [] },
			{ id: 'response_table_1', provider: 'response_table', position: { x: 472, y: 12 }, input: [{ lane: 'table', from: 'parse_1' }], control: [] },
			{ id: 'response_text_1', provider: 'response_text', position: { x: 472, y: 138 }, input: [{ lane: 'text', from: 'parse_1' }], control: [] },
		],
	},
	'rocketride-wave-agent': {
		title: 'RocketRide Wave Agent',
		description: 'Chat-driven agent with memory, tools, charting, and HTTP access',
		requires: {
			llm: { classType: 'llm', label: 'LLM Provider' },
		},
		components: [
			{ id: 'chat_1', provider: 'chat', position: { x: -38, y: -46 }, input: [], control: [] },
			{
				id: 'agent_rocketride_1',
				provider: 'agent_rocketride',
				position: { x: 264, y: -18 },
				input: [{ lane: 'questions', from: 'chat_1' }],
				control: [],
			},
			{
				id: 'memory_internal_1',
				provider: 'memory_internal',
				position: { x: 32, y: 198 },
				input: [],
				control: [{ classType: 'memory', from: 'agent_rocketride_1' }],
			},
			{
				id: 'chart_chartjs_1',
				provider: 'chart_chartjs',
				position: { x: 283, y: 325 },
				input: [],
				control: [{ classType: 'tool', from: 'agent_rocketride_1' }],
			},
			{
				id: 'tool_http_request_1',
				provider: 'tool_http_request',
				position: { x: 545, y: 208 },
				input: [],
				control: [{ classType: 'tool', from: 'agent_rocketride_1' }],
			},
			{
				id: 'llm_1',
				ref: 'llm',
				position: { x: 108, y: 474 },
				input: [],
				control: [
					{ classType: 'llm', from: 'agent_rocketride_1' },
					{ classType: 'llm', from: 'chart_chartjs_1' },
				],
			},
			{
				id: 'response_answers_1',
				provider: 'response_answers',
				position: { x: 605, y: 10 },
				input: [{ lane: 'answers', from: 'agent_rocketride_1' }],
				control: [],
			},
		],
	},
};

// ---------------------------------------------------------------------------
// Tree item
// ---------------------------------------------------------------------------

class TemplateItem extends vscode.TreeItem {
	constructor(
		public readonly slug: string,
		public readonly template: TemplateInfo
	) {
		super(template.title, vscode.TreeItemCollapsibleState.None);
		this.tooltip = template.description;
		this.description = template.description;
		this.iconPath = new vscode.ThemeIcon('file-code');
		this.command = {
			command: 'rocketride.templates.create',
			title: 'Create Pipeline from Template',
			arguments: [slug],
		};
	}
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SidebarTemplatesProvider implements vscode.TreeDataProvider<TemplateItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<TemplateItem | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	getTreeItem(element: TemplateItem): vscode.TreeItem {
		return element;
	}

	getChildren(): TemplateItem[] {
		return Object.entries(TEMPLATES).map(([slug, tpl]) => new TemplateItem(slug, tpl));
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}
}

// ---------------------------------------------------------------------------
// Command handler: create .pipe from template
// ---------------------------------------------------------------------------

/**
 * Resolve `ref` slots in a template by prompting the user to pick a provider
 * for each `requires` entry. Returns the resolved components array, or
 * `undefined` if the user cancelled a picker.
 */
async function resolveRequirements(template: TemplateInfo): Promise<TemplateComponent[] | undefined> {
	const refToProvider: Record<string, string> = {};

	for (const [slotKey, req] of Object.entries(template.requires)) {
		const options = PROVIDER_OPTIONS[req.classType];
		if (!options || options.length === 0) continue;

		const picked = await vscode.window.showQuickPick(
			options.map((o) => ({ label: o.label, providerKey: o.provider })),
			{ placeHolder: `Choose ${req.label}`, ignoreFocusOut: true }
		);
		if (!picked) return undefined; // user cancelled
		refToProvider[slotKey] = picked.providerKey;
	}

	return template.components.map((c) => {
		if (c.ref && refToProvider[c.ref]) {
			const { ref: _ref, ...rest } = c;
			return { ...rest, provider: refToProvider[c.ref] };
		}
		return c;
	});
}

/**
 * Register the `rocketride.templates.create` command.
 * Call this from `activate()` and push the returned disposable.
 */
export function registerTemplateCreateCommand(): vscode.Disposable {
	return vscode.commands.registerCommand('rocketride.templates.create', async (slug?: string) => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showWarningMessage('No workspace folder open. Open a folder first.');
			return;
		}

		// If no slug provided (e.g. called from command palette), let user pick
		if (!slug) {
			const items = Object.entries(TEMPLATES).map(([s, t]) => ({
				label: t.title,
				description: t.description,
				slug: s,
			}));
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: 'Select a pipeline template',
			});
			if (!picked) return;
			slug = picked.slug;
		}

		const template = TEMPLATES[slug];
		if (!template) {
			vscode.window.showErrorMessage(`Unknown template: ${slug}`);
			return;
		}

		// Resolve requires slots via QuickPick
		const components = await resolveRequirements(template);
		if (!components) return; // user cancelled

		// Build .pipe content
		const pipeline = {
			project_id: crypto.randomUUID(),
			components,
		};

		// Find a unique filename
		let fileName = `${slug}.pipe`;
		let counter = 1;
		let fileUri = vscode.Uri.joinPath(workspaceFolder.uri, fileName);
		for (;;) {
			try {
				await vscode.workspace.fs.stat(fileUri);
				// File exists, try next
				counter++;
				fileName = `${slug}-${counter}.pipe`;
				fileUri = vscode.Uri.joinPath(workspaceFolder.uri, fileName);
			} catch {
				break; // doesn't exist, use this name
			}
		}

		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(pipeline, null, 2), 'utf8'));

		// Open in the custom editor after a short delay to let providers initialize
		setTimeout(() => {
			vscode.commands.executeCommand('vscode.openWith', fileUri, 'rocketride.PageEditor');
		}, 500);
	});
}

// ---------------------------------------------------------------------------
// Starter pipeline (RAG Chat with defaults) — used for first-run scaffolding
// ---------------------------------------------------------------------------

/**
 * Create the getting-started.pipe file with sensible defaults (chroma + llm_openai)
 * and open it in the custom editor. Safe to call multiple times — skips creation
 * if the file already exists.
 */
export async function scaffoldStarterPipeline(): Promise<void> {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) return;

	const starterFile = vscode.Uri.joinPath(workspaceFolder.uri, 'getting-started.pipe');

	try {
		await vscode.workspace.fs.stat(starterFile);
		// File already exists — just open it
	} catch {
		// File doesn't exist — create from RAG Chat template with defaults
		const ragChat = TEMPLATES['rag-chat'];
		const defaultProviders: Record<string, string> = {
			store: 'chroma',
			llm: 'llm_openai',
		};

		const components = ragChat.components.map((c) => {
			if (c.ref && defaultProviders[c.ref]) {
				const { ref: _ref, ...rest } = c;
				return { ...rest, provider: defaultProviders[c.ref] };
			}
			return c;
		});

		const pipeline = {
			project_id: crypto.randomUUID(),
			components,
		};

		await vscode.workspace.fs.writeFile(starterFile, Buffer.from(JSON.stringify(pipeline, null, 2), 'utf8'));
	}

	// Open in custom editor after a short delay (let providers initialize)
	setTimeout(() => {
		vscode.commands.executeCommand('vscode.openWith', starterFile, 'rocketride.PageEditor');
	}, 1000);
}
