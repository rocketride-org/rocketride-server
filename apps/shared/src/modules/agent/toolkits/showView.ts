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
// SHOW VIEW — put the user's own App Builder or pipeline canvas beside the chat
// =============================================================================

/**
 * `show_view` puts the user's own view of an app or a pipeline beside the chat, so the user watches the
 * agent's next changes appear: an app's App Builder on its Design stage, or a pipeline's canvas. It only
 * opens, or brings to the front, a view that is already open; closing views stays the user's job.
 *
 * What lives here is what the agent decides:
 * - the one argument, `path`, as list_workspace gives it, parsed into a UserView: an app folder through
 *   findApp, a pipeline file through a stat. Only those two spellings pass, so the loop's same-step
 *   ordering (writePaths keys on `path` as the file tools spell it) always applies
 * - the text the model reads
 *
 * The host does the rest: placement beside the chat, the chat back in front, and the Design stage
 * (AgentHost.showView). run.ts mounts this toolkit only on a host that has showView, so a host with no
 * editors never offers the tool and never refuses it.
 */

import type { UserView } from '../host';
import type { IWorkspaceFileSystem } from '../../vfs/vfsTypes';
import { AgentTool, AgentToolkit } from '../tools';
import { messageOf } from './common';
import { normalizePath } from './filesystem';
import { findApp, readApps, type AppEntry } from './inventory';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The tool's name. The loop's writePaths keys on the same string. */
export const SHOW_VIEW_TOOL = 'show_view';

/** Everything show_view says to the model. */
const WORDS = {
	instructions: `## Showing your work

- Before you change something the user can see, an app's screens or a pipeline, call show_view with its path. Their own App Builder (on Design) or pipeline canvas opens beside this chat, and they watch each change appear as you save it.
- Call it once for each app or pipeline you change in a turn, before its first edit. The view stays open and keeps up with your saves.
- List show_view before those edits in the same step, because calls on one app or pipeline run in the order you list them.
- Don't call it when there is nothing to watch (a deploy, a publish, a schedule, a README), or to try the app yourself: use_app does that, on your own copy.`,

	description: `Open the user's own view of an app or a pipeline beside this chat, so they can watch your changes appear: the app's App Builder on its Design stage, or the pipeline's canvas. A view that is already open comes to the front where it is. Returns what the user now sees.

Use it before your first edit to an app or a pipeline in a turn, for example show_view {"path": "apps/daybook-ui"} before you change that app's heading, so the user sees the new heading appear.

Don't use it when there is nothing to watch (a deploy, a publish, a schedule, a README), or to try the app yourself: use_app works on your own copy.`,

	params: {
		path: "The app's folder (apps/<folder>) or the pipeline's file (pipelines/<name>.pipe), as list_workspace gives its path.",
	},

	pathMissing: "path is required: an app's folder (apps/<folder>) or a pipeline file (pipelines/<name>.pipe), as list_workspace gives them.",
	notAView: (path: string): string => `${path} is not an app or a pipeline. Pass an app's folder (apps/<folder>) or a pipeline file (pipelines/<name>.pipe), as list_workspace gives them.`,
	/** findApp's own "No app 'x'. Apps: ..." with the spelling show_view takes. */
	noApp: (why: string): string => `${why}. Pass the app as apps/<folder>.`,
	/** The app resolved, but by its id, its name, or a file inside it: the ordering key would miss its edits. */
	appByFolder: (folder: string): string => `Pass the app's folder, apps/${folder}.`,
	appNoId: (folder: string, path: string): string => `${folder} has no manifest id, so its App Builder can't open. Fix appManifest.id in ${path}/package.json, then call show_view again.`,
	noPipeline: (path: string): string => `No pipeline file at ${path}. list_workspace lists the pipelines.`,
	failed: (path: string, why: string): string => `Couldn't show ${path}: ${why}. Carry on, and say in your answer what you changed.`,

	shown: {
		app: (name: string, path: string): string => `The App Builder for ${name} (${path}) is open beside the chat on Design. Its preview updates as you save the app's files.`,
		pipeline: (path: string): string => `The canvas for ${path} is open beside the chat. It reloads as you save the file.`,
	},
} as const;

