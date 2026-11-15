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
// WAVE PLAN — the shapes the loop and the model session share, and the run's fixed prefix
// =============================================================================

import type { ComposedTools } from '../tools';
import { MEMORY_PEEK_TOOL } from './memory';

// =============================================================================
// CALLS AND RESULTS
// =============================================================================

/** One tool the model wants run. */
export interface ToolCall {
	/** Tool name as the model wrote it. */
	tool: string;
	/** The arguments object the model supplied. */
	args: Record<string, unknown>;
}

/** What one tool call left behind. */
export interface ResultEntry {
	tool: string;
	/** Stable key for the call, used to spot repeats. */
	key: string;
	/** The arguments the call ran with. */
	args?: unknown;
	/** The tool's result, shortened for the model. */
	summary?: string;
	/** The error message, when the call threw. */
	error?: string;
	/** An extra note for the model, such as a hint for fixing the call. */
	note?: string;
	/** Whether the call repeated an earlier one and was not run again. */
	deduplicated?: boolean;
}

/**
 * Why the loop stopped. 'needs_input': a tool ended the turn to wait for the
 * user (ask_user). 'limited': the turn reached its step limit. 'cost_limit':
 * the cost limit refused a model request.
 */
export type StopReason = 'done' | 'needs_input' | 'empty_plan' | 'error' | 'stopped' | 'limited' | 'cost_limit';

// =============================================================================
// QUESTIONS — what the text adapter asks
// =============================================================================

/** One earlier turn of the conversation. */
export interface HistoryTurn {
	role: 'user' | 'assistant';
	content: string;
}

/**
 * One text question for the model, split into the parts that cache well.
 * Role and instructions are identical on every call; history only grows at
 * the end; goals and context carry whatever changes per wave.
 */
export interface QuestionSpec {
	/** The model's role line. */
	role: string;
	/** Titled instruction sections, identical on every call. */
	instructions: Array<{ title: string; text: string }>;
	/** Earlier turns, oldest first. */
	history: HistoryTurn[];
	/** What the user wants this run. */
	goals: string[];
	/** Per-wave context: the turn so far. */
	context: string[];
	question: string;
	expectJson: boolean;
	/** Whether the host should cache the stable prefix. */
	cachePrefix: boolean;
}

// =============================================================================
// PROMPT TYPES — the pieces of the model's instructions
// =============================================================================

/** The prompt every app shares: a role line and titled sections. */
export interface CorePrompt {
	/** The model's role line. */
	role: string;
	/** Titled instruction sections, in order. */
	sections: Array<{ title: string; text: string }>;
}

/** The prompt text an app adds on top of the core. */
export interface AppPrompts {
	/** Describes the app's workspace layout. */
	workspaceMap: string;
	/** Tells the model which tool or guide to use for which job. */
	router: string;
}

/** A tool as the model learns it: what AgentTool and MEMORY_PEEK_TOOL both have. */
export interface ToolSpec {
	readonly name: string;
	readonly description: string;
	/** JSON Schema, `type: 'object'` at the top. */
	readonly parameters: Record<string, unknown>;
}

// =============================================================================
// PREFIX — built once per run
// =============================================================================

/**
 * Everything identical on every request of a run, so the provider can cache it. Neither the tools
 * nor a reply format are in the instructions: the native adapter sends the tools as data and adds
 * its own reply guidance, and the text adapter writes them as the Available Tools catalog and adds
 * the JSON Response Format.
 */
export interface PromptPrefix {
	/** The model's role line. */
	role: string;
	/** Titled instruction sections, in the order the model reads them. */
	instructions: Array<{ title: string; text: string }>;
	/** The run's tools, memory.peek last (the loop runs it itself). */
	tools: readonly ToolSpec[];
}

/**
 * Builds the prefix for a run. Build it once and reuse it for every request, so the text is
 * byte-identical each time.
 *
 * @param core - The shared role line and sections; each section becomes one instruction.
 * @returns The role; the instructions (core sections, Workspace map, Guides, Tool Instructions); the tools.
 */
export function buildPrefix(core: CorePrompt, app: AppPrompts, composed: ComposedTools): PromptPrefix {
	return {
		role: core.role,
		instructions: [...core.sections.map(({ title, text }) => ({ title, text })), { title: 'Workspace map', text: app.workspaceMap }, { title: 'Guides', text: app.router }, { title: 'Tool Instructions', text: composed.instructions }],
		tools: [...composed.tools, MEMORY_PEEK_TOOL].map(({ name, description, parameters }) => ({ name, description, parameters })),
	};
}
