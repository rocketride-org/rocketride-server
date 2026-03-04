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

import { ITranslationFlow } from '../en/flow';

/** German translations for the "flow" namespace covering the project canvas and pipeline editor. */
export const flow: ITranslationFlow = {
	addSource: 'Beginnen Sie mit der Auswahl einer Datenquelle',
	status: {
		saving: 'Speichern...',
		running: 'Ausführen...',
		pending: 'Ausstehend...',
		updated: 'Aktualisiert',
		unsaved: 'Ungespeicherte Änderungen',
		saved: 'Gespeichert',
		new: 'Neu',
	},
	success: {
		running: 'Projekt gestartet.',
		saved: 'Projekt gespeichert.',
		vectorize: {
			saved: 'Vektordatenbank gespeichert.',
		},
	},
	errors: {
		running: 'Projekt konnte nicht gestartet werden.',
		saved: 'Projekt konnte nicht gespeichert werden.',
		vectorize: {
			saved: 'Vektordatenbank konnte nicht gespeichert werden.',
			unsaved: 'Vektordatenbank enthält ungespeicherte Änderungen.',
		},
		servicesError: 'Fehler bei der Konfiguration der Dienste',
		checkServices: 'Bitte überprüfen Sie Ihre Konfiguration und versuchen Sie es erneut.',
	},
	modals: {
		planInvalid: {
			title: 'Ihr aktuelles Abonnement unterstützt diese Komponenten nicht',
			subtitle: 'Diese Pipeline wird nicht ausgeführt.',
			services: 'Diese Konnektoren erfordern die folgenden Pläne:',
			button1: 'Pipeline neu konfigurieren',
			button2: 'Demnächst verfügbar: Plan upgraden',
		},
		planDowngradeWarning: {
			title: '⚠️ Warnung: Ihr Enterprise-Abonnement läuft bald ab',
			subtitle: 'Diese Pipeline wird am Ende Ihres Abrechnungszeitraums gestoppt.',
			services1: 'Diese Konnektoren erfordern die folgenden Pläne:',
			services2:
				'Bitte verlängern Sie Ihren Plan oder passen Sie diese Konnektoren an, bevor Ihr Abrechnungszeitraum endet.',
			button1: 'Pipeline neu konfigurieren',
			button2: 'Pipeline ausführen',
		},
	},
	panels: {
		node: {
			noForm: 'Kein Formular verfügbar',
			showAllCls: 'Alle ausgewählten Klassifikationen anzeigen',
			saveChanges: 'Änderungen speichern',
			saving: 'Wird gespeichert...',
			validating: 'Wird validiert...',
			saveAndNext: 'Speichern und zum nächsten',
			saveAndRerun: 'Speichern und erneut ausführen',
		},
		createNode: {
			header: 'Knoten hinzufügen',
			curate: 'Ihre Daten aufbereiten (Optional)',
			vectorize: 'Vektordatenbank',
			documentation: 'ROCKETRIDE Dokumentation:',
			planInvalid: 'Der aktuelle Abonnementplan enthält diesen Connector nicht',
			planUpgrade: 'Demnächst verfügbar: Abonnementplan upgraden',
		},
		headerTooltips: {
			source: 'Komponenten, die Daten aus externen Systemen, Datenbanken und Speicherorten abrufen. Diese Connectoren dienen als Einstiegspunkte, um Daten aus verschiedenen Quellen wie Cloud-Speicher, Dateisystemen und Unternehmensanwendungen in Ihren Workflow zu bringen.',
			embedding:
				'Komponenten, die Text, Bilder oder andere Daten in Vektordarstellungen umwandeln. Diese Tools transformieren Inhalte in numerische Einbettungen, die semantische Bedeutung erfassen und Ähnlichkeitssuche, Clustering und andere vektorbasierte Operationen ermöglichen.',
			llm: 'Komponenten, die sich in verschiedene KI-Sprachmodelle zur Textgenerierung und -verständnis integrieren. Diese Connectoren bieten NLP-Funktionen wie Textgenerierung, Zusammenfassung, Fragebeantwortung und Inhaltserstellung.',
			database:
				'Komponenten, die strukturierte und Vektordaten speichern, verwalten und abrufen. Diese Connectoren bieten dauerhafte Speicherlösungen für Einbettungen, Metadaten und Verarbeitungsergebnisse und ermöglichen effizientes Datenmanagement und -abruf.',
			image: 'Komponenten, die visuelle Inhalte verarbeiten, analysieren und transformieren. Diese Tools übernehmen bildspezifische Operationen wie OCR (Texterkennung), Thumbnail-Erstellung und visuelle Inhaltsanalyse.',
			filter: 'Komponenten, die Daten basierend auf bestimmten Kriterien verarbeiten und transformieren. Diese Tools modifizieren, bereinigen oder schwärzen Inhalte, einschließlich Operationen wie Anonymisierung, Inhaltsfilterung und Datenumwandlung.',
			preprocessor:
				'Komponenten, die Daten für die nachgelagerte Verarbeitung vorbereiten und optimieren. Diese Connectoren übernehmen Textaufteilung, Normalisierung, Formatierung und andere Vorbereitungsaufgaben, um die Qualität nachfolgender Operationen zu verbessern.',
			other: 'Utility-Komponenten, die spezialisierte Funktionen bieten, die von anderen Kategorien nicht abgedeckt werden. Dazu gehören Workflow-Orchestrierung, Antwortformatierung, Fragenverwaltung und andere unterstützende Funktionen für komplexe Datenpipelines.',
			audio: 'Komponenten, die Audioinhalte verarbeiten, analysieren und transformieren. Diese Tools übernehmen Operationen wie Speech-to-Text-Transkription, Audiofeature-Extraktion, Rauschreduzierung und Audioinhaltsanalyse und ermöglichen Workflows, die das Verständnis oder die Manipulation von Klang erfordern.',
			target: 'Komponenten, die Daten an externe Systeme, Ziele oder Anwendungen liefern oder exportieren. Diese Connectoren dienen als Endpunkte in Ihrem Workflow und ermöglichen die Übertragung, Synchronisierung oder Veröffentlichung verarbeiteter Daten in Cloud-Speicher, Datenbanken, APIs oder andere Zielplattformen.',
			text: 'Komponenten, die Textdaten verarbeiten, analysieren oder transformieren. Diese Tools unterstützen Operationen wie Textnormalisierung, Tokenisierung, Spracherkennung, Sentiment-Analyse und andere Aufgaben, die das Verständnis oder die Manipulation von Rohtext innerhalb von Workflows verbessern.',
			infrastructure:
				'Komponenten, die grundlegende Dienste oder Funktionen für die Workflow-Ausführung und Systemintegration bereitstellen. Dazu gehören Tools für Authentifizierung, Planung, Überwachung, Protokollierung und Ressourcenverwaltung, die einen zuverlässigen und skalierbaren Betrieb von Datenpipelines und Anwendungen gewährleisten.',
			store: 'Komponenten, die auf das Speichern und Suchen hochdimensionaler Vektoreinbettungen spezialisiert sind. Diese Connectoren ermöglichen effiziente Ähnlichkeitssuche, Abfrage und Verwaltung von vektorisierten Daten­darstellungen – wie jene, die von Einbettungs­modellen generiert werden – und unterstützen Anwendungsfälle wie semantische Suche und nächstgelegene Nachbarschaftsabfragen.',
			data: 'Komponenten, die strukturierte oder tabellarische Daten speichern, verwalten und abrufen. Diese Connectoren bieten dauerhafte Speicherlösungen für Daten wie Datensätze, Tabellen und Metadaten und unterstützen effizientes Abfragen, Aktualisieren und Verwalten strukturierter Datensätze.',
		},
		importExport: {
			header: 'Import / Export',
			exportHeader: 'Exportieren',
			exportButton: 'Projekt exportieren',
			importHeader: 'Importieren',
			importButton: 'Projekt importieren',
			wrongFileType: 'Bitte wählen Sie eine gültige JSON-Datei aus.',
		},
	},
	tooltip: {
		history: 'Projektprotokoll anzeigen',
		delete: 'Projekt löschen',
		save: 'Speichern',
		saveAs: 'Speichern unter',
		run: 'Projekt ausführen',
		stop: 'Pipeline stoppen',
		devMode: 'Entwicklermodus',
		logs: 'Logs anzeigen',
		addNode: 'Knoten hinzufügen',
		importExport: 'Import / Export',
		wizard: 'Hilfsanleitung umschalten',
		hideWizard: 'Hilfsanleitung',
		showWizard: 'Hilfsanleitung anzeigen',
		moreOptions: 'Weitere Optionen',
		fitScreen: 'An Bildschirm anpassen',
		zoomIn: 'Vergrößern',
		zoomOut: 'Verkleinern',
		unlock: 'Entsperren',
		lock: 'Sperren',
		createNote: 'Neue Notiz erstellen',
		undo: 'Rückgängig',
		redo: 'Wiederholen',
		rocketrideClientConnected: 'RocketRide Client ist verbunden',
		rocketrideClientDisconnected: 'RocketRide Client ist nicht verbunden',
	},
	menu: {
		viewApiKey: 'API-Schlüssel bearbeiten',
		delete: 'Projekt löschen',
	},
	annotationNode: {
		placeholder: 'Doppelklicken zum Bearbeiten...',
	},
	notification: {
		copyToClipboard: 'Die URL wurde in die Zwischenablage kopiert',
		runSuccess: 'Pipeline erfolgreich gestartet',
		runError: 'Pipeline konnte nicht gestartet werden',
		authError: 'Authentifizierung fehlgeschlagen. Bitte überprüfen Sie Ihren API-Schlüssel.',
		abortSuccess: 'Pipeline erfolgreich abgebrochen',
		abortError: 'Pipeline konnte nicht abgebrochen werden',
		insufficientTokenBalance:
			'Ihr Guthaben hat nicht genügend Tokens. Bitte überprüfen Sie die Seite "Nutzung".',
		validationError: 'Validierungsfehler',
		validationWarning: 'Warnung',
		unsavedConnectors: 'Pipeline konnte nicht gestartet werden: Ungespeicherte Verbindungen.',
		planInvalidError:
			'Pipeline konnte nicht gestartet werden: Ungültiger Plan für ausgewählte Konnektoren.',
	},
	laneMapping: {
		data: 'Daten',
	},
	shortcuts: {
		title: 'Tastenkombinationen',
		showTitle: 'Tastenkombinationen anzeigen',
		hideTitle: 'Tastenkombinationen verbergen',
		navigate: 'Leinwand navigieren',
		arrowKeys: 'Pfeiltasten',
		save: 'Projekt speichern',
		selectAll: 'Alle Knoten auswählen',
		delete: 'Ausgewählte löschen',
		deleteKey: 'Entf/Rückschritt',
		group: 'Ausgewählte gruppieren',
		ungroup: 'Gruppierung aufheben',
		toggleDevMode: 'Dev-Modus umschalten',
		runPipeline: 'Pipeline ausführen',
		search: 'Suche',
		searchPlaceholder: 'Knoten suchen...',
		copy: 'Kopieren',
		paste: 'Einfügen',
		nodeTraversal: 'Knotentraversierung',
		undo: 'Rückgängig',
		redo: 'Wiederholen',
		groups: {
			editing: 'Grundlegende Bearbeitung',
			selection: 'Auswahl & Gruppierung',
			navigation: 'Navigation & Suche',
			project: 'Projekt & Ausführung',
		},
	},
	firstTimeDownload: {
		incomplete: {
			title: 'Bitte warten! Abhängigkeiten werden installiert für',
			installing: 'Bitte warten! Installiere',
		},
		complete: {
			title: 'Abhängigkeiten sind jetzt installiert',
			message: 'Beim nächsten Ausführen dieser Pipeline sollte sie viel schneller laden',
		},
		error: {
			message:
				'Beim Installieren einiger Abhängigkeiten ist ein Problem aufgetreten. Bitte versuchen Sie es erneut oder überprüfen Sie Ihre Netzwerkverbindung.',
		},
	},
	autosave: {
		autosave: 'Automatisch speichern',
		save: 'Speichern',
		saving: 'Wird gespeichert',
		saved: 'Gespeichert',
		cancel: 'Abbrechen',
		saveAsModal: {
			title: 'Speichern unter',
			projectNameLabel: 'Projektname',
			projectNamePlaceholder: 'Projektnamen eingeben',
			descriptionLabel: 'Beschreibung',
			descriptionPlaceholders: [
				'Überzeuge dein zukünftiges Ich, dass das eine gute Idee war...',
				"Was ist die Geschichte? Mach's interessant.",
				'Verkaufe mir diese Pipeline in einem Absatz',
				'Warum verdient dieses Projekt es zu existieren?',
				'Dein zukünftiges Ich wird dir für diese Dokumentation danken',
				'Gib dieser Pipeline etwas Persönlichkeit',
				'Lass das cooler klingen als es wahrscheinlich ist',
				'Welches Problem lösen wir hier? (Sei ehrlich)',
				'Erkläre das, als wäre ich dein neugieriger Kollege',
				'Füge etwas Kontext hinzu, bevor du alles vergisst',
				'Jetzt dokumentieren, später bei dir selbst bedanken',
				'Was macht das anders als die anderen 47 Pipelines?',
			],
			accept: 'Änderungen speichern',
		},
	},
};
