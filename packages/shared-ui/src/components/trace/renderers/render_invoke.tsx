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
import { CollapsibleSection } from './utils';

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
type InvokeOutputRenderer = (payload: InvokePayload, data: InvokeData, operation: string) => ReactElement | null;
type InvokeOutputSummarizer = (payload: InvokePayload, data: InvokeData, operation: string) => string;

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

function truncate(value: unknown, maxLen: number = 200): string {
	if (value == null) return '';
	const s = typeof value === 'string' ? value : JSON.stringify(value);
	return s.length > maxLen ? s.slice(0, maxLen) + '\u2026' : s;
}

function renderResult(data: InvokeData): ReactElement | null {
	if (data.result == null) return null;
	if (typeof data.result === 'object') {
		return (
			<div style={RS.section}>
				<div style={RS.label}>Result</div>
				<div style={RS.sectionContent}>
					<div style={RS.textBlock}>{JSON.stringify(data.result, null, 2)}</div>
				</div>
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
		// Show the question text if available
		if (q?.questions && Array.isArray(q.questions) && q.questions.length > 0) {
			const first = q.questions[0] as Record<string, unknown>;
			if (first?.text && typeof first.text === 'string') {
				return first.text.length > 60 ? first.text.slice(0, 60) + '\u2026' : first.text;
			}
		}
		// Fall back to role
		if (q?.role && typeof q.role === 'string') return q.role;
		return 'LLM: Ask';
	}
	return `LLM: ${operation || payload.op || ''}`;
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
				<span style={RS.kvVal}>{operation || payload.op || ''}</span>
			</div>

			{isAsk && q && (
				<>
					{q.expectJson && (
						<div style={RS.kvRow}>
							<span style={RS.kvKey}>Format</span>
							<span style={RS.kvVal}>JSON expected</span>
						</div>
					)}

					{q.role && (
						<div style={{ ...RS.kvRow, marginBottom: 6 }}>
							<span style={RS.kvKey}>Role</span>
							<span style={RS.kvVal}>{String(q.role)}</span>
						</div>
					)}

					{Array.isArray(q.goals) && q.goals.length > 0 && (
						<div style={RS.section}>
							<div style={RS.label}>Goal{(q.goals as unknown[]).length > 1 ? 's' : ''}</div>
							<div style={RS.sectionContent}>
								{(q.goals as unknown[]).map((g: unknown, i: number) => (
									<div key={i} style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-blue)' }}>
										{String(g)}
									</div>
								))}
							</div>
						</div>
					)}

					{Array.isArray(q.questions) && q.questions.length > 0 && (
						<div style={RS.section}>
							<div style={RS.label}>Question{(q.questions as unknown[]).length > 1 ? 's' : ''}</div>
							<div style={RS.sectionContent}>
								{(q.questions as unknown[]).map((qt: unknown, i: number) => {
									const item = qt as Record<string, unknown>;
									return item.text ? (
										<div key={i} style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-purple)' }}>
											{String(item.text)}
										</div>
									) : null;
								})}
							</div>
						</div>
					)}

					{Array.isArray(q.instructions) && q.instructions.length > 0 && (
						<CollapsibleSection label={`Instructions (${q.instructions.length})`}>
							{q.instructions.map((inst: unknown, i: number) => {
								const item = inst as Record<string, unknown>;
								return (
									<div key={i} style={{ marginBottom: 6, marginTop: i > 0 ? 8 : 0 }}>
										{item.subtitle != null && <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--rr-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>{String(item.subtitle)}</div>}
										{item.instructions != null && <div style={{ ...RS.textBlock, fontSize: 11, maxHeight: 100, marginLeft: 10, borderLeft: '3px solid var(--rr-chart-yellow)' }}>{String(item.instructions).trim()}</div>}
									</div>
								);
							})}
						</CollapsibleSection>
					)}

					{Array.isArray(q.context) && q.context.length > 0 && (
						<CollapsibleSection label={`Context (${q.context.length})`}>
							{q.context.map((ctx: unknown, i: number) => (
								<div key={i} style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-green)', maxHeight: 150 }}>
									{String(ctx)}
								</div>
							))}
						</CollapsibleSection>
					)}

					{Array.isArray(q.history) && q.history.length > 0 && (
						<CollapsibleSection label={`History (${q.history.length})`}>
							{q.history.map((h: unknown, i: number) => {
								const item = h as Record<string, unknown>;
								return (
									<div key={i} style={RS.kvRow}>
										<span style={{ ...RS.kvKey, fontWeight: 600 }}>{String(item.role || 'message')}</span>
										<span style={RS.kvVal}>{truncate(item.content || item.text || item)}</span>
									</div>
								);
							})}
						</CollapsibleSection>
					)}
				</>
			)}

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
		</div>
	);
};

