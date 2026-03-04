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

import { ITranslationTermSerivce } from '../en/terms-service';

/** German translations for the "terms-service" namespace covering the Terms of Service page. */
export const termsService: ITranslationTermSerivce = {
	title: 'Nutzungsbedingungen',
	intro: 'Bitte lesen Sie die folgenden Bedingungen sorgfältig durch, bevor Sie fortfahren. Ihre Zustimmung ist erforderlich, um auf unsere Dienste zuzugreifen und sie zu nutzen.',
	description:
		'Ein Softwarelizenzvertrag ist ein rechtlich bindender Vertrag zwischen einem Softwareanbieter und dem Endbenutzer, der die Bedingungen festlegt, unter denen die Software verwendet werden kann. Für die RocketRide-Plattform würde ein solcher Vertrag typischerweise die folgenden Abschnitte enthalten:',
	definitions: {
		title: '1. Definitionen',
		software:
			'"Software": Bezieht sich auf die RocketRide-Plattform, einschließlich aller zugehörigen Komponenten, Funktionen und Dokumentationen.',
		licensee:
			'"Lizenznehmer": Die Person oder das Unternehmen, die/das zur Nutzung der Software unter diesem Vertrag berechtigt ist.',
		licensor:
			'"Lizenzgeber": RocketRide, Inc., der Eigentümer und Anbieter der Software.',
	},
	licenseGrant: {
		title: '2. Lizenzgewährung',
		content:
			'Der Lizenzgeber gewährt dem Lizenznehmer ein nicht ausschließliches, nicht übertragbares Recht zur Nutzung der Software, vorbehaltlich der hierin festgelegten Bedingungen.',
	},
	licenseRestrictions: {
		title: '3. Lizenzbeschränkungen',
		intro: 'Der Lizenznehmer verpflichtet sich, folgendes nicht zu tun:',
		'restrictions.0':
			'Die Software zu modifizieren, zu reverse-engineern oder zu dekompilieren.',
		'restrictions.1': 'Die Software an Dritte zu verteilen oder zu unterlizenzieren.',
		'restrictions.2':
			'Die Software über den vereinbarten Umfang oder die Anzahl der Benutzer hinaus zu verwenden.',
	},
	ownership: {
		title: '4. Eigentum und geistiges Eigentum',
		content:
			'Alle Rechte, Titel und Interessen an der Software, einschließlich der Rechte des geistigen Eigentums, verbleiben beim Lizenzgeber. Der Lizenznehmer erwirbt keine Rechte an der Software, außer denen, die ausdrücklich in diesem Vertrag gewährt werden.',
	},
	termination: {
		title: '5. Laufzeit und Kündigung',
		content:
			'Dieser Vertrag ist wirksam, bis er von einer der Parteien gekündigt wird. Der Lizenznehmer kann ihn jederzeit kündigen, indem er die Nutzung der Software einstellt und alle Kopien löscht. Der Lizenzgeber kann ihn aus jedem Grund mit Mitteilung an den Lizenznehmer kündigen. Bei Kündigung muss der Lizenznehmer alle Kopien der Software deinstallieren und vernichten.',
	},
	disclaimer: {
		title: '6. Gewährleistungsausschluss',
		content:
			'Die Software wird "wie besehen" ohne Gewährleistung jeglicher Art, ausdrücklich oder stillschweigend, einschließlich, aber nicht beschränkt auf die Gewährleistungen der Marktgängigkeit, Eignung für einen bestimmten Zweck und Nichtverletzung bereitgestellt. Der Lizenzgeber gewährleistet nicht, dass die Software fehlerfrei oder unterbrechungsfrei ist.',
	},
	limitation: {
		title: '7. Haftungsbeschränkung',
		content:
			'In keinem Fall haftet der Lizenzgeber für indirekte, zufällige, besondere oder Folgeschäden, einschließlich, aber nicht beschränkt auf Verlust von Gewinnen, Daten oder Nutzung, die aus diesem Vertrag oder der Nutzung oder Unfähigkeit zur Nutzung der Software entstehen, auch wenn der Lizenzgeber auf die Möglichkeit solcher Schäden hingewiesen wurde.',
	},
	governingLaw: {
		title: '8. Anwendbares Recht',
		content:
			'Dieser Vertrag unterliegt den Gesetzen der Gerichtsbarkeit, in der sich der Lizenzgeber befindet, und wird in Übereinstimmung mit diesen Gesetzen ausgelegt, ohne Berücksichtigung von Kollisionsnormen.',
	},
	amendments: {
		title: '9. Änderungen',
		content:
			'Der Lizenzgeber behält sich das Recht vor, diesen Vertrag jederzeit zu ändern. Der Lizenznehmer wird über alle Änderungen informiert, und die fortgesetzte Nutzung der Software stellt die Annahme der geänderten Bedingungen dar.',
	},
	entireAgreement: {
		title: '10. Gesamtvereinbarung',
		content:
			'Dieser Vertrag stellt die gesamte Vereinbarung zwischen den Parteien bezüglich des Gegenstands dar und ersetzt alle vorherigen oder gleichzeitigen Verständnisse oder Vereinbarungen, schriftlich oder mündlich, bezüglich dieses Gegenstands.',
	},
	close: 'Schließen',
};
