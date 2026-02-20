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
 * Type definition for the "task-log-item" translation namespace.
 * Describes translatable strings for individual task log entries in the
 * project history drawer, including status labels and processing details.
 */
export interface ITranslationTaskLogItem {
	status: {
		running: string;
		success: string;
		error: string;
		warning: string;
		aborted: string;
		unknown: string;
	};
	currentObject: string;
	currentObjectSize: string;
	processedObjects: string;
}

/** English translations for the "task-log-item" namespace covering pipeline task log entries. */
export const taskLogItem: ITranslationTaskLogItem = {
	status: {
		running: 'Running...',
		success: 'Success',
		error: 'Completed with error',
		warning: 'Completed with warning',
		aborted: 'Aborted',
		unknown: 'N/A',
	},
	currentObject: 'Current object',
	currentObjectSize: 'Current object size',
	processedObjects: 'Processed {{count}} items with total size of {{size}}',
};