// =============================================================================
// IInvokeMemory
// =============================================================================

const summarize_IInvokeMemory: InvokeSummarizer = (payload, _data, _operation) => {
	const toolName = payload.tool_name || '';
	const input = payload.input as Record<string, unknown> | null;
	const key = input?.key;
	if (key) return `Memory: ${toolName} (${String(key)})`;
	return `Memory: ${toolName}`;
};

const render_IInvokeMemory: InvokeRenderer = (payload, _data, _operation) => {
	const toolName = payload.tool_name || '';
	const input = payload.input as Record<string, unknown> | null;

	return (
		<div>
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Operation</span>
				<span style={RS.kvVal}>{toolName}</span>
			</div>

			{input?.key != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Key</span>
					<span style={RS.kvMono}>{String(input.key)}</span>
				</div>
			)}

			{input?.value != null && (
				<div style={RS.section}>
					<div style={RS.label}>Value</div>
					<div style={RS.sectionContent}>
						<div style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-green)' }}>{typeof input.value === 'string' ? input.value : JSON.stringify(input.value, null, 2)}</div>
					</div>
				</div>
			)}
		</div>
	);
};

const summarizeOutput_IInvokeMemory: InvokeOutputSummarizer = (payload, data, _operation) => {
	const result = data.result as Record<string, unknown> | null;
	if (!result) return '';
	const output = (payload.output || result) as Record<string, unknown>;
	if (output.ok === true) return 'ok';
	if (output.value != null) {
		const s = typeof output.value === 'string' ? output.value : JSON.stringify(output.value);
		return s.length > 60 ? s.slice(0, 60) + '\u2026' : s;
	}
	return '';
};

const renderOutput_IInvokeMemory: InvokeOutputRenderer = (payload, data, _operation) => {
	const result = data.result as Record<string, unknown> | null;
	if (!result) return null;
	const output = (payload.output || result) as Record<string, unknown>;

	return (
		<div>
			{output.ok != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Status</span>
					<span style={RS.kvVal}>{output.ok ? 'ok' : 'error'}</span>
				</div>
			)}

			{output.key != null && (
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Key</span>
					<span style={RS.kvMono}>{String(output.key)}</span>
				</div>
			)}

			{output.value != null && (
				<div style={RS.section}>
					<div style={RS.label}>Value</div>
					<div style={RS.sectionContent}>
						<div style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-green)' }}>{typeof output.value === 'string' ? output.value : JSON.stringify(output.value, null, 2)}</div>
					</div>
				</div>
			)}
		</div>
	);
};

// =============================================================================
// Generic fallback — summary only, no Data renderer for unknown types
// =============================================================================

