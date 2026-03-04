// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Type definition for the "toolchains" translation namespace.
 * Describes translatable strings used in the toolchains/projects view including
 * headers, dialog prompts, node controls, group actions, run/stop buttons, and canvas controls.
 */
export interface ITranslationProjects {
	header: {
		title: string;
	};
	add: {
		title: string;
	};
	dialogStop: {
		title: string;
		message: string;
		cancelText: string;
		acceptText: string;
	};
	nodeControls: {
		open: string;
		duplicate: string;
		documentation: string;
	};
	groups: {
		delete: string;
		lock: string;
		unlock: string;
		ungroup: string;
	};
	runButton: {
		tooltip: string;
		disabledTooltip: string;
	};
	stopButton: {
		tooltip: string;
		disabledTooltip: string;
	};
	controls: {
		addAnnotationNode: string;
		running: string;
		stopping: string;
		pending: string;
		stopToolchain: string;
		groupNodes: string;
		unGroupNodes: string;
		dragMode: string;
		selectMode: string;
	};
}

/** English translations for the "toolchains" namespace covering the toolchains/projects view. */
export const projects: ITranslationProjects = {
	header: {
		title: 'Projects',
	},
	add: {
		title: 'Create a project',
	},
	dialogStop: {
		title: 'Are you sure you want to stop?',
		message: 'The project "{{name}}" will be stopped',
		cancelText: 'No',
		acceptText: 'Yes, stop',
	},
	nodeControls: {
		open: 'Open',
		duplicate: 'Duplicate',
		documentation: 'Documentation',
	},
	groups: {
		delete: 'Delete Group',
		lock: 'Lock Group',
		unlock: 'Unlock Group',
		ungroup: 'Ungroup',
	},
	runButton: {
		tooltip: 'Run this pipeline',
		disabledTooltip: 'Run operation is pending',
	},
	stopButton: {
		tooltip: 'Stop this pipeline',
		disabledTooltip: 'Pipeline is stopping',
	},
	controls: {
		addAnnotationNode: 'Add annotation node',
		running: 'Running...',
		stopping: 'Stopping...',
		pending: 'Pending...',
		stopToolchain: 'Stop toolchain',
		groupNodes: 'Group selected nodes',
		unGroupNodes: 'Ungroup selected nodes',
		dragMode: 'Drag to navigate',
		selectMode: 'Select nodes',
	},
};
