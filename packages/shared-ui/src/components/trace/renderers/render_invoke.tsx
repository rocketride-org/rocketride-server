// =============================================================================
// Trace Renderer: Invoke Lane
//
// Dispatches to type-specific renderers via a lookup table keyed by the
// category portion of param.type (e.g. "IInvokeLLM" from "IInvokeLLM.Ask").
//
// To add support for a new invoke type: add a render/summarize pair and
// register the category name in RENDERERS and SUMMARIZERS.
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';

// =============================================================================
// TYPES
// =============================================================================

interface InvokePayload {
	type?: string;
	lane?: string;
	op?: string;
	question?: unknown;
	tool_name?: string;
	input?: unknown;
	output?: unknown;
	tools?: unknown[];
	key?: string;
	value?: unknown;
	[key: string]: unknown;
}

interface InvokeData {
	param?: unknown;
	control?: string;
	result?: unknown;
}

type InvokeRenderer = (payload: InvokePayload, data: InvokeData, operation: string) => ReactElement;
type InvokeSummarizer = (payload: InvokePayload, data: InvokeData, operation: string) => string;

// =============================================================================
// TYPE GUARD
// =============================================================================

export function isInvoke(data: unknown): data is InvokeData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	// New format: param field
	if (d.param && typeof d.param === 'object') return true;
	// Legacy format: args array
	if (d.control === 'invoke' || (Array.isArray(d.args) && (d.args as unknown[]).length > 0)) return true;
	return false;
}

// =============================================================================
// HELPERS
// =============================================================================

function getPayload(data: InvokeData): InvokePayload | null {
	// New format: data.param
	if (data.param && typeof data.param === 'object') return data.param as InvokePayload;
	// Legacy format: data.args[0]
	const d = data as Record<string, unknown>;
	if (Array.isArray(d.args) && d.args.length > 0) {
		const first = d.args[0];
		if (first && typeof first === 'object') return first as InvokePayload;
	}
	return null;
}

/** Split "IInvokeLLM.Ask" into ["IInvokeLLM", "Ask"]. */
function splitType(type: string | undefined): [string, string] {
	if (!type) return ['', ''];
	const dot = type.indexOf('.');
	if (dot < 0) return [type, ''];
	return [type.slice(0, dot), type.slice(dot + 1)];
}

const OP_LABELS: Record<string, string> = {
	ask: 'Ask',
	getContextLength: 'Get Context Length',
	getOutputLength: 'Get Output Length',
	getTokenCounter: 'Get Token Counter',
	'tool.query': 'Query',
	'tool.invoke': 'Invoke',
	'tool.validate': 'Validate',
	'memory.put': 'Put',
	'memory.get': 'Get',
	'memory.list': 'List',
	'memory.clear': 'Clear',
};

function opLabel(op: string): string {
	return OP_LABELS[op] || op;
}

function truncate(value: unknown, maxLen: number = 200): string {
	if (value == null) return '';
	const s = typeof value === 'string' ? value : JSON.stringify(value);
	return s.length > maxLen ? s.slice(0, maxLen) + '\u2026' : s;
}

/** Fields consumed by known renderers — extras are anything else. */
const KNOWN_FIELDS = new Set(['type', 'lane', 'op', 'control', 'result', 'question', 'tool_name', 'input', 'output', 'tools', 'key', 'value']);

function renderExtras(payload: InvokePayload): ReactElement | null {
	const extras = Object.entries(payload).filter(([k]) => !KNOWN_FIELDS.has(k));
	if (extras.length === 0) return null;
	return (
		<div style={RS.section}>
			<div style={RS.label}>Details</div>
			{extras.map(([k, v]) => (
				<div key={k} style={RS.kvRow}>
					<span style={RS.kvKey}>{k}</span>
					<span style={RS.kvVal}>{truncate(v)}</span>
				</div>
			))}
		</div>
	);
}

function renderResult(data: InvokeData): ReactElement | null {
	if (data.result == null) return null;
	if (typeof data.result === 'object') {
		return (
			<div style={RS.section}>
				<div style={RS.label}>Result</div>
				<div style={RS.textBlock}>{JSON.stringify(data.result, null, 2)}</div>
			</div>
		);
	}
	return (
		<div style={RS.kvRow}>
			<span style={RS.kvKey}>Result</span>
			<span style={RS.kvMono}>{String(data.result)}</span>
		</div>
	);
}