const summarize_generic: InvokeSummarizer = (payload, _data, operation) => {
	const [category] = splitType(payload.type);
	const op = payload.op;
	if (category && operation) return `${category}: ${operation}`;
	if (op) return op;
	return payload.type || 'invoke';
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
// OUTPUT RENDERERS
// =============================================================================

const summarizeOutput_IInvokeLLM: InvokeOutputSummarizer = (_payload, data, operation) => {
	if (operation === 'Ask') {
		const r = data.result as Record<string, unknown> | null;
		if (r?.answer) {
			const a = r.answer;
			if (typeof a === 'string') return a.length > 60 ? a.slice(0, 60) + '\u2026' : a;
			const obj = a as Record<string, unknown>;
			if (obj.summary && typeof obj.summary === 'string') return String(obj.summary).length > 60 ? String(obj.summary).slice(0, 60) + '\u2026' : String(obj.summary);
		}
		return 'LLM Answer';
	}
	// Scalar ops
	if (data.result != null) return String(data.result);
	return '';
};

const renderOutput_IInvokeLLM: InvokeOutputRenderer = (_payload, data, operation) => {
	if (operation === 'Ask') return renderLLMAskOutput(data);
	return renderResult(data);
};

// Tool/Memory: return null to fall through to DiffView
const renderOutput_IInvokeTool: InvokeOutputRenderer = () => null;

const summarizeOutput_generic: InvokeOutputSummarizer = (_payload, data) => {
	if (data.result != null) {
		const s = typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
		return s.length > 60 ? s.slice(0, 60) + '\u2026' : s;
	}
	return '';
};

const OUTPUT_RENDERERS: Record<string, InvokeOutputRenderer> = {
	IInvokeLLM: renderOutput_IInvokeLLM,
	IInvokeTool: renderOutput_IInvokeTool,
	IInvokeMemory: renderOutput_IInvokeMemory,
};

const OUTPUT_SUMMARIZERS: Record<string, InvokeOutputSummarizer> = {
	IInvokeLLM: summarizeOutput_IInvokeLLM,
	IInvokeMemory: summarizeOutput_IInvokeMemory,
};

// =============================================================================
// LLM ASK — STRUCTURED ANSWER RENDERER
// =============================================================================

function renderLLMAskOutput(data: InvokeData): ReactElement {
	const result = data.result;
	if (result == null) {
		return <div style={RS.muted}>No result</div>;
	}
	if (typeof result !== 'object') {
		return (
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Result</span>
				<span style={RS.kvMono}>{String(result)}</span>
			</div>
		);
	}

	// Result shape is Answer: { answer: string | dict | list, expectJson: bool }
	const r = result as Record<string, unknown>;
	const answer = r.answer;

	if (answer == null) {
		return <div style={RS.muted}>No answer</div>;
	}

	// String answer
	if (typeof answer === 'string') {
		return (
			<div style={RS.section}>
				<div style={RS.label}>Answer</div>
				<div style={RS.sectionContent}>
					<div style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-green)' }}>{answer}</div>
					<div style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginTop: 2 }}>
						{answer.length.toLocaleString()} chars {'\u00B7'} ~{Math.round(answer.split(/\s+/).length)} words
					</div>
				</div>
			</div>
		);
	}

	// Object or array answer — render as formatted JSON
	return (
		<div style={RS.section}>
			<div style={RS.label}>Answer {r.expectJson ? '(JSON)' : ''}</div>
			<div style={RS.sectionContent}>
				<div style={{ ...RS.textBlock, borderLeft: '3px solid var(--rr-chart-green)' }}>{JSON.stringify(answer, null, 2)}</div>
			</div>
		</div>
	);
}

// =============================================================================
// PUBLIC API — INPUT
// =============================================================================

export function summaryInvokeInput(data: InvokeData): string {
	const payload = getPayload(data);
	if (!payload) return 'invoke';
	const [category, operation] = splitType(payload.type);
	const summarizer = SUMMARIZERS[category] || summarize_generic;
	return summarizer(payload, data, operation);
}

export function renderInvokeInput(data: InvokeData): ReactElement | null {
	const payload = getPayload(data);

	if (!payload) {
		return (
			<div>
				<div style={RS.kvRow}>
					<span style={RS.kvKey}>Control</span>
					<span style={RS.kvVal}>{data.control || 'invoke'}</span>
				</div>
			</div>
		);
	}

	const [category, operation] = splitType(payload.type);
	const renderer = RENDERERS[category];
	if (!renderer) return null;
	return renderer(payload, data, operation);
}

// =============================================================================
// PUBLIC API — OUTPUT
// =============================================================================

export function summaryInvokeOutput(data: InvokeData, _inputData?: unknown): string {
	const payload = getPayload(data);
	if (!payload) return '';
	const [category, operation] = splitType(payload.type);
	const summarizer = OUTPUT_SUMMARIZERS[category] || summarizeOutput_generic;
	return summarizer(payload, data, operation);
}

export function renderInvokeOutput(data: InvokeData, _inputData?: unknown): ReactElement | null {
	const payload = getPayload(data);
	if (!payload) return renderResult(data);
	const [category, operation] = splitType(payload.type);
	const renderer = OUTPUT_RENDERERS[category];
	if (!renderer) return null;
	return renderer(payload, data, operation);
}
