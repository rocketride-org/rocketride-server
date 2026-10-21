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
// SHOW VIEW — put the app preview, node preview or pipeline canvas in front of the user
// =============================================================================

/**
 * The `show_view` tool: the model asks the builder to open or focus, pause,
 * resume or close one of three views, named by kind and name. It is for the
 * moments the model is changing something visual, so the user can watch it
 * happen. Deploy, publish and schedule reply in text and switch no view.
 *
 * The toolkit is written against `ViewChannel`, one `send` that carries a
 * `ViewEvent` to the builder UI and resolves with the UI's reply text. How
 * the events travel (a callback chunk type or a shell bus event) is open
 * question #1; the channel is the seam, so the toolkit does not change with it.
 *
 * The toolkit remembers the views the model paused. `resumeAll()` resumes each
 * one still paused, so a run that ends (or fails) between a pause and its
 * resume never leaves a frozen view behind.
 */

import { AgentTool, AgentToolkit } from '../tools';

// =============================================================================
// TYPES
// =============================================================================

/** The three views the model can show. */
export type ViewKind = 'app_preview' | 'node_preview' | 'pipeline_canvas';

/** What the model can ask of a view. */
export type ViewAction = 'open' | 'pause' | 'resume' | 'close';

/** One request to the builder UI: do `action` to the view of this kind and name. */
export interface ViewEvent {
	/** What to do. */
	action: ViewAction;
	/** Which kind of view. */
	kind: ViewKind;
	/** The app, node or pipeline the view shows, as the builder names it. */
	name: string;
}

