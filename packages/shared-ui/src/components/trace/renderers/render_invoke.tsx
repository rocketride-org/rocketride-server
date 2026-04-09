// =============================================================================
// Trace Renderer: Invoke Lane
//
// Dispatches to type-specific renderers via a lookup table keyed by
// args[0].type (the Python class name from IInvoke's @computed_field).
//
// To add support for a new invoke type, add an entry to RENDERERS and
// SUMMARIZERS with the class name as key.
// =============================================================================

import { ReactElement } from 'react';
import { RS } from './styles';

// =============================================================================
// TYPES
// =============================================================================

interface InvokePayload {
	type?: string;
	op?: string;
	question?: unknown;
	tool_name?: string;
	input?: unknown;
	output?: unknown;
	tools?: unknown[];
	control?: string;
	result?: unknown;
	[key: string]: unknown;
}

interface InvokeData {
	args?: unknown[];
	control?: string;
	kwargs?: Record<string, unknown>;
	result?: unknown;
	type?: string;
}

type InvokeRenderer = (payload: InvokePayload, data: InvokeData) => ReactElement;
type InvokeSummarizer = (payload: InvokePayload, data: InvokeData) => string;

// =============================================================================
// TYPE GUARD
// =============================================================================

export function isInvoke(data: unknown): data is InvokeData {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	return d.control === 'invoke' || (Array.isArray(d.args) && d.args.length > 0);
}

// =============================================================================
// HELPERS
// =============================================================================

function getPayload(data: InvokeData): InvokePayload | null {
	if (data.args && Array.isArray(data.args) && data.args.length > 0) {
		const first = data.args[0];
		if (first && typeof first === 'object') return first as InvokePayload;
	}
	return null;
}

const OP_LABELS: Record<string, string> = {
	ask: 'Ask',
	getContextLength: 'Get Context Length',
	getOutputLength: 'Get Output Length',
	getTokenCounter: 'Get Token Counter',
	'tool.query': 'Query',
	'tool.invoke': 'Invoke',
	'tool.validate': 'Validate',
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
const KNOWN_FIELDS = new Set(['type', 'op', 'control', 'result', 'question', 'tool_name', 'input', 'output', 'tools']);

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

const summarize_IInvokeLLM: InvokeSummarizer = (payload) => {
	const op = payload.op;
	if (op === 'ask') {
		const q = payload.question as Record<string, unknown> | null;
		if (q?.role && typeof q.role === 'string') return q.role;
	}
	return op ? `LLM: ${opLabel(op)}` : 'LLM';
};

const render_IInvokeLLM: InvokeRenderer = (payload, data) => {
	const op = payload.op;
	const q = payload.question as Record<string, unknown> | null;

	return (
		<div>
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Type</span>
				<span style={RS.kvVal}>LLM</span>
			</div>
			{op && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Operation</span>
					<span style={RS.kvVal}>{opLabel(op)}</span>
				</div>
			)}

			{op === 'ask' && q && (
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
					)}

					{Array.isArray(q.context) && q.context.length > 0 && (
						<div style={RS.section}>
							<div style={RS.label}>Context ({q.context.length})</div>
							{q.context.map((ctx: unknown, i: number) => (
								<div key={i} style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-green)', maxHeight: 150 }}>
									{String(ctx)}
								</div>
							))}
						</div>
					)}

					{Array.isArray(q.history) && q.history.length > 0 && (
						<div style={RS.section}>
							<div style={RS.label}>History ({q.history.length})</div>
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
					)}

					{q.expectJson && (
						<div style={RS.kvRow}>
							<span style={RS.kvKey}>Format</span>
							<span style={RS.kvVal}>JSON expected</span>
						</div>
					)}
				</>
			)}

			{op !== 'ask' && payload.question != null && typeof payload.question === 'string' && (
				<div style={RS.section}>
					<div style={RS.label}>Question</div>
					<div style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-green)' }}>{payload.question}</div>
				</div>
			)}

			{renderExtras(payload)}
			{renderResult(data)}
		</div>
	);
};

// =============================================================================
// IInvokeTool (covers Query, Invoke, Validate inner classes)
// =============================================================================

const summarize_IInvokeTool: InvokeSummarizer = (payload) => {
	const t = payload.type;
	const op = payload.op;

	if (t === 'Query' || op === 'tool.query') {
		return Array.isArray(payload.tools) ? `Tool Discovery (${payload.tools.length} tools)` : 'Tool Discovery';
	}
	if (t === 'Validate' || op === 'tool.validate') {
		return payload.tool_name ? `Validate: ${payload.tool_name}` : 'Tool Validate';
	}
	return payload.tool_name ? `Tool: ${payload.tool_name}` : 'Tool Invoke';
};

const render_IInvokeTool: InvokeRenderer = (payload, data) => {
	const t = payload.type;
	const op = payload.op;
	const isQuery = t === 'Query' || op === 'tool.query';
	const isValidate = t === 'Validate' || op === 'tool.validate';

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
			)}

			{payload.input != null && (
				<div style={RS.section}>
					<div style={RS.label}>Input</div>
					<div style={RS.textBlock}>{typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input, null, 2)}</div>
				</div>
			)}

			{payload.output != null && (
				<div style={RS.section}>
					<div style={RS.label}>Output</div>
					<div style={RS.textBlock}>{typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output, null, 2)}</div>
				</div>
			)}

			{renderExtras(payload)}
			{renderResult(data)}
		</div>
	);
};

// =============================================================================
// Generic fallback
// =============================================================================

const summarize_generic: InvokeSummarizer = (payload) => {
	const t = payload.type;
	const op = payload.op;
	if (t && op) return `${t}: ${opLabel(op)}`;
	return t || (op ? opLabel(op) : 'invoke');
};

const render_generic: InvokeRenderer = (payload, data) => (
	<div>
		{payload.type && (
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Type</span>
				<span style={RS.kvVal}>{payload.type}</span>
			</div>
		)}
		{payload.op && (
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Operation</span>
				<span style={RS.kvVal}>{opLabel(payload.op)}</span>
			</div>
		)}
		{renderExtras(payload)}
		{renderResult(data)}
	</div>
);

// =============================================================================
// DISPATCH TABLES
//
// To add a new invoke type: add its class name as key, point to the
// render/summarize functions.  The inner IInvokeTool classes (Query,
// Invoke, Validate) are all handled by the IInvokeTool entry.
// =============================================================================

const RENDERERS: Record<string, InvokeRenderer> = {
	IInvokeLLM: render_IInvokeLLM,
	IInvokeTool: render_IInvokeTool,
	Query: render_IInvokeTool,
	Invoke: render_IInvokeTool,
	Validate: render_IInvokeTool,
};

const SUMMARIZERS: Record<string, InvokeSummarizer> = {
	IInvokeLLM: summarize_IInvokeLLM,
	IInvokeTool: summarize_IInvokeTool,
	Query: summarize_IInvokeTool,
	Invoke: summarize_IInvokeTool,
	Validate: summarize_IInvokeTool,
};

// =============================================================================
// PUBLIC API
// =============================================================================

export function summaryInvoke(data: InvokeData): string {
	const payload = getPayload(data);
	if (!payload) return 'invoke';
	const summarizer = (payload.type && SUMMARIZERS[payload.type]) || summarize_generic;
	return summarizer(payload, data);
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

	const renderer = (payload.type && RENDERERS[payload.type]) || render_generic;
	return renderer(payload, data);
}
