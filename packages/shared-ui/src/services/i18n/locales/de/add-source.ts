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

import { ITranslationAddSource } from '../en/add-source';

/** German translations for the "add-source" namespace covering the data-source connection wizard. */
export const addSource: ITranslationAddSource = {
	selectStep: {
		title: 'Wo befinden sich Ihre Daten?',
		subtitle: 'Wählen Sie einen der unten aufgeführten Dienste aus',
	},
	formStep: {
		title: 'Datenquelle hinzufügen',
		subtitle: 'Geben Sie unten Ihre Anmeldedaten ein',
		backButton: 'Zurück',
		submitButton: 'Verbinden',
		authenticated: 'Authentifiziert',
		loginWithMicrosoftButton: 'Mit Microsoft anmelden',
		loginWithGoogleButton: 'Mit Google anmelden',
		loginWithSlackButton: 'Mit Slack anmelden',
	},
	successStep: {
		title: 'Datenquelle erfolgreich gespeichert',
		submitButton: 'Datenverbindungen',
	},
	googleDrivePicker: {
		configureEnv:
			'Konfigurieren Sie REACT_APP_GOOGLE_PICKER_CLIENT_ID und REACT_APP_GOOGLE_PICKER_DEVELOPER_KEY, um den Picker zu aktivieren.',
		authenticateFirst:
			'Bitte authentifizieren Sie sich zuerst mit Google über die Schaltfläche "Mit Google anmelden".',
		sessionExpired:
			'Ihre Google-Sitzung ist abgelaufen oder ungültig. Bitte authentifizieren Sie sich erneut über die Schaltfläche "Mit Google anmelden".',
		selectedItem: 'Ausgewähltes Element',
		clearSelection: 'Auswahl löschen',
		changeSelection: 'Auswahl ändern',
		chooseInGoogleDrive: 'In Google Drive auswählen',
		selectionRequired: 'Eine Auswahl ist erforderlich.',
		failedToOpenPicker:
			'Google Drive Picker konnte nicht geöffnet werden. Bitte versuchen Sie es erneut.',
		failedToLoadApi: 'Google Picker API konnte nicht geladen werden',
		failedToFetchNames: 'Dateinamen von der Google Drive API konnten nicht abgerufen werden',
	},
};