/** How a view event reaches the builder UI. */
export interface ViewChannel {
	/**
	 * Sends one event to the UI.
	 *
	 * @param event - The request.
	 * @returns The UI's reply text, which becomes the tool result.
	 */
	send(event: ViewEvent): Promise<string>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** The kinds `show_view` takes. */
const VIEW_KINDS: readonly ViewKind[] = ['app_preview', 'node_preview', 'pipeline_canvas'];

/** The actions `show_view` takes. */
const VIEW_ACTIONS: readonly ViewAction[] = ['open', 'pause', 'resume', 'close'];

/** The group's instructions, joined into the system prompt when the group is mounted. */
const INSTRUCTIONS = `## Showing the view

- Open the view with show_view before you change something visual (a page, a node, a pipeline), because the user can then watch the change as you make it.
- Pause a view before a long run of edits that would make it jump or reload, and resume it when they are done, because the user sees one settled result instead of a flicker. A view left paused is resumed when your run ends.
- Don't open a view for deploy, publish or schedule; say what happened in your answer, because there is nothing for the user to watch.`;

/** What the model reads about `show_view`: when to use it, when not to, one example. */
const SHOW_VIEW_DESCRIPTION = `Show the user a view in the builder: open or focus it, pause it, resume it, or close it. The view is named by kind and name. The result is the builder's reply.

Use it:
- when you are about to change something the user can see, so they can watch it: open the app_preview for the app you are editing, the node_preview for a node, the pipeline_canvas for a pipeline you are building;
- with pause before a long run of edits that would make a view jump or reload, and with resume once they are done (a view still paused when your run ends is resumed for you);
- with close, when a view is no longer what you are working on.

Don't use it:
- for deploy, publish or schedule: they switch no view, so say in your answer what you did;
- for reading files or running checks: the user does not need to watch those, so call the read tools or check_app directly;
- to ask the user something: put the question in your answer.

kind is app_preview, node_preview or pipeline_canvas. name is the app, node or pipeline you mean, as it appears in the workspace.

Example: show_view { "action": "open", "kind": "app_preview", "name": "home" } before you change the heading of the home app, so the user sees the new heading appear.`;

// =============================================================================
// ARGUMENTS
// =============================================================================

/**
 * A text argument, trimmed.
 *
 * @param args - The tool arguments.
 * @param key - The argument name.
 * @returns The text; empty when the argument is absent or not text.
 */
function textArg(args: Record<string, unknown>, key: string): string {
	const raw = args[key];
	return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * An argument that must be one of a fixed list.
 *
 * @param args - The tool arguments.
 * @param key - The argument name.
 * @param allowed - The valid values.
 * @returns The value.
 * @throws When it is missing or not in the list; the message lists the valid values.
 */
function choiceArg<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T {
	const value = textArg(args, key);
	const found = allowed.find((a) => a === value);
	if (found === undefined) throw new Error(`${key} must be one of: ${allowed.join(', ')}.${value ? ` Got '${value}'.` : ''}`);
	return found;
}

// =============================================================================
// TOOLKIT
// =============================================================================

/** The show-the-view toolkit: one tool that drives the builder's views, and the paused views it remembers. */
export class ShowViewToolkit extends AgentToolkit {
	readonly name = 'view';
	readonly instructions = INSTRUCTIONS;

	/** Carries each event to the builder UI. */
	private readonly channel: ViewChannel;
	/** The views the model paused and has not resumed or closed, by kind and name, in the order they were paused. */
	private readonly paused = new Map<string, ViewEvent>();

	/**
	 * Builds the toolkit.
	 *
	 * @param channel - How events reach the builder UI.
	 */
	constructor(channel: ViewChannel) {
		super();
		this.channel = channel;
	}

	/**
	 * Sends one event and keeps the paused set in step with it.
	 *
	 * @param args - The `show_view` arguments.
	 * @returns The UI's reply text.
	 * @throws When an argument is wrong, or when the channel fails; the message says what to do instead.
	 */
	private async show(args: Record<string, unknown>): Promise<string> {
		const action = choiceArg(args, 'action', VIEW_ACTIONS);
		const kind = choiceArg(args, 'kind', VIEW_KINDS);
		const name = textArg(args, 'name');
		if (!name) throw new Error(`name is required. Pass the app, node or pipeline the ${kind} shows.`);

		const event: ViewEvent = { action, kind, name };
		let reply: string;
		try {
			reply = await this.channel.send(event);
		} catch (err) {
			throw new Error(`Cannot ${action} the ${kind} ${name}: ${err instanceof Error ? err.message : String(err)}. Carry on without the view, and tell the user in text what you changed.`);
		}

		// Only a pause that went through counts as paused; resume or close ends it.
		const key = `${kind}\n${name}`;
		if (action === 'pause') this.paused.set(key, event);
		else if (action === 'resume' || action === 'close') this.paused.delete(key);
		return reply;
	}

	/**
	 * Resumes every view the model left paused, once each, and forgets them. Best
	 * effort: a view that cannot be resumed does not stop the others, and nothing
	 * is thrown, so the run's cleanup can call it from a `finally`.
	 */
	async resumeAll(): Promise<void> {
		const stillPaused = [...this.paused.values()];
		this.paused.clear();
		for (const { kind, name } of stillPaused) {
			try {
				await this.channel.send({ action: 'resume', kind, name });
			} catch {
				// The run is over; there is nobody left to tell, and the next view still needs resuming.
			}
		}
	}

	/**
	 * The one view tool.
	 *
	 * @returns The group's tools.
	 */
	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: 'show_view',
				description: SHOW_VIEW_DESCRIPTION,
				parameters: {
					type: 'object',
					properties: {
						action: { type: 'string', enum: [...VIEW_ACTIONS], description: 'open (also focuses a view that is already open), pause, resume or close' },
						kind: { type: 'string', enum: [...VIEW_KINDS], description: 'Which view: the app preview, a node preview, or the pipeline canvas' },
						name: { type: 'string', description: 'The app, node or pipeline the view shows, for example home' },
					},
					required: ['action', 'kind', 'name'],
					additionalProperties: false,
				},
				execute: (args) => this.show(args),
			}),
		];
	}
}
