// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Call examples for a pipeline's public parameters (mockup M-1.6, plan §5.5).
 *
 * One pure generator: the pipeline's address and its exposed parameters (with
 * an example value each) become a `submit()` call in JavaScript, TypeScript
 * and Python, and the HTTP door's request (plan §3.5: the dotted address in
 * one path segment, params on the query string, the account key in the
 * Authorization header). The PARAMS page renders these in live tabs; the
 * store listing (Step 6) embeds the same block.
 */

import type { ServiceParamDescriptor } from 'rocketride';

// =============================================================================
// Types
// =============================================================================

/** The example languages, in tab order. */
export type CallExampleTabId = 'javascript' | 'typescript' | 'python' | 'http';

/** One exposed parameter as the examples show it. */
export interface ICallExampleParam {
	/** The public name callers type. */
	name: string;
	/** The value the example passes (the effective default, or a type-shaped sample). */
	value: unknown;
}

/** What the generator needs. */
export interface IBuildCallExamplesParams {
	/** The pipeline's address (`developerId.pipeId`, optionally `.source`). */
	address: string;
	/** The exposed parameters, in table order. */
	params: ICallExampleParam[];
	/** The server origin for the HTTP example (`https://api.example.com`); a placeholder when unknown. */
	host?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** The tabs as the control shows them. */
export const CALL_EXAMPLE_TABS: ReadonlyArray<{ id: CallExampleTabId; label: string }> = [
	{ id: 'javascript', label: 'JavaScript' },
	{ id: 'typescript', label: 'TypeScript' },
	{ id: 'python', label: 'Python' },
	{ id: 'http', label: 'HTTP' },
];

/** The host the HTTP example shows when the page knows none. */
const HOST_PLACEHOLDER = 'https://{host}';

// =============================================================================
// Helpers
// =============================================================================

/**
 * The value an example passes for a parameter: its effective default when the
 * node has one, else a sample shaped by the descriptor's type.
 *
 * @param descriptor - The parameter's descriptor (type, enum, bounds, default).
 * @param effectiveDefault - The value the node's config currently holds, when any.
 * @returns The example value.
 */
export function exampleValue(descriptor: ServiceParamDescriptor, effectiveDefault: unknown): unknown {
	if (effectiveDefault !== undefined && effectiveDefault !== null && effectiveDefault !== '') return effectiveDefault;
	if (descriptor.default !== undefined && descriptor.default !== null && descriptor.default !== '') return descriptor.default;
	if (descriptor.enum?.length) return descriptor.enum[0];
	switch (descriptor.type) {
		case 'integer':
		case 'number':
			return descriptor.minimum ?? 1;
		case 'boolean':
			return true;
		default:
			return 'value';
	}
}

/**
 * A value as a JavaScript / TypeScript literal.
 *
 * @param value - The example value.
 * @returns The literal source.
 */
function jsLiteral(value: unknown): string {
	// JSON string syntax is JavaScript string syntax: every control character,
	// quote and line break arrives escaped
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value ?? null);
}

/**
 * A value as a Python literal.
 *
 * @param value - The example value.
 * @returns The literal source.
 */
function pyLiteral(value: unknown): string {
	if (typeof value === 'boolean') return value ? 'True' : 'False';
	if (typeof value === 'number') return String(value);
	if (value === null || value === undefined) return 'None';
	// A JSON string literal is a valid Python string literal (the same escapes,
	// \uXXXX included); structured values are walked so a string INSIDE one is
	// never rewritten by the constant spelling of its container
	if (typeof value === 'string') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(pyLiteral).join(', ')}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.map(([key, item]) => `${JSON.stringify(key)}: ${pyLiteral(item)}`)
		.join(', ')}}`;
}

/** A name that may stand bare as a JavaScript object key: an identifier that is not `__proto__`. */
const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A public name as a JavaScript object-literal key that creates an OWN property:
 * bare when it is an ordinary identifier, computed (`["1st"]`, `["__proto__"]`)
 * otherwise, since a quoted `"__proto__"` key still sets the prototype.
 *
 * @param name - The public name.
 * @returns The key source.
 */
function jsKey(name: string): string {
	return BARE_KEY.test(name) && name !== '__proto__' ? name : `[${JSON.stringify(name)}]`;
}

/**
 * The `params` object of a JavaScript call, one line.
 *
 * @param params - The exposed parameters.
 * @returns `{ a: 1, b: 'x' }`, or `{}` when nothing is exposed.
 */
function jsParams(params: ICallExampleParam[]): string {
	if (params.length === 0) return '{}';
	// Every accepted public name (`1st`, `__proto__`) becomes an own property (jsKey)
	return `{ ${params.map((p) => `${jsKey(p.name)}: ${jsLiteral(p.value)}`).join(', ')} }`;
}

/**
 * The `params` dict of a Python call, one line.
 *
 * @param params - The exposed parameters.
 * @returns `{'a': 1, 'b': 'x'}`, or `{}` when nothing is exposed.
 */
function pyParams(params: ICallExampleParam[]): string {
	if (params.length === 0) return '{}';
	return `{${params.map((p) => `${JSON.stringify(p.name)}: ${pyLiteral(p.value)}`).join(', ')}}`;
}

// =============================================================================
// Generator
// =============================================================================

/**
 * Build the four call examples for a pipeline.
 *
 * @param input - {@link IBuildCallExamplesParams}.
 * @returns One code block per tab.
 */
export function buildCallExamples({ address, params, host }: IBuildCallExamplesParams): Record<CallExampleTabId, string> {
	const js = [
		`const { RocketRideClient } = require('rocketride');`,
		`const client = new RocketRideClient({ uri, apiKey });`,
		`const result = await client.submit({`,
		`  name: ${jsLiteral(address)},`,
		`  params: ${jsParams(params)},`,
		`  data: inputBytes,`,
		`});`,
	].join('\n');
	const ts = [
		`import { RocketRideClient } from 'rocketride';`,
		`const client = new RocketRideClient({ uri, apiKey });`,
		`const result = await client.submit({`,
		`  name: ${jsLiteral(address)},`,
		`  params: ${jsParams(params)},`,
		`  data: inputBytes,`,
		`});`,
	].join('\n');
	const py = [
		`from rocketride import RocketRideClient`,
		`client = RocketRideClient(uri=URI, apikey=KEY)`,
		`result = await client.submit(`,
		`    name=${pyLiteral(address)},`,
		`    params=${pyParams(params)},`,
		`    data=input_bytes,`,
		`)`,
	].join('\n');
	const query = params.map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(String(p.value))}`).join('&');
	const http = [
		`# The HTTP door: the dotted address in one path segment, params on the query string (plan 3.5)`,
		`POST ${(host || HOST_PLACEHOLDER).replace(/\/+$/, '')}/webhook/${address}${query ? `?${query}` : ''}`,
		`Authorization: Bearer rr_...`,
		`Content-Type: application/octet-stream`,
		``,
		`<binary request body>`,
	].join('\n');
	return { javascript: js, typescript: ts, python: py, http };
}
