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
 * Type definition for the "add source" translation namespace.
 * Describes the shape of all translatable strings used in the data-source
 * connection wizard (select, form, success steps, and Google Drive picker).
 */
export interface ITranslationAddSource {
	selectStep: {
		title: string;
		subtitle: string;
	};
	formStep: {
		title: string;
		subtitle: string;
		backButton: string;
		submitButton: string;
		authenticated: string;
		loginWithMicrosoftButton: string;
		loginWithGoogleButton: string;
		loginWithSlackButton: string;
	};
	successStep: {
		title: string;
		submitButton: string;
	};
	googleDrivePicker: {
		configureEnv: string;
		authenticateFirst: string;
		sessionExpired: string;
		selectedItem: string;
		clearSelection: string;
		changeSelection: string;
		chooseInGoogleDrive: string;
		selectionRequired: string;
		failedToOpenPicker: string;
		failedToLoadApi: string;
		failedToFetchNames: string;
	};
}

/** English translations for the "add source" namespace covering the data-source connection wizard. */
export const addSource: ITranslationAddSource = {
	selectStep: {
		title: 'Where is your data?',
		subtitle: 'Choose one of the services below',
	},
	formStep: {
		title: 'Add data source',
		subtitle: 'Enter your credentials below',
		backButton: 'Back',
		submitButton: 'Connect',
		authenticated: 'Authenticated',
		loginWithMicrosoftButton: 'Login with Microsoft',
		loginWithGoogleButton: 'Login with Google',
		loginWithSlackButton: 'Connect to Slack',
	},
	successStep: {
		title: 'Data Source Saved Successful',
		submitButton: 'Go to Data Connections',
	},
	googleDrivePicker: {
		configureEnv:
			'Configure REACT_APP_GOOGLE_PICKER_CLIENT_ID and REACT_APP_GOOGLE_PICKER_DEVELOPER_KEY to enable the picker.',
		authenticateFirst:
			'Please authenticate with Google first using the "Login with Google" button.',
		sessionExpired:
			'Your Google session has expired or is invalid. Please re-authenticate using the "Login with Google" button.',
		selectedItem: 'Selected item',
		clearSelection: 'Clear Selection',
		changeSelection: 'Change Selection',
		chooseInGoogleDrive: 'Choose in Google Drive',
		selectionRequired: 'A selection is required.',
		failedToOpenPicker: 'Failed to open Google Drive picker. Please try again.',
		failedToLoadApi: 'Failed to load Google Picker API',
		failedToFetchNames: 'Failed to fetch file names from Google Drive API',
	},
};
