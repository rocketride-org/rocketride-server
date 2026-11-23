// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// AGENT API - what the catalog picker's detail panel shows of an agent's API. The
// panel reads it with `client.interfaces(address)` when it opens: one read on
// the server, no engine started, nothing billed. The answer is the map
// `{ "<address>": { "<classType>": [{nodeId, name}] } }`: a source sits under
// its own address with the `source` classType beside its others (`chat`,
// `dropper`, `webhook`); every other node sits under the agent's address
// under each classType it carries (`database`, `tool`, `llm`). This module
// turns that map into one row per node, the sources apart from the rest.
// Pure; unit-tested under node:test.
// =============================================================================

/** The classType that marks a source in an `interfaces()` answer. */
const SOURCE_CLASS_TYPE = 'source';

/** One parameter as an `interfaces()` answer lists it. */
type ParameterAnswer = { name?: unknown; default?: unknown; type?: unknown; title?: unknown; description?: unknown; enum?: unknown; minimum?: unknown; maximum?: unknown } | null | undefined;

/** One node as an `interfaces()` answer lists it. */
type InterfaceNode = { nodeId?: unknown; name?: unknown } | null | undefined;

/** The `interfaces()` answer, as far as the panel reads it. */
export type InterfacesAnswer = {
	/** The agent's address (`developerId.pipelineId`). */
	address?: unknown;
	/** address -> classType -> nodes. */
	interfaces?: Record<string, Record<string, ReadonlyArray<InterfaceNode> | null | undefined> | null | undefined> | null;
	/** The per-call parameters, as a caller sees them. */
	parameters?: ReadonlyArray<ParameterAnswer> | null;
};

/** One row of an agent's API: a source a run starts at, or a node a call names. */
export type ApiRow = {
	/** The address the node answers under: a source's own, else the agent's. */
	address: string;
	/** The node's component id. */
	nodeId: string;
	/** The author's display name, else the component id. */
	name: string;
	/** The interfaces the node carries, in the answer's order, without `source`. */
	interfaces: string[];
};

/** An agent's API as the panel shows it. */
export type AgentApi = {
	/** The agent's address. */
	address: string;
	/** The sources, each under its own address. */
	sources: ApiRow[];
	/** Every other node, under the agent's address. */
	nodes: ApiRow[];
	/** The per-call parameters, in the publisher's order. */
	parameters: ApiParameter[];
};

/** One per-call parameter of an agent, ready to show. */
export type ApiParameter = {
	/** The public name a call sets in `params`. */
	name: string;
	/** The allowed values or the type with its bounds: `mask | token`, `number ≥ 0`, `int 256–4096`, `bool`. */
	type: string;
	/** What the parameter does: the description, else the title; '' when the node gives neither. */
	description: string;
	/** What a call gets when it omits the parameter, as text; '' when there is none. */
	default: string;
	/** The value a call example passes: the default (an empty string, false and 0 included), else the first allowed value, else a sample of the type inside its bounds. */
	example: unknown;
};

/**
 * The type text of a parameter: its allowed values, or its type with its bounds.
 *
 * @param parameter - The parameter as the answer lists it.
 * @returns `mask | token`, `number ≥ 0`, `int 256–4096`, `bool`, ...
 */
export function parameterType(parameter: { type?: unknown; enum?: unknown; minimum?: unknown; maximum?: unknown }): string {
	if (Array.isArray(parameter.enum) && parameter.enum.length) return parameter.enum.map(String).join(' | ');
	const declared = typeof parameter.type === 'string' && parameter.type ? parameter.type : 'value';
	const type = declared === 'integer' ? 'int' : declared === 'boolean' ? 'bool' : declared;
	if (declared === 'integer' || declared === 'number') {
		const low = typeof parameter.minimum === 'number' ? parameter.minimum : undefined;
		const high = typeof parameter.maximum === 'number' ? parameter.maximum : undefined;
		if (low !== undefined && high !== undefined) return `${type} ${low}–${high}`;
		if (low !== undefined) return `${type} ≥ ${low}`;
		if (high !== undefined) return `${type} ≤ ${high}`;
	}
	return type;
}

/**
 * A value a call example passes for a parameter that declares no default: its
 * first allowed value, else a value of its type inside its bounds.
 *
 * @param parameter - The parameter as the answer lists it.
 * @returns The sample.
 */
function sampleValue(parameter: { type?: unknown; enum?: unknown; minimum?: unknown; maximum?: unknown }): unknown {
	if (Array.isArray(parameter.enum) && parameter.enum.length) return parameter.enum[0];
	if (parameter.type === 'integer' || parameter.type === 'number') {
		const low = typeof parameter.minimum === 'number' ? parameter.minimum : undefined;
		const high = typeof parameter.maximum === 'number' ? parameter.maximum : undefined;
		if (low !== undefined) return low;
		return high !== undefined && high < 1 ? high : 1;
	}
	return parameter.type === 'boolean' ? true : 'value';
}

/**
 * An agent's API from an `interfaces()` answer: one row per node, the
 * sources apart from the other nodes, each in the answer's order.
 *
 * A node listed under several classTypes is one row carrying them all; a
 * node listed without an id is skipped.
 *
 * @param answer - The `interfaces()` answer.
 * @param address - The address that was asked, shown when the answer names none.
 * @returns The API, or null when the answer lists no node and no parameter (the agent has no API to show).
 */
export function agentApi(answer: InterfacesAnswer | null | undefined, address: string): AgentApi | null {
	const rows = new Map<string, ApiRow & { source: boolean }>();
	for (const [nodeAddress, byClass] of Object.entries(answer?.interfaces ?? {})) {
		for (const [classType, nodes] of Object.entries(byClass ?? {})) {
			for (const node of Array.isArray(nodes) ? nodes : []) {
				const nodeId = typeof node?.nodeId === 'string' ? node.nodeId : '';
				if (!nodeId) continue;
				const key = `${nodeAddress}/${nodeId}`;
				let row = rows.get(key);
				if (!row) {
					const name = typeof node?.name === 'string' && node.name ? node.name : nodeId;
					row = { address: nodeAddress, nodeId, name, interfaces: [], source: false };
					rows.set(key, row);
				}
				if (classType === SOURCE_CLASS_TYPE) row.source = true;
				else if (!row.interfaces.includes(classType)) row.interfaces.push(classType);
			}
		}
	}
	const parameters: ApiParameter[] = [];
	for (const parameter of Array.isArray(answer?.parameters) ? answer.parameters : []) {
		if (typeof parameter?.name !== 'string' || !parameter.name) continue;
		const text = typeof parameter.description === 'string' && parameter.description ? parameter.description : typeof parameter.title === 'string' ? parameter.title : '';
		const value = parameter.default;
		const shown = value === undefined || value === null || value === '' ? '' : typeof value === 'string' ? value : JSON.stringify(value);
		// An explicit default is the example, the empty string, false and 0 included
		const example = value === undefined || value === null ? sampleValue(parameter) : value;
		parameters.push({ name: parameter.name, type: parameterType(parameter), description: text, default: shown, example });
	}
	if (rows.size === 0 && parameters.length === 0) return null;

	const sources: ApiRow[] = [];
	const nodes: ApiRow[] = [];
	for (const { source, ...row } of rows.values()) (source ? sources : nodes).push(row);
	const own = typeof answer?.address === 'string' && answer.address ? answer.address : address;
	return { address: own, sources, nodes, parameters };
}
