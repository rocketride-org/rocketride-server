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

import { ThemeProps, withTheme } from '@rjsf/core';
import { englishStringTranslator, replaceStringParameters, TranslatableString } from '@rjsf/utils';

import BaseInputTemplate from './base-input-template/BaseInputTemplate';
import FieldTemplate from './field-template/FieldTemplate';
import ObjectFieldTemplate from './object-field-template/ObjectFieldTemplate';
import SelectWidget from './select-widget/SelectWidget';
import CheckboxWidget from './checkbox-widget/CheckboxWidget';
import CheckboxesWidget from './checkboxes-widget/CheckboxesWidget';
import TitleField from './title-field/TitleFieldTemplate';
import DescriptionField from './description-field/DescriptionField';
import ArrayFieldItemTemplate from './array-field-item-template/ArrayFieldItemTemplate';
import ArrayFieldTemplate from './array-field-template/ArrayFieldTemplate';
import AddButton from './add-button/AddButton';
import SubmitButton from './submit-button/SubmitButton';
import FieldErrorTemplate from './field-error-template/FieldErrorTemplate';
import ErrorList from './error-list/ErrorList';
import LoginWithMicrosoftButton from './social-buttons/LoginWithMicrosoftButton';
import LoginWithGoogleButton from './social-buttons/LoginWithGoogleButton';
import LoginWithSlackButton from './social-buttons/LoginWithSlackButton';
import GoogleDrivePickerWidget from './google-drive-picker-widget/GoogleDrivePickerWidget';
import ApiKeyWidget from './api-key-widget/ApiKeyWidget';
import TextareaWidget from './textarea-widget/TextareaWidget';

/** Stub component that renders nothing. Classifications widget and classification node have been removed. */
const ClassificationsWidgetStub = () => null;
import FileWidget from './file-widget/FileWidget';

/**
 * RJSF theme configuration object that maps custom MUI-based templates and widgets
 * to the react-jsonschema-form framework. This defines the visual appearance and
 * behavior of all dynamically-generated forms in the application, including
 * field layouts, input controls, social login buttons, and specialized widgets
 * like file uploads and Google Drive pickers.
 */
const ThemeObject: ThemeProps = {
	templates: {
		ObjectFieldTemplate: ObjectFieldTemplate,
		FieldTemplate: FieldTemplate,
		FieldErrorTemplate: FieldErrorTemplate,
		BaseInputTemplate: BaseInputTemplate,
		TitleFieldTemplate: TitleField,
		DescriptionFieldTemplate: DescriptionField,
		ArrayFieldTemplate: ArrayFieldTemplate,
		// @ts-expect-error ArrayFieldItemTemplate has additional isLast prop
		ArrayFieldItemTemplate: ArrayFieldItemTemplate,
		ButtonTemplates: {
			AddButton,
			SubmitButton,
		},
		ErrorListTemplate: ErrorList,
	},
	widgets: {
		SelectWidget,
		CheckboxWidget,
		CheckboxesWidget,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		MicrosoftButtonWidget: LoginWithMicrosoftButton as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		GoogleButtonWidget: LoginWithGoogleButton as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		SlackButtonWidget: LoginWithSlackButton as any,
		GoogleDrivePickerWidget,
		classifications: ClassificationsWidgetStub,
		ApiKeyWidget: ApiKeyWidget,
		TextareaWidget,
		textarea: TextareaWidget,
		FileWidget,
	},
};

/**
 * Custom RJSF string translator that overrides default translatable strings.
 * Provides application-specific labels (e.g., empty defaults for new strings,
 * "Add One More" for array item buttons) while falling back to the built-in
 * English translator for everything else.
 *
 * @param stringToTranslate - The RJSF translatable string key to translate.
 * @param params - Optional replacement parameters for the translated string.
 * @returns The translated string with any parameters substituted.
 */
export const translate = (stringToTranslate: TranslatableString, params?: string[]): string => {
	switch (stringToTranslate) {
		// New array string items should start empty rather than with RJSF's default "New Value"
		case TranslatableString.NewStringDefault:
			return '';
		// Override the default "Add Item" label with a friendlier phrasing
		case TranslatableString.AddItemButton:
			return replaceStringParameters('Add...', params);
		// All other translatable strings fall through to RJSF's built-in English translations
		default:
			return englishStringTranslator(stringToTranslate, params);
	}
};

/**
 * The themed RJSF Form component with all custom MUI templates and widgets applied.
 * Use this as the base Form component for rendering JSON Schema-driven forms throughout the application.
 */
export default withTheme(ThemeObject);
