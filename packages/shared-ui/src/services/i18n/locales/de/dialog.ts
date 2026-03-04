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

import { ITranslationDialog } from '../en/dialog';

/** German translations for the "dialog" namespace covering modal dialog UI strings. */
export const dialog: ITranslationDialog = {
	delete: {
		title: 'Sind Sie sicher, dass Sie löschen möchten?',
		message: {
			project: 'Das Projekt "{{name}}" wird gelöscht',
			projectWithRunningTasks:
				'Sie haben laufende Pipelines in diesem Projekt, diese werden abgebrochen.\nDas Projekt "{{name}}" wird gelöscht',
			customCls: 'Die benutzerdefinierte Klassifizierung "{{name}}" wird gelöscht',
		},
		cancelText: 'Nein',
		acceptText: 'Ja, löschen',
	},
	leave: {
		message: 'Sind Sie sicher, dass Sie ohne Speichern verlassen möchten?',
		cancelText: 'Nein',
		acceptText: 'Ja',
		dontShowAgain: 'Nicht mehr anzeigen',
	},
	saveAs: {
		title: 'Speichern unter',
		nameTitle: '{{type}} Name',
	},
	rename: {
		title: 'Umbenennen',
		message: 'Bitte geben Sie einen neuen Namen ein',
		cancelText: 'Abbrechen',
		acceptText: 'Speichern',
		placeholder: 'Neuer Name',
	},
	save: {
		title: 'Speichern',
		message: 'Bitte geben Sie einen Namen ein',
		cancel: 'Abbrechen',
		accept: 'Speichern',
		discard: 'Verwerfen',
		nameTitle: '{{type}} Name',
		placeholder: 'Neuer Name',
	},
};
