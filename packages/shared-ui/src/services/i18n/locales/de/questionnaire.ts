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

import { ITranslationQuestionnaire } from '../en/questionnaire';

/** German translations for the "questionnaire" namespace covering the user onboarding survey. */
export const questionnaire: ITranslationQuestionnaire = {
	title: 'Erzählen Sie uns ein wenig über sich',
	skip: 'Überspringen',
	submit: 'Absenden',
	submitting: 'Wird abgesendet...',
	role: {
		label: 'Was beschreibt Ihre Rolle am besten?',
		placeholder: 'Wählen Sie Ihre Rolle',
		options: {
			fullStackEngineer: 'Full Stack Engineer',
			aiEngineer: 'KI-Ingenieur',
			dataAnalyst: 'Datenanalyst',
			dataEngineer: 'Dateningenieur',
			dataScientist: 'Data Scientist',
			productManager: 'Produktmanager',
			technicalFounder: 'Technischer Gründer',
			studentResearcher: 'Student / Forscher',
			other: 'Andere',
		},
		otherPlaceholder: 'Bitte angeben',
	},
	teamSize: {
		label: 'Wie groß ist Ihr Team?',
		placeholder: 'Teamgröße auswählen',
		options: {
			justMe: 'Nur ich',
			twoToFive: '2–5 Personen',
			sixToTwenty: '6–20 Personen',
			twentyOneToHundred: '21–100 Personen',
			hundredPlus: '100+ Personen',
		},
	},
	hearAboutUs: {
		label: 'Wie haben Sie von uns gehört?',
		placeholder: 'Option auswählen',
		options: {
			friendColleague: 'Freund / Kollege',
			linkedin: 'LinkedIn',
			youtube: 'YouTube',
			x: 'X',
			discord: 'Discord',
			googleSearch: 'Google-Suche',
			event: 'Veranstaltung / Meetup / Konferenz',
			other: 'Andere',
		},
		referredByPlaceholder: 'Name des RocketRide-Teammitglieds',
		otherPlaceholder: 'Bitte angeben',
	},
};
