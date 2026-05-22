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
import { renderQuestionFields, summaryQuestionFields, QuestionFields } from './format_question';
import { renderAnswerFields, summaryAnswerFields, AnswerFields } from './format_answer';

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
		const summary = summaryQuestionFields(payload.question as QuestionFields | null);
		return summary || 'LLM: Ask';
	}
	return `LLM: ${operation || payload.op || ''}`;
};

const render_IInvokeLLM: InvokeRenderer = (payload, data, operation) => {
	const q = payload.question as QuestionFields | null;
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

			{isAsk && renderQuestionFields(q)}

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
// IInvokeCrew
// =============================================================================

const summarize_IInvokeCrew: InvokeSummarizer = (payload, _data, _operation) => {
	const agents = payload.agents as unknown[] | undefined;
	if (Array.isArray(agents) && agents.length > 0) {
		return `Crew Discovery (${agents.length} agents)`;
	}
	return 'Crew: describe';
};

const render_IInvokeCrew: InvokeRenderer = (payload, _data, _operation) => {
	const agents = payload.agents as unknown[] | undefined;

	return (
		<div>
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Type</span>
				<span style={RS.kvVal}>Crew</span>
			</div>
			<div style={RS.kvRow}>
				<span style={RS.kvKey}>Operation</span>
				<span style={RS.kvVal}>{payload.op || 'describe'}</span>
			</div>

			{Array.isArray(agents) && agents.length > 0 && (
				<div style={RS.section}>
					<div style={RS.label}>Agents ({agents.length})</div>
					<div style={RS.sectionContent}>
						{agents.map((agent: unknown, i: number) => {
							const a = agent as Record<string, unknown>;
							return (
								<div key={i} style={{ marginBottom: 8, borderLeft: '3px solid var(--rr-chart-purple)', paddingLeft: 8 }}>
									{a.role && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--rr-text-primary)' }}>{String(a.role)}</div>}
									{a.task_description && <div style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginTop: 2 }}>{String(a.task_description)}</div>}
									{a.goal && (
										<div style={RS.kvRow}>
											<span style={RS.kvKey}>Goal</span>
											<span style={RS.kvVal}>{String(a.goal)}</span>
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
};

const renderOutput_IInvokeCrew: InvokeOutputRenderer = (_payload, data, _operation) => {
	// After describe fan-out, result contains the populated agents list
	return renderResult(data);
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
	IInvokeCrew: render_IInvokeCrew,
};

const SUMMARIZERS: Record<string, InvokeSummarizer> = {
	IInvokeLLM: summarize_IInvokeLLM,
	IInvokeTool: summarize_IInvokeTool,
	IInvokeMemory: summarize_IInvokeMemory,
	IInvokeCrew: summarize_IInvokeCrew,
};

// =============================================================================
// OUTPUT RENDERERS
// =============================================================================

const summarizeOutput_IInvokeLLM: InvokeOutputSummarizer = (_payload, data, operation) => {
	if (operation === 'Ask') {
		const summary = summaryAnswerFields(data.result as AnswerFields | null);
		return summary || 'LLM Answer';
	}
	// Scalar ops
	if (data.result != null) return String(data.result);
	return '';
};

const renderOutput_IInvokeLLM: InvokeOutputRenderer = (_payload, data, operation) => {
	if (operation === 'Ask') {
		const rendered = renderAnswerFields(data.result as AnswerFields | null);
		return rendered || <div style={RS.muted}>No answer</div>;
	}
	return renderResult(data);
};

// Tool: show discovered tools list for Query, fall through to DiffView for others
const renderOutput_IInvokeTool: InvokeOutputRenderer = (payload, _data, operation) => {
	const isQuery = operation === 'Query' || payload.op === 'tool.query';
	if (isQuery && Array.isArray(payload.tools) && payload.tools.length > 0) {
		return (
			<div style={RS.section}>
				<div style={RS.label}>Discovered Tools ({payload.tools.length})</div>
				<div style={RS.sectionContent}>
					{payload.tools.map((tool, i) => {
						const tl = tool as Record<string, unknown>;
						const name = tl.name || tl.tool_name || `Tool ${i + 1}`;
						const desc = tl.description ? String(tl.description) : '';
						return (
							<div key={i} style={{ marginBottom: 4 }}>
								<div style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 600, color: 'var(--rr-text-primary)' }}>{String(name)}</div>
								{desc && <div style={{ fontSize: 10, color: 'var(--rr-text-secondary)', marginLeft: 8 }}>{truncate(desc, 200)}</div>}
							</div>
						);
					})}
				</div>
			</div>
		);
	}
	return null;
};

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
	IInvokeCrew: renderOutput_IInvokeCrew,
};

const OUTPUT_SUMMARIZERS: Record<string, InvokeOutputSummarizer> = {
	IInvokeLLM: summarizeOutput_IInvokeLLM,
	IInvokeMemory: summarizeOutput_IInvokeMemory,
};

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