const PARAMETERS = {
	type: 'object',
	properties: {
		path: { type: 'string', description: WORDS.params.path },
	},
	required: ['path'],
	additionalProperties: false,
};

// =============================================================================
// TOOLKIT
// =============================================================================

/**
 * show_view for one run. Built in run.ts only when the host has showView, with that method already bound
 * to the run's chat, so this toolkit knows nothing of conversations, groups or stages. Free: it changes
 * only what is on screen, so it has no act and never asks.
 */
export class ShowViewToolkit extends AgentToolkit {
	readonly name = 'view';
	readonly instructions = WORDS.instructions;

	private readonly vfs: IWorkspaceFileSystem;
	private readonly show: (view: UserView) => Promise<void>;

	/**
	 * Builds the toolkit for one run.
	 *
	 * @param vfs - The workspace view the paths resolve against (the staged one, so an app created this turn resolves).
	 * @param show - The host's showView, bound to this turn's chat.
	 */
	constructor(vfs: IWorkspaceFileSystem, show: (view: UserView) => Promise<void>) {
		super();
		this.vfs = vfs;
		this.show = show;
	}

	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: SHOW_VIEW_TOOL,
				description: WORDS.description,
				parameters: PARAMETERS,
				execute: (args) => this.run(args),
			}),
		];
	}

	/**
	 * Shows the view a call names and says what the user now sees.
	 *
	 * @throws With the fix, for a path that names no app folder or pipeline file; with WORDS.failed when the host could not show it.
	 */
	private async run(args: Record<string, unknown>): Promise<string> {
		const raw = typeof args.path === 'string' ? args.path : '';
		if (!raw.trim()) throw new Error(WORDS.pathMissing);
		// the same spelling as loop.ts cleanPath, so writePaths keys on the view's own path
		const path = normalizePath(raw);
		const view = await viewAt(this.vfs, path);
		try {
			await this.show(view);
		} catch (err) {
			throw new Error(WORDS.failed(path, messageOf(err)));
		}
		return view.kind === 'app' ? WORDS.shown.app(view.app.name, path) : WORDS.shown.pipeline(path);
	}
}

// =============================================================================
// THE PATH
// =============================================================================

/**
 * The user's view a normalized path names. Only an exact app folder or a pipeline file passes.
 *
 * @param path - Already normalized (normalizePath), so it is the writePaths key as given.
 * @throws notAView for anything outside apps/<folder> and pipelines/**.pipe; noApp (with the apps that exist)
 *   for an unknown folder; appByFolder for an app named by id, name or a file inside it; appNoId for an app
 *   the builder cannot key; noPipeline for a .pipe path with no file.
 */
async function viewAt(vfs: IWorkspaceFileSystem, path: string): Promise<UserView> {
	const [root, folder, ...rest] = path.split('/');
	if (root === 'apps' && folder) {
		let entry: AppEntry;
		try {
			entry = findApp(await readApps(vfs, () => false), folder);
		} catch (err) {
			throw new Error(WORDS.noApp(messageOf(err)));
		}
		if (entry.folder !== folder || rest.length > 0) throw new Error(WORDS.appByFolder(entry.folder));
		if (!entry.id) throw new Error(WORDS.appNoId(entry.folder, entry.path));
		return { kind: 'app', app: { id: entry.id, folder: entry.folder, name: entry.name ?? entry.folder } };
	}
	if (root === 'pipelines' && path.endsWith('.pipe')) {
		// a stat, not list_workspace: Named Pipes bundles (pipelines/<n>/<n>.pipe) resolve with no change here
		if ((await vfs.stat(path)) !== 'file') throw new Error(WORDS.noPipeline(path));
		return { kind: 'pipeline', path };
	}
	throw new Error(WORDS.notAView(path));
}
