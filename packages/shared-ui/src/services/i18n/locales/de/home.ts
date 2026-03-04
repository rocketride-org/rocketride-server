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

import { ITranslationHome } from '../en/home';

/** German translations for the "home" namespace covering the overview / landing page. */
export const home: ITranslationHome = {
	title: 'Übersicht',
	sourcesPageButton: 'Entdecken Sie Ihre Daten',
	socialsTitle: 'Folge uns für weitere Updates!',
	rewardsTitle: 'Deine Stimme bringt dir Belohnungen!',
	tiles: {
		heading: 'Schnellzugriff',
		one: {
			title: 'Vorlagenbibliothek',
			description: 'Unstrukturierte Daten in KI-geeignete Ressourcen verwandeln',
		},
		two: {
			title: 'Datenverbindungen anzeigen',
			description: 'Verbinden Sie sich mit Ihren unstrukturierten Datenquellen',
		},
		three: {
			title: 'Dokumentation',
			description:
				'Finden Sie alles, was Sie benötigen, um mit RocketRide Data Toolchain zu starten.',
		},
		four: {
			title: 'Mitmachen',
			description: 'Treten Sie unserem Discord bei, um Feedback zu teilen und sich zu vernetzen',
		},
	},
	rewards: {
		one: {
			title: 'Einen Freund werben',
			description: 'Lade andere Personen mit deinem Link ein, unserer Plattform beizutreten',
			buttonTitle: 'Link erhalten',
		},
		two: {
			title: 'Tritt unserem Discord-Kanal bei',
			description:
				'Vernetze dich mit uns, teile dein Feedback und erhalte Unterstützung von Spezialisten',
			buttonTitle: 'Jetzt beitreten',
		},
		three: {
			title: 'Teile deine Erfahrung',
			description:
				'Schreibe auf X, was dir gefällt, was verbessert werden könnte und wie es dir hilft.',
			buttonTitle: 'Sag uns, was du denkst',
		},
	},
	copyright: 'Copyright © {{year}} RocketRide, Inc.',
};
