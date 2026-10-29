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

/**
 * What a prepared call is about to do, for the approval list to rate
 * (`toolkits/approval.ts`). The tool names it before any of its work starts.
 */
export interface ToolAct {
	/**
	 * The list entry it falls under: a client method as the guide names it
	 * (`publishApp`, `deploy.setSchedule`), or a tool whose work bypasses the
	 * client (`delete_file`).
	 */
	readonly name: string;
	/**
	 * For a client method, its arguments exactly as `run` will pass them: the
	 * checked client lets an asked method through only with these. For a tool,
	 * its target. The card is built from them.
	 */
	readonly params: readonly unknown[];
}

/** A call made ready: what it is about to do, and the work itself. */
export interface ToolStep {
	/** What it is about to do, when the approval list rates it. Absent: nothing to rate, so the run starts at once. */
	readonly act?: ToolAct;
	/** Does the work. The loop calls it at most once, and only after the act (if any) was let through. */
	run(): Promise<string>;
}

/**
 * Thrown by a tool that refuses a call before it changes anything (the user
 * kept their unsaved changes, the file moved on since it was read). The loop
 * marks the call unstarted, so the finish rule does not ask for a check.
 */
export class RefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RefusedError';
	}
}

/**
 * The time the user spends answering a tool's question (the unsaved-changes
 * dialog). While one is open, no running call's time limit runs.
 */
export class UserTime {
	/** How many questions are open now. */
	private open = 0;
	private readonly listeners = new Set<() => void>();

	/** True while at least one question is open. */
	get asking(): boolean {
		return this.open > 0;
	}

	/** Holds the clocks until the question settles. */
	async during<T>(question: Promise<T>): Promise<T> {
		this.change(1);
		try {
			return await question;
		} finally {
			this.change(-1);
		}
	}

	/** Hears each time `asking` turns on or off. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private change(by: number): void {
		const was = this.asking;
		this.open += by;
		if (was !== this.asking) for (const listener of [...this.listeners]) listener();
	}
}

/** What every tool spec has. */
interface ToolSpecBase {
	/** Tool name as the LLM calls it. */
	name: string;
	/** Tool description shown to the LLM at discovery. */
	description: string;
	/** JSON Schema of the arguments object. */
	parameters: Record<string, unknown>;
}

/**
 * The defining spec of one tool: contract plus executor. Most tools give
 * `execute`. A tool whose call may need the user's OK gives `prepare`
 * instead: it reads what it needs and says what it is about to do, and the
 * loop asks before it calls the step's `run`. `prepare` only reads, because
 * the call may be refused after it.
 */
export type AgentToolSpec =
	| (ToolSpecBase & {
			/** Runs the call; the resolved string is the tool result fed to the LLM. */
			execute: (args: Record<string, unknown>) => Promise<string>;
			prepare?: never;
	  })
	| (ToolSpecBase & {
			/** Gets the call ready: its act and its work. Throws when the arguments are wrong. */
			prepare: (args: Record<string, unknown>) => Promise<ToolStep>;
			execute?: never;
	  });

/**
 * One tool as presented to the LLM. A concrete class built from a spec so
 * toolkits can define tools inline while still giving hosts one nominal
 * type to pass around and extend. It has one way in, `prepare`, so no
 * tool's work starts except through the loop's approve step; an `execute`
 * spec prepares to a step with no act.
 */
export class AgentTool {
	/** Tool name as the LLM calls it. */
	readonly name: string;
	/** Tool description shown to the LLM at discovery. */
	readonly description: string;
	/** JSON Schema of the arguments object. */
	readonly parameters: Record<string, unknown>;
	/** The spec's executor, in its two-step form. */
	private readonly preparer: (args: Record<string, unknown>) => Promise<ToolStep>;

	/**
	 * Builds a tool from its spec.
	 *
	 * @param spec - Name, description, parameter schema, and executor.
	 */
	constructor(spec: AgentToolSpec) {
		this.name = spec.name;
		this.description = spec.description;
		this.parameters = spec.parameters;
		this.preparer = spec.execute ? oneStep(spec.execute) : spec.prepare;
	}

	/**
	 * Gets one call ready. Only the loop calls it.
	 *
	 * @param args - The LLM-supplied arguments object.
	 * @returns What the call is about to do, and its work.
	 */
	prepare(args: Record<string, unknown>): Promise<ToolStep> {
		return this.preparer(args);
	}
}

/**
 * An execute function as a one-step preparer. The work waits for `run()`, so
 * it happens inside the call's clock.
 */
function oneStep(execute: (args: Record<string, unknown>) => Promise<string>): (args: Record<string, unknown>) => Promise<ToolStep> {
	return async (args) => ({ run: () => execute(args) });
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
