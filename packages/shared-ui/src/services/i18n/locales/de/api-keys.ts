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

import { ITranslationApikeys } from '../en/api-keys';

/** German translations for the "api-keys" namespace covering API key management UI. */
export const apikeys: ITranslationApikeys = {
	title: 'API-Schlüssel',
	description:
		'Verwalten Sie Ihre API-Schlüssel für den programmatischen Zugriff auf RocketRide-Dienste.',
	createNew: 'Neuen API-Schlüssel erstellen',
	createApiKey: 'API-Schlüssel erstellen',
	apiKeyName: 'API-Schlüssel-Name',
	apiKeyNamePlaceholder: 'Geben Sie einen beschreibenden Namen für Ihren API-Schlüssel ein',
	create: 'Erstellen',
	cancel: 'Abbrechen',
	delete: 'Löschen',
	confirmDelete: 'Löschen bestätigen',
	confirmDeleteMessage:
		'Sind Sie sicher, dass Sie diesen API-Schlüssel löschen möchten? Diese Aktion kann nicht rückgängig gemacht werden.',
	name: 'Name',
	key: 'Schlüssel',
	createdAt: 'Erstellt',
	lastUsed: 'Zuletzt verwendet',
	status: 'Status',
	active: 'Aktiv',
	inactive: 'Inaktiv',
	actions: 'Aktionen',
	copyKey: 'Schlüssel kopieren',
	keyCopied: 'Schlüssel in Zwischenablage kopiert',
	noApiKeys: 'Keine API-Schlüssel gefunden. Erstellen Sie Ihren ersten API-Schlüssel.',
	loadingError: 'Fehler beim Laden der API-Schlüssel. Bitte versuchen Sie es erneut.',
	createError: 'Fehler beim Erstellen des API-Schlüssels. Bitte versuchen Sie es erneut.',
	deleteError: 'Fehler beim Löschen des API-Schlüssels. Bitte versuchen Sie es erneut.',
	deleteSuccess: 'API-Schlüssel erfolgreich gelöscht.',
	createSuccess: 'API-Schlüssel erfolgreich erstellt.',
};
