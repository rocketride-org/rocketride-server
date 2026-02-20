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
 * Type definition for the German "onboarding-tour" translation namespace.
 * Mirrors the English interface to ensure structural parity across locales.
 */
export interface ITranslationOnboardingTour {
	buttons: {
		skip: string;
		next: string;
		gotIt: string;
	};
	home: {
		step1: {
			title: string;
			content: string;
		};
		step2: {
			title: string;
			content: string;
		};
		step3: {
			title: string;
			content: string;
		};
	};
	canvas: {
		step1: {
			title: string;
			content: {
				part1: string;
				part2: string;
				part3: string;
			};
		};
		step2: {
			title: string;
			content: string;
		};
	};
	workWithNodes: {
		title: string;
		step1: string;
		step2: string;
		step3: string;
		step4: string;
		stepCounter: string;
		button: string;
	};
}

/** German translations for the "onboarding-tour" namespace covering the new-user guided tour. */
export const onboardingTour: ITranslationOnboardingTour = {
	buttons: {
		skip: 'Überspringen',
		next: 'Weiter',
		gotIt: 'Verstanden',
	},
	home: {
		step1: {
			title: 'Erstellen Sie Ihr erstes Projekt',
			content:
				'Klicken Sie auf „Neues Projekt", um zu beginnen. Sie können mit einer leeren Leinwand beginnen oder eine vordefinierte Vorlage verwenden.',
		},
		step2: {
			title: 'Verfolgen Sie Ihren Fortschritt',
			content:
				'Sehen Sie, wie viele Projekte Sie erstellt haben, was läuft und wie viele Daten verarbeitet wurden.',
		},
		step3: {
			title: 'Verbinden Sie sich mit der Community',
			content:
				'Treten Sie unserer Discord-Community bei, um Hilfe zu erhalten, sich mit unserem Team zu verbinden und neue Möglichkeiten zur Nutzung der Data Toolchain zu entdecken.',
		},
	},
	canvas: {
		step1: {
			title: 'Mit der Symbolleiste erstellen',
			content: {
				part1: 'Klicken Sie auf',
				part2: 'um neue Knoten hinzuzufügen und',
				part3: 'um Kommentare zu Ihrem Projekt hinzuzufügen. Erhalten Sie auch Schnellzugriff auf Ansichtsanpassungen und Tastenkombinationen.',
			},
		},
		step2: {
			title: 'Knoten hinzufügen',
			content:
				'Durchsuchen und wählen Sie aus verfügbaren Knoten, um Ihre Datenpipeline zu erstellen.',
		},
	},
	workWithNodes: {
		title: 'Mit Knoten arbeiten',
		step1: 'Öffnen Sie einen Knoten, um ihn zu konfigurieren',
		step2: 'Auf zusätzliche Optionen zugreifen',
		step3: 'Klicken Sie auf einen Verbindungspunkt, um kompatible Knoten anzuzeigen, oder ziehen Sie, um sie zu verknüpfen.',
		step4: 'Klicken Sie auf „Ausführen", um Ihre Pipeline auszuführen.',
		stepCounter: '3 von 3',
		button: 'Verstanden',
	},
};
