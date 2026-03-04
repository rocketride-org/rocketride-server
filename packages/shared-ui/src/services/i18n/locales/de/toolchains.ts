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

import { ITranslationProjects } from '../en/projects';

/** German translations for the "toolchains" namespace covering the toolchains/projects view. */
export const projects: ITranslationProjects = {
	header: {
		title: 'Projekte',
	},
	singular: 'Projekt',
	plural: 'Projekte',
	add: {
		title: 'Ein Projekt erstellen',
	},
	dialogStop: {
		title: 'Sind Sie sicher, dass Sie stoppen möchten?',
		message: 'Das Projekt "{{name}}" wird gestoppt',
		cancelText: 'Nein',
		acceptText: 'Ja, stoppen',
	},
	nodeControls: {
		open: 'Öffnen',
		duplicate: 'Duplizieren',
		documentation: 'Dokumentation',
	},
	groups: {
		delete: 'Gruppe löschen',
		lock: 'Gruppe sperren',
		unlock: 'Gruppe entsperren',
		ungroup: 'Gruppierung aufheben',
	},
	runButton: {
		tooltip: 'Diese Pipeline ausführen',
		disabledTooltip: 'Ausführungsvorgang steht aus',
	},
	stopButton: {
		tooltip: 'Diese Pipeline stoppen',
		disabledTooltip: 'Pipeline wird gestoppt',
	},
	controls: {
		addAnnotationNode: 'Anmerkungsknoten hinzufügen',
		running: 'Läuft...',
		stopping: 'Wird gestoppt...',
		pending: 'Ausstehend...',
		stopToolchain: 'Toolchain stoppen',
		groupNodes: 'Ausgewählte Knoten gruppieren',
		unGroupNodes: 'Gruppierung der ausgewählten Knoten aufheben',
		dragMode: 'Ziehen zum Navigieren',
		selectMode: 'Knoten auswählen',
	},
	newProject: 'Neues Projekt',
	sourceNodes: 'Quellknoten',
	dateModified: 'Datum geändert',
	dateCreated: 'Datum erstellt',
	aThroughZ: 'A-Z',
	zThroughA: 'Z-A',
	searchPlaceholder: 'Projekte suchen',
	listView: 'Listenansicht',
	gridView: 'Rasteransicht',
	sort: 'Sortieren',
	filter: 'Filtern',
	nameShouldBeUnique: 'Der Name muss eindeutig sein.',
	tableHeaders: {
		name: 'Name',
		nodes: 'Knoten',
		status: 'Status',
		actions: 'Aktionen',
		author: 'Autor',
	},
};
