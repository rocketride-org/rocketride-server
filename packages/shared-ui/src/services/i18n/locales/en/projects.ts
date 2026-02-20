// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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
 * Type definition for the "projects" translation namespace.
 * Describes translatable strings for the projects listing page including
 * table headers, sorting options, search, node controls, group actions,
 * run/stop buttons, and canvas control labels.
 */
export interface ITranslationProjects {
	header: {
		title: string;
	};
	singular: string;
	plural: string;
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
	newProject: string;
	sourceNodes: string;
	dateModified: string;
	dateCreated: string;
	aThroughZ: string;
	zThroughA: string;
	searchPlaceholder: string;
	listView: string;
	gridView: string;
	sort: string;
	filter: string;
	nameShouldBeUnique: string;
	tableHeaders: {
		name: string;
		nodes: string;
		status: string;
		actions: string;
		author: string;
	};
}

/** English translations for the "projects" namespace covering the projects listing page. */
export const projects: ITranslationProjects = {
	header: {
		title: 'Projects',
	},
	singular: 'Project',
	plural: 'Projects',
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
	newProject: 'New project',
	sourceNodes: 'Source nodes',
	dateModified: 'Date modified',
	dateCreated: 'Date created',
	aThroughZ: 'Name A-Z',
	zThroughA: 'Name Z-A',
	searchPlaceholder: 'Search projects',
	listView: 'List view',
	gridView: 'Grid view',
	sort: 'Sort',
	filter: 'Filter',
	nameShouldBeUnique: 'Name should be unique.',
	tableHeaders: {
		name: 'Name',
		nodes: 'Nodes',
		status: 'Status',
		actions: 'Actions',
		author: 'Author',
	},
};
