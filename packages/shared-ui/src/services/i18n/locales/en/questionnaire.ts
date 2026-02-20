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
 * Type definition for the "questionnaire" translation namespace.
 * Describes translatable strings for the post-signup user questionnaire
 * including role selection, team size, and referral source options.
 */
export interface ITranslationQuestionnaire {
	title: string;
	skip: string;
	submit: string;
	submitting: string;
	role: {
		label: string;
		placeholder: string;
		options: {
			fullStackEngineer: string;
			aiEngineer: string;
			dataAnalyst: string;
			dataEngineer: string;
			dataScientist: string;
			productManager: string;
			technicalFounder: string;
			studentResearcher: string;
			other: string;
		};
		otherPlaceholder: string;
	};
	teamSize: {
		label: string;
		placeholder: string;
		options: {
			justMe: string;
			twoToFive: string;
			sixToTwenty: string;
			twentyOneToHundred: string;
			hundredPlus: string;
		};
	};
	hearAboutUs: {
		label: string;
		placeholder: string;
		options: {
			friendColleague: string;
			linkedin: string;
			youtube: string;
			x: string;
			discord: string;
			googleSearch: string;
			event: string;
			other: string;
		};
		referredByPlaceholder: string;
		otherPlaceholder: string;
	};
}

/** English translations for the "questionnaire" namespace covering the user onboarding survey. */
export const questionnaire: ITranslationQuestionnaire = {
	title: 'Tell us a little bit about you',
	skip: 'Skip',
	submit: 'Submit',
	submitting: 'Submitting...',
	role: {
		label: 'Which best describes your role?',
		placeholder: 'Select your role',
		options: {
			fullStackEngineer: 'Full Stack Engineer',
			aiEngineer: 'AI Engineer',
			dataAnalyst: 'Data Analyst',
			dataEngineer: 'Data Engineer',
			dataScientist: 'Data Scientist',
			productManager: 'Product Manager',
			technicalFounder: 'Technical Founder',
			studentResearcher: 'Student / Researcher',
			other: 'Other',
		},
		otherPlaceholder: 'Please specify',
	},
	teamSize: {
		label: 'How big is your team?',
		placeholder: 'Select team size',
		options: {
			justMe: 'Just me',
			twoToFive: '2–5 people',
			sixToTwenty: '6–20 people',
			twentyOneToHundred: '21–100 people',
			hundredPlus: '100+ people',
		},
	},
	hearAboutUs: {
		label: 'How did you hear from us?',
		placeholder: 'Select an option',
		options: {
			friendColleague: 'Friend / Colleague',
			linkedin: 'LinkedIn',
			youtube: 'YouTube',
			x: 'X',
			discord: 'Discord',
			googleSearch: 'Google Search',
			event: 'Event / Meetup / Conference',
			other: 'Other',
		},
		referredByPlaceholder: 'Name of RocketRide team member',
		otherPlaceholder: 'Please specify',
	},
};
