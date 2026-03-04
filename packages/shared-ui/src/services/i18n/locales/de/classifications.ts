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

import { ITranslationClassifications } from '../en/classifications';

/** German translations for the "classifications" namespace covering data classification UI. */
export const classifications: ITranslationClassifications = {
	titlePrefix: 'Klassifikationen',
	panel: {
		createHeader: 'Klassifikation erstellen',
		operators: 'Operatoren',
		contentSearch: 'Inhaltssuche',
		predefinedRules: 'Vordefinierte Regeln',
		searchPlaceholder: 'Suchregeln',
	},
	button: {
		create: 'Benutzerdefinierte Klassifikation erstellen',
	},
	customClassifications: {
		singular: 'Benutzerdefinierte Klassifikation',
		plural: 'Benutzerdefinierte Klassifikationen',
	},
	predefinedClassifications: {
		singular: 'Vordefinierte Klassifikation',
		plural: 'Vordefinierte Klassifikationen',
	},
	predefinedRule: {
		label: 'Vordefinierte Regeln',
		count: 'Anzahl',
		uniqueCount: 'Eindeutige Anzahl',
		saveRule: 'Regel speichern',
	},
	keyword: {
		addAnother: 'Weiteres Schlüsselwort hinzufügen',
		count: 'Anzahl',
		uniqueCount: 'Eindeutige Anzahl',
		saveRule: 'Regel speichern',
		keywords: 'Schlüsselwörter',
	},
	view: 'Klassifikation anzeigen',
	rename: 'Umbenennen',
	delete: 'Klassifikation löschen',
	regex: {
		label: 'Regex',
		validating: 'Validiere...',
		count: 'Anzahl',
		uniqueCount: 'Eindeutige Anzahl',
		saveRule: 'Regel speichern',
		validationError:
			'Regex ungültig, bitte überprüfen Sie Ihre Syntax und versuchen Sie es erneut',
	},
	minMax: {
		comparisonType: 'Vergleichstyp',
		options: {
			between: 'Zwischen',
			lessthan: 'Kleiner oder gleich',
			morethan: 'Größer oder gleich',
		},
		value: 'Wert',
		from: 'Von',
		to: 'Bis',
	},
	confidence: 'Konfidenz',
	searchItems: {
		and: {
			label: 'Und',
			description: 'Verwenden Sie dies, um mehrere Kriterien gleichzeitig zu erfüllen.',
		},
		or: {
			label: 'Oder',
			description:
				'Verwenden Sie dies, um Flexibilität zwischen mehreren Kriterien zu ermöglichen.',
		},
		not: {
			label: 'Nicht',
			description:
				'Verwenden Sie dies, um Übereinstimmungen auszuschließen oder entgegengesetzte Logik zu erstellen.',
		},
		regex: {
			label: 'Regex',
			description: 'Sucht Text mit einem regulären Ausdrucksmuster.',
		},
		keyword: {
			label: 'Schlüsselwort',
			description:
				'Stimmt überein, wenn die Datei bestimmte Schlüsselwörter oder Phrasen enthält.',
		},
	},
	wizard: {
		step1: {
			subheader: 'Willkommen',
			description:
				'Erste Schritte mit unserer neuen Funktion. Diese Anleitung führt Sie durch die wichtigsten Funktionen.',
		},
		step2: {
			subheader: 'Erstellen',
			description: 'Hier können Sie Ihre Klassifikationen erstellen und verwalten.',
		},
		step3: {
			subheader: 'Operatoren',
			description: 'Kombinieren Sie Regeln mit Operatoren wie AND, OR und NOT.',
		},
		step4: {
			subheader: 'Inhaltssuche',
			description:
				'Durchsuchen Sie den Inhalt nach Schlüsselwörtern oder regulären Ausdrücken.',
		},
		step5: {
			subheader: 'Fertig',
			description:
				'Sie sind bereit! Beginnen Sie mit der Erstellung Ihrer ersten Klassifikation.',
		},
	},
	snackbar: {
		saveSuccess: '',
		noName: '',
		ruleSaved: '',
		saveError: '',
		deleteError: '',
	},
	tooltips: {
		delete: '',
	},
	error: {
		countValidation: 'Bitte geben Sie eine Zahl ab 1 an',
	},
	filterTextBy: 'Text filtern nach:',
	filterTextMatch: 'Dateien, die den ausgewählten Klassifikationen entsprechen',
	filterTextNoMatch: 'Dateien, die den ausgewählten Klassifikationen nicht entsprechen',
	filterTextNoFilter: 'Alle Texte',
	filterTextWarning: 'Der Ausgangskanal „Text“ muss verbunden sein, um Text zu filtern.',
};
