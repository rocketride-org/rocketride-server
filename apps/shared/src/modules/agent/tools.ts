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
// AGENT TOOLS — the tool contract the agent loop composes from host toolkits
// =============================================================================

/**
 * The agent's tool architecture. Hosts assemble an agent from TOOLKITS —
 * named groups of tools, each carrying the system-prompt instructions for
 * its own group. An app mounts only the toolkits it needs (the shared
 * FilesystemTools, its own workspace toolkit, anything else), and passes
 * `AgentToolkit[]` when creating the agent. The loop composes the final
 * tool list and prompt via composeToolkits().
 *
 * A toolkit owns its state (a FilesystemTools holds its CachedVfs); the
 * AgentTool instances it returns close over that state. Tool results are
 * ALWAYS strings — the text fed back to the LLM; structured results are
 * JSON.stringify'd inside the tool.
 */

// =============================================================================
// TOOL — one callable surface
// =============================================================================

/** The defining spec of one tool: contract plus executor. */
export interface AgentToolSpec {
	/** Tool name as the LLM calls it. */
	name: string;
	/** Tool description shown to the LLM at discovery. */
	description: string;
	/** JSON Schema of the arguments object. */
	parameters: Record<string, unknown>;
	/** Runs the call; the resolved string is the tool result fed to the LLM. */
	execute: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * One tool as presented to the LLM. A concrete class built from a spec so
 * toolkits can define tools inline while still giving hosts one nominal
 * type to pass around and extend.
 */
export class AgentTool {
	/** Tool name as the LLM calls it. */
	readonly name: string;
	/** Tool description shown to the LLM at discovery. */
	readonly description: string;
	/** JSON Schema of the arguments object. */
	readonly parameters: Record<string, unknown>;
	/** The bound executor. */
	private readonly executor: AgentToolSpec['execute'];

	/**
	 * Builds a tool from its spec.
	 *
	 * @param spec - Name, description, parameter schema, and executor.
	 */
	constructor(spec: AgentToolSpec) {
		this.name = spec.name;
		this.description = spec.description;
		this.parameters = spec.parameters;
		this.executor = spec.execute;
	}

	/**
	 * Runs the tool.
	 *
	 * @param args - The LLM-supplied arguments object.
	 * @returns The tool result text fed back to the LLM.
	 */
	execute(args: Record<string, unknown>): Promise<string> {
		return this.executor(args);
	}
}

// =============================================================================
// TOOLKIT — a named group of tools with its own instructions
// =============================================================================

/**
 * A group of tools plus the system-prompt fragment that teaches the LLM how
 * to use them. Instructions ride with the group: an agent that does not
 * mount a toolkit never sees a word about it.
 */
export abstract class AgentToolkit {
	/** Group id for diagnostics and override reporting (e.g. 'filesystem'). */
	abstract readonly name: string;
	/** System-prompt fragment for this group — included only when mounted. */
	abstract readonly instructions: string;

	/**
	 * The member tools. Called once at composition; implementations may
	 * build the instances fresh or return cached ones.
	 *
	 * @returns The group's tools.
	 */
	abstract tools(): AgentTool[];
}

// =============================================================================
// COMPOSITION — flatten mounted toolkits into one prompt + tool list
// =============================================================================

/** What the agent loop consumes: the assembled prompt fragment and tools. */
export interface ComposedTools {
	/** All mounted groups' instructions, in mount order. */
	instructions: string;
	/** The flattened tool list, overrides applied. */
	tools: AgentTool[];
}

/**
 * Flattens mounted toolkits into the final tool list and instruction block.
 * Name collisions are LAST-MOUNTED-WINS by design — a host overrides a
 * generic tool (e.g. a faster search_files) by mounting its toolkit after
 * the generic one. Every override is logged so shadowing is never silent.
 *
 * @param toolkits - The mounted toolkits, in mount order.
 * @returns The composed instructions and tools.
 */
export function composeToolkits(toolkits: AgentToolkit[]): ComposedTools {
	// step: flatten with last-wins override semantics, loudly
	const byName = new Map<string, AgentTool>();
	for (const toolkit of toolkits) {
		for (const tool of toolkit.tools()) {
			if (byName.has(tool.name)) {
				console.log(`[agent] toolkit '${toolkit.name}' overrides tool '${tool.name}'`);
			}
			byName.set(tool.name, tool);
		}
	}
	// step: instructions concatenate in mount order; empty fragments vanish
	const instructions = toolkits
		.map((t) => t.instructions.trim())
		.filter((s) => s.length > 0)
		.join('\n\n');
	return { instructions, tools: [...byName.values()] };
}