// =============================================================================
// IInvokeLLM
// =============================================================================

const summarize_IInvokeLLM: InvokeSummarizer = (payload, _data, operation) => {
	if (operation === 'Ask') {
		const q = payload.question as Record<string, unknown> | null;
		if (q?.role && typeof q.role === 'string') return q.role;
		return 'LLM: Ask';
	}
	return `LLM: ${operation || opLabel(payload.op || '')}`;
};

const render_IInvokeLLM: InvokeRenderer = (payload, data, operation) => {
	const q = payload.question as Record<string, unknown> | null;
	const isAsk = operation === 'Ask' || payload.op === 'ask';

	return (
		<div>
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Type</span>
				<span style={RS.kvVal}>LLM</span>
			</div>
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Operation</span>
				<span style={RS.kvVal}>{operation || opLabel(payload.op || '')}</span>
			</div>

			{isAsk && q && (
				<>
					{q.role && (
						<div style={RS.kvRow}>
							<span style={RS.kvKey}>Role</span>
							<span style={RS.kvVal}>{String(q.role)}</span>
						</div>
					)}

					{Array.isArray(q.instructions) && q.instructions.length > 0 && (
						<div style={RS.section}>
							<div style={RS.label}>Instructions ({q.instructions.length})</div>
							<div style={RS.sectionContent}>
								{q.instructions.map((inst: unknown, i: number) => {
									const item = inst as Record<string, unknown>;
									return (
										<div key={i} style={{ marginBottom: 4 }}>
											{item.subtitle != null && <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--rr-text-secondary)' }}>{String(item.subtitle)}</div>}
											{item.instructions != null && <div style={{ ...RS.textBlock, fontSize: 11, maxHeight: 100 }}>{String(item.instructions).trim()}</div>}
										</div>
									);
								})}
							</div>
						</div>
					)}

					{Array.isArray(q.context) && q.context.length > 0 && (
						<div style={RS.section}>
							<div style={RS.label}>Context ({q.context.length})</div>
							<div style={RS.sectionContent}>
								{q.context.map((ctx: unknown, i: number) => (
									<div key={i} style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-green)', maxHeight: 150 }}>
										{String(ctx)}
									</div>
								))}
							</div>
						</div>
					)}

					{Array.isArray(q.history) && q.history.length > 0 && (
						<div style={RS.section}>
							<div style={RS.label}>History ({q.history.length})</div>
							<div style={RS.sectionContent}>
								{q.history.map((h: unknown, i: number) => {
									const item = h as Record<string, unknown>;
									return (
										<div key={i} style={RS.kvRow}>
											<span style={{ ...RS.kvKey, fontWeight: 600 }}>{String(item.role || 'message')}</span>
											<span style={RS.kvVal}>{truncate(item.content || item.text || item)}</span>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{q.expectJson && (
						<div style={RS.kvRow}>
							<span style={RS.kvKey}>Format</span>
							<span style={RS.kvVal}>JSON expected</span>
						</div>
					)}
				</>
			)}

			{renderExtras(payload)}
			{renderResult(data)}
		</div>
	);
};

// =============================================================================
// IInvokeTool
// =============================================================================

const summarize_IInvokeTool: InvokeSummarizer = (payload, _data, operation) => {
	if (operation === 'Query') {
		return Array.isArray(payload.tools) ? `Tool Discovery (${payload.tools.length} tools)` : 'Tool Discovery';
	}
	if (operation === 'Validate') {
		return payload.tool_name ? `Validate: ${payload.tool_name}` : 'Tool Validate';
	}
	return payload.tool_name ? `Tool: ${payload.tool_name}` : 'Tool Invoke';
};

const render_IInvokeTool: InvokeRenderer = (payload, _data, operation) => {
	const isQuery = operation === 'Query' || payload.op === 'tool.query';
	const isValidate = operation === 'Validate' || payload.op === 'tool.validate';

	return (
		<div>
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Type</span>
				<span style={RS.kvVal}>{isQuery ? 'Tool Discovery' : isValidate ? 'Tool Validate' : 'Tool Call'}</span>
			</div>

			{payload.tool_name && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Tool</span>
					<span style={RS.kvMono}>{payload.tool_name}</span>
				</div>
			)}

			{isQuery && Array.isArray(payload.tools) && payload.tools.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Discovered Tools ({payload.tools.length})</div>
					<div style={RS.sectionContent}>
						{payload.tools.map((tool, i) => {
							const tl = tool as Record<string, unknown>;
							const name = tl.name || tl.tool_name || `Tool ${i + 1}`;
							const desc = tl.description ? String(tl.description) : '';
							return (
								<div key={i} style={RS.kvRow}>
									<span style={RS.kvMono}>{String(name)}</span>
									{desc && <span style={{ ...RS.kvVal, fontSize: 10, color: 'var(--rr-text-secondary)' }}>{truncate(desc, 80)}</span>}
								</div>
							);
						})}
					</div>
				</div>
			)}

			{renderExtras(payload)}
		</div>
	);
};

// =============================================================================
// IInvokeMemory
// =============================================================================

const summarize_IInvokeMemory: InvokeSummarizer = (payload, _data, operation) => {
	if (payload.key) return `Memory ${operation}: ${payload.key}`;
	return `Memory: ${operation || opLabel(payload.op || '')}`;
};

const render_IInvokeMemory: InvokeRenderer = (payload, _data, operation) => (
	<div>
		<div style={RS.kvRow}>
			<span style={RS.kvKey}>Type</span>
			<span style={RS.kvVal}>Memory</span>
		</div>
		<div style={RS.kvRow}>
			<span style={RS.kvKey}>Operation</span>
			<span style={RS.kvVal}>{operation || opLabel(payload.op || '')}</span>
		</div>

		{payload.key && (
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Key</span>
				<span style={RS.kvMono}>{payload.key}</span>
			</div>
		)}

		{renderExtras(payload)}
	</div>
);

// =============================================================================
// Generic fallback
// =============================================================================

const summarize_generic: InvokeSummarizer = (payload, _data, operation) => {
	const [category] = splitType(payload.type);
	const op = payload.op;
	if (category && operation) return `${category}: ${operation}`;
	if (op) return opLabel(op);
	return payload.type || 'invoke';
};

const render_generic: InvokeRenderer = (payload, data, operation) => {
	const [category] = splitType(payload.type);
	return (
		<div>
			{category && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Type</span>
					<span style={RS.kvVal}>{category}</span>
				</div>
			)}
			{(operation || payload.op) && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Operation</span>
					<span style={RS.kvVal}>{operation || opLabel(payload.op || '')}</span>
				</div>
			)}
			{renderExtras(payload)}
			{renderResult(data)}
		</div>
	);
};

// =============================================================================
// DISPATCH TABLES
//
// Keyed by the category portion of param.type (before the dot).
// e.g. "IInvokeLLM.Ask" → category "IInvokeLLM" → render_IInvokeLLM
// =============================================================================

const RENDERERS: Record<string, InvokeRenderer> = {
	IInvokeLLM: render_IInvokeLLM,
	IInvokeTool: render_IInvokeTool,
	IInvokeMemory: render_IInvokeMemory,
};

const SUMMARIZERS: Record<string, InvokeSummarizer> = {
	IInvokeLLM: summarize_IInvokeLLM,
	IInvokeTool: summarize_IInvokeTool,
	IInvokeMemory: summarize_IInvokeMemory,
};

// =============================================================================
// PUBLIC API
// =============================================================================

export function summaryInvoke(data: InvokeData): string {
	const payload = getPayload(data);
	if (!payload) return 'invoke';
	const [category, operation] = splitType(payload.type);
	const summarizer = SUMMARIZERS[category] || summarize_generic;
	return summarizer(payload, data, operation);
}

export function renderInvoke(data: InvokeData): ReactElement {
	const payload = getPayload(data);

	if (!payload) {
		return (
			<div>
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Control</span>
					<span style={RS.kvVal}>{data.control || 'invoke'}</span>
				</div>
				{renderResult(data)}
			</div>
		);
	}

	const [category, operation] = splitType(payload.type);
	const renderer = RENDERERS[category] || render_generic;
	return renderer(payload, data, operation);
}
