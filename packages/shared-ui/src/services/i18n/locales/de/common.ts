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

import { ITranslationCommon } from '../en/common';

/** German translations for the "common" namespace covering app-wide shared UI strings. */
export const common: ITranslationCommon = {
	rocketride: 'RocketRide',
	copyright: 'Urheberrecht (c)',
	logout: 'Abmelden',
	profile: 'Profil',
	scanRunning: 'Scan läuft',
	actionRunning: 'Aktion wird ausgeführt',
	scanFailed: 'Scan fehlgeschlagen. Bitte erneut versuchen.',
	actionFailed: 'Laden fehlgeschlagen. Bitte erneut versuchen.',
	scanCompleted: 'Scan abgeschlossen.',
	actionCompleted: 'Laden abgeschlossen.',
	editConfiguration: 'Konfiguration bearbeiten',
	browse: 'Durchsuchen',
	delete: 'Löschen',
	navigation: {
		home: 'Startseite',
		sources: 'Quellen',
		toolchains: 'Projekte',
		browser: 'Browser',
		settings: 'Einstellungen',
		system: 'System',
		usage: 'Nutzung',
	},
	plan: 'plan',
	lastLoaded: 'Zuletzt geladen',
	next: 'Weiter',
	connectWithUs: 'Kontaktieren Sie uns',
	runningTasks: 'Sie haben laufende Prozesse in diesem Projekt',
	authorization: {
		title: 'Autorisierung',
		apiKeyPlaceholder: 'Geben Sie Ihren API-Schlüssel ein',
		apiKeyLabel: 'API-Schlüssel',
		apiKeyRequired: 'Sie müssen einen API-Schlüssel hinzufügen, um die Pipeline auszuführen',
		apiKeySuccess: 'API-Schlüssel erfolgreich gesetzt',
		submit: 'Absenden',
		joinWaitlist: 'Der Warteliste beitreten',
		goToUsagePortal: 'API-Schlüssel im Usage-Portal erhalten',
	},
	referral: {
		title: 'Einen Benutzer werben',
		copied: 'Empfehlungslink in die Zwischenablage kopiert!',
		copyLink: 'Empfehlungslink kopieren',
		description:
			'Laden Sie Ihren Freund ein, die Data Toolchain über Ihren Link auszuprobieren. Sobald sie sich anmelden, erhalten Sie beide kostenlose Tokens.',
		youGet1: 'Sie erhalten',
		youGet2: 'Tokens für jede Empfehlung.',
		youGetDescription: 'Für jeden Freund, den Sie einladen.',
		theyGet1: 'Ihr Freund erhält',
		theyGet2: 'Tokens.',
		theyGetDescription: 'Beim ersten Mal.',
		warning:
			'Ihr Freund muss den obigen Link verwenden, damit Sie und Ihr Freund Ihre Token-Belohnungen erhalten.',
	},
	moreMenu: {
		moreOptions: 'Weitere Optionen',
		open: 'Öffnen',
		duplicate: 'Duplizieren',
		selectAll: 'Alle auswählen',
		delete: 'Löschen',
		documentation: 'Dokumentation',
		ungroup: 'Gruppierung aufheben',
	},
	errorEmptyName: 'Bitte geben Sie einen Namen ein',
	errorExistingName: 'Bitte geben Sie einen neuen Namen ein',
	rename: 'Umbenennen',
	dateCreated: 'Erstellt',
	lastEdited: 'Zuletzt bearbeitet',
	account: {
		manageApiKeys: 'API-Schlüssel verwalten',
		manageProfile: 'Profil verwalten',
	},
	termsOfService: {
		text: 'Durch die Fortsetzung stimmen Sie unseren',
		link: 'Nutzungsbedingungen',
	},
	welcome: 'Willkommen bei der Data Toolchain!',
	help: {
		help: 'Hilfe',
		documentation: 'Dokumentation',
		videoTutorials: 'Video Tutorials',
		community: 'Community',
		requestFeature: 'Feature anfragen',
		reportBug: 'Fehler melden',
		submitFeedback: 'Feedback senden',
	},
	feedback: {
		feedback: 'Feedback',
	},
	changelog: {
		changelog: 'Änderungsprotokoll',
	},
	rocketrideClient: {
		connected: 'RocketRide Client ist verbunden',
		disconnected: 'RocketRide Client ist nicht verbunden',
	},
};
