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
 * Global type declarations for Google APIs (Google Picker and GAPI).
 * These augment the Window interface so that Google Picker and GAPI objects
 * are recognized by TypeScript throughout the application. They are used by
 * the Google Drive picker widget and the Google OAuth login button to interact
 * with the Google Picker UI and Google Drive REST APIs.
 */
declare global {
	var google: Window['google'];
	var gapi: Window['gapi'];

	/** Extended Window interface with optional Google API and Picker globals. */
	interface Window {
		/** Google API client library for loading APIs and setting API keys. */
		gapi?: {
			load: (api: string, callback: (() => void) | { callback: () => void; onerror?: (error: unknown) => void }) => void;
			client: {
				setApiKey: (key: string) => void;
			};
		};
		/** Google Picker API namespace providing UI for selecting files from Google Drive. */
		google?: {
			picker: {
				PickerBuilder: new () => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					addView: (view: any) => any;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					enableFeature: (feature: any) => any;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					setDeveloperKey: (key: string) => any;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					setOAuthToken: (token: string) => any;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					setAppId: (appId: string) => any;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					setCallback: (callback: (data: any) => void) => any;
					build: () => {
						setVisible: (visible: boolean) => void;
					};
				};
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				DocsView: new (viewId?: any) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					setIncludeFolders: (include: boolean) => any;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					setSelectFolderEnabled: (enabled: boolean) => any;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					setMode: (mode: any) => any;
				};
				ViewId: {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					DOCUMENTS: any;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					FOLDERS: any;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					DOCS: any;
				};
				DocsViewMode: {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					LIST: any;
				};
				Feature: {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					SUPPORT_DRIVES: any;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					MULTISELECT_ENABLED: any;
				};
				Response: {
					ACTION: string;
					DOCUMENTS: string;
				};
				Action: {
					PICKED: string;
				};
				Document: {
					ID: string;
					NAME: string;
					MIME_TYPE: string;
					TYPE: string;
					PARENT_ID: string;
					URL: string;
				};
			};
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		pickerCallback?: (data: any) => void; // Global callback for the picker
	}
}

export {};
