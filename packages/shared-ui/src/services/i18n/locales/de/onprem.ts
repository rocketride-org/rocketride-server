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

import { ITranslationOnprem } from '../en/onprem';

/** German translations for the "onprem" namespace covering on-premise authentication UI. */
export const onprem: ITranslationOnprem = {
	login: {
		title: 'Bei RocketRide anmelden',
		subtitle: 'Bitte melden Sie sich bei Ihrem Konto an',
		form: {
			email: 'Konto-E-Mail',
			password: 'Passwort',
			submit: 'Anmelden',
			errors: {
				blankEmail: 'E-Mail ist erforderlich',
				blankPassword: 'Passwort ist erforderlich',
				invalidEmail: 'Bitte geben Sie eine gültige E-Mail-Adresse ein',
			},
		},
		createAccount: 'RocketRide-Konto erstellen',
		forgotPassword: 'Passwort vergessen?',
	},
	register: {
		title: 'Bei RocketRide registrieren',
		subtitle: 'Melden Sie sich mit Ihrer E-Mail-Adresse an, um loszulegen',
		continueWithGithub: 'Mit GitHub fortfahren',
		orDivider: 'oder',
		form: {
			fullName: 'Vollständiger Name',
			email: 'Konto-E-Mail',
			newPassword: 'Passwort',
			confirmPassword: 'Passwort bestätigen',
			submit: 'Registrieren',
			errors: {
				passwordMismatch: 'Passwörter stimmen nicht überein',
				blankUserName: 'Vollständiger Name ist erforderlich',
				blankEmail: 'E-Mail ist erforderlich',
				blankPassword: 'Passwort ist erforderlich',
				invalidEmail: 'Bitte geben Sie eine gültige E-Mail-Adresse ein',
			},
		},
		haveAccount: 'Bereits ein Konto?',
	},
	forgotPassword: {
		title: 'Passwort zurücksetzen',
		subtitle:
			'Bitte geben Sie Ihre E-Mail-Adresse ein. Wir senden Ihnen einen 6-stelligen Code zum Zurücksetzen Ihres Passworts.',
		form: {
			email: 'Konto-E-Mail',
			submit: 'Zurücksetzungscode senden',
			submitting: 'Wird gesendet...',
			enterCode: 'Zurücksetzungscode eingeben',
		},
		successMessage:
			'Falls ein Konto mit dieser E-Mail-Adresse existiert, wurde ein Passwort-Zurücksetzungscode an Ihre E-Mail-Adresse gesendet.',
		back: 'Zurück zur Anmeldung',
	},
	resetPassword: {
		title: 'Passwort zurücksetzen',
		subtitle:
			'Bitte geben Sie den an Ihre E-Mail-Adresse gesendeten 6-stelligen Zurücksetzungscode ein.',
		passwordSubtitle: 'Bitte geben Sie Ihr neues Passwort für {{email}} ein.',
		form: {
			resetCode: 'Zurücksetzungscode',
			newPassword: 'Neues Passwort',
			confirmPassword: 'Passwort bestätigen',
			submit: 'Passwort zurücksetzen',
			verifyCode: 'Code überprüfen',
			verifying: 'Wird überprüft...',
			resetting: 'Wird zurückgesetzt...',
			errors: {
				invalidCode: 'Ungültiger oder abgelaufener Zurücksetzungscode',
				blankPassword: 'Passwort ist erforderlich',
				passwordMismatch: 'Passwörter stimmen nicht überein',
			},
		},
		back: 'Zurück zur Anmeldung',
	},
	verification: {
		title: 'E-Mail-Verifizierung',
		subtitle: 'Bitte geben Sie den an Ihre E-Mail-Adresse gesendeten Verifizierungscode ein.',
		form: {
			verificationCode: 'Verifizierungscode',
			submit: 'E-Mail verifizieren',
		},
		resendCode: 'Code erneut senden',
		resending: 'Wird gesendet...',
		logout: 'Abmelden',
	},
};
