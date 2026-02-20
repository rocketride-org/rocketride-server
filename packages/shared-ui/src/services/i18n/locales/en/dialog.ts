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

/**
 * Type definition for the "dialog" translation namespace.
 * Describes translatable strings for modal dialogs throughout the application,
 * including delete confirmations, leave-without-saving prompts, rename, save, and save-as dialogs.
 */
export interface ITranslationDialog {
	delete: {
		title: string;
		message: {
			project: string;
			projectWithRunningTasks: string;
			customCls: string;
		};
		cancelText: string;
		acceptText: string;
	};
	leave: {
		message: string;
		cancelText: string;
		acceptText: string;
		dontShowAgain: string;
	};
	rename: {
		title: string;
		message: string;
		cancelText: string;
		acceptText: string;
		placeholder: string;
	};
	save: {
		title: string;
		message: string;
		cancel: string;
		accept: string;
		discard: string;
		nameTitle: string;
		placeholder: string;
	};
	saveAs: {
		title: string;
		nameTitle: string;
	};
}

/** English translations for the "dialog" namespace covering modal dialog UI strings. */
export const dialog: ITranslationDialog = {
	delete: {
		title: 'Are you sure you want to delete?',
		message: {
			project: 'The project "{{name}}" will be deleted',
			projectWithRunningTasks:
				'You have running pipelines on this project, they will be aborted.\nThe project "{{name}}" will be deleted',
			customCls: 'Custom classification "{{name}}" will be deleted',
		},
		cancelText: 'No',
		acceptText: 'Yes, delete',
	},
	leave: {
		message: 'Are you sure you want to leave without saving?',
		cancelText: 'No',
		acceptText: 'Yes',
		dontShowAgain: "Don't show again",
	},
	rename: {
		title: 'Rename',
		message: 'Please enter a new name',
		cancelText: 'Cancel',
		acceptText: 'Save',
		placeholder: 'New name',
	},
	save: {
		title: 'Save',
		message: 'Please enter a name',
		cancel: 'Cancel',
		accept: 'Save',
		discard: 'Discard',
		nameTitle: '{{type}} name',
		placeholder: 'New name',
	},
	saveAs: {
		title: 'Save As',
		nameTitle: '{{type}} name',
	},
};
