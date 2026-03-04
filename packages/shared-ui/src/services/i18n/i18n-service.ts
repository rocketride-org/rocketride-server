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

/**
 * i18n service initialization module.
 * Configures i18next with react-i18next, loads English and German translation
 * resources for all application namespaces, and detects the active language.
 * The default export is the configured i18n instance ready for use throughout the app.
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { detectLanguageFromDomain } from './config';

import { common as commonEN } from './locales/en/common';
import { statsBlock as statsBlockEN } from './locales/en/stats-block';
import { flow as flowEn } from './locales/en/flow';
import { recentToolchains as recentToolchainsEN } from './locales/en/recent-toolchains';
import { projects as projectsEN } from './locales/en/projects';
import { home as homeEN } from './locales/en/home';
import { toolchainHistoryDrawer as toolchainHistoryDrawerEN } from './locales/en/toolchain-history-drawer';
import { taskLogItem as taskLogItemEN } from './locales/en/task-log-item';
import { toolchainDevDrawer as toolchainDevDrawerEN } from './locales/en/toolchain-dev-drawer';
import { addSource as addSourceEN } from './locales/en/add-source';
import { createToolchain as createToolchainEN } from './locales/en/create-toolchain';
import { classifications as classificationsEN } from './locales/en/classifications';
import { dialog as dialogEN } from './locales/en/dialog';
import { project as projectEN } from './locales/en/project';
import { form as formEN } from './locales/en/form';
import { onprem as onpremEN } from './locales/en/onprem';
import { templates as templatesEN } from './locales/en/templates';
import { apikeys as apikeysEN } from './locales/en/api-keys';
import { profile as profileEN } from './locales/en/profile';
import { termsService as termsServiceEN } from './locales/en/terms-service';
import { questionnaire as questionnaireEN } from './locales/en/questionnaire';
import { onboardingTour as onboardingTourEN } from './locales/en/onboarding-tour';

// German translations
import { common as commonDE } from './locales/de/common';
import { statsBlock as statsBlockDE } from './locales/de/stats-block';
import { flow as flowDE } from './locales/de/flow';
import { recentToolchains as recentToolchainsDE } from './locales/de/recent-toolchains';
import { projects as projectsDE } from './locales/de/projects';
import { home as homeDE } from './locales/de/home';
import { toolchainHistoryDrawer as toolchainHistoryDrawerDE } from './locales/de/toolchain-history-drawer';
import { taskLogItem as taskLogItemDE } from './locales/de/task-log-item';
import { toolchainDevDrawer as toolchainDevDrawerDE } from './locales/de/toolchain-dev-drawer';
import { addSource as addSourceDE } from './locales/de/add-source';
import { createToolchain as createToolchainDE } from './locales/de/create-toolchain';
import { classifications as classificationsDE } from './locales/de/classifications';
import { dialog as dialogDE } from './locales/de/dialog';
import { form as formDE } from './locales/de/form';
import { onprem as onpremDE } from './locales/de/onprem';
import { templates as templatesDE } from './locales/de/templates';
import { apikeys as apikeysDE } from './locales/de/api-keys';
import { profile as profileDE } from './locales/de/profile';
import { termsService as termsServiceDE } from './locales/de/terms-service';
import { questionnaire as questionnaireDE } from './locales/de/questionnaire';
import { onboardingTour as onboardingTourDE } from './locales/de/onboarding-tour';

/**
 * Module augmentation for i18next to provide custom type options.
 * Sets the default namespace to 'translation'. Full resource-level type
 * safety is enforced via the ITranslation* interfaces in each locale file.
 */
declare module 'i18next' {
	interface CustomTypeOptions {
		defaultNS: 'translation';
		// Resources are omitted here because TypeScript cannot resolve the full
		// dot-separated key paths for 22 deeply-nested translation namespaces
		// (exceeds recursion/union limits). Type safety for translations is
		// enforced at the resource-object level via ITranslation* interfaces.
	}
}

/**
 * Combined translation resources for all supported locales.
 * Each locale maps a flat 'translation' namespace to an object of domain-specific
 * translation groups (common, flow, dialog, etc.).
 */
const resources = {
	en: {
		translation: {
			common: commonEN,
			statsBlock: statsBlockEN,
			flow: flowEn,
			recentToolchains: recentToolchainsEN,
			projects: projectsEN,
			home: homeEN,
			taskLogItem: taskLogItemEN,
			toolchainHistoryDrawer: toolchainHistoryDrawerEN,
			toolchainDevDrawer: toolchainDevDrawerEN,
			addSource: addSourceEN,
			createToolchain: createToolchainEN,
			classifications: classificationsEN,
			dialog: dialogEN,
			project: projectEN,
			form: formEN,
			onprem: onpremEN,
			templates: templatesEN,
			apikeys: apikeysEN,
			profile: profileEN,
			termsService: termsServiceEN,
			questionnaire: questionnaireEN,
			onboardingTour: onboardingTourEN,
		},
	},
	de: {
		translation: {
			common: commonDE,
			statsBlock: statsBlockDE,
			flow: flowDE,
			recentToolchains: recentToolchainsDE,
			projects: projectsDE,
			home: homeDE,
			taskLogItem: taskLogItemDE,
			toolchainHistoryDrawer: toolchainHistoryDrawerDE,
			toolchainDevDrawer: toolchainDevDrawerDE,
			addSource: addSourceDE,
			createToolchain: createToolchainDE,
			classifications: classificationsDE,
			dialog: dialogDE,
			form: formDE,
			onprem: onpremDE,
			templates: templatesDE,
			apikeys: apikeysDE,
			profile: profileDE,
			termsService: termsServiceDE,
			questionnaire: questionnaireDE,
			onboardingTour: onboardingTourDE,
		},
	},
};

i18n.use(initReactI18next).init({
	resources,
	lng: detectLanguageFromDomain(),
	interpolation: {
		escapeValue: false,
	},
});

export default i18n;
