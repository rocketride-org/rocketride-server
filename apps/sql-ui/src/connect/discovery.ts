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
// =============================================================================
// DISCOVERY — database nodes by pipe address and node id (plan 3.6)
//
// A connection needs two facts: the ADDRESS to call and the NODE to call on
// it. Both come from the shared pipe picker (`shared/components/pipe-picker`):
// the caller's own-org publications or a store search, then the picked
// pipe's `interfaces(address)` filtered to the `database` classType. Nothing
// is read from running tasks, no provider list lives here, and a pipe nobody
// has used recently is found exactly like a busy one: the first statement
// starts its engine. This module holds the catalog word and turns a choice
// into the endpoint a saved connection binds to.
// =============================================================================

import type { SqlEndpoint } from './types';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The catalog classType that marks a node with the shared database tool
 * surface (execute / get_schema / refresh_schema / dialect). Whether a node
 * under it really answers those tools is learned on connect, by `dialect`.
 */
export const DATABASE_CLASS_TYPE = 'database';

// =============================================================================
// TYPES
// =============================================================================

/** A database node the picker chose (the picker's choice, structurally). */
export interface SqlNodeChoice {
	/** The address the node answered under. */
	address: string;
	/** The node's component id. */
	nodeId: string;
	/** The node's display name. */
	nodeName: string;
	/** The pipe's display name. */
	pipeName: string;
}

// =============================================================================
// THE ENDPOINT
// =============================================================================

/**
 * The endpoint of a chosen database node. Its `address` is the key the node
 * answered under, so a tool call lands on the right control.
 *
 * @param choice - The chosen node.
 * @returns The endpoint, keyed `${address}:${nodeId}`.
 */
export function endpointFromChoice(choice: SqlNodeChoice): SqlEndpoint {
	return {
		key: `${choice.address}:${choice.nodeId}`,
		address: choice.address,
		pipelineName: choice.pipeName || choice.address,
		nodeId: choice.nodeId,
		nodeName: choice.nodeName || choice.nodeId,
	};
}
