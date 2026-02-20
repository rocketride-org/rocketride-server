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
 * Optional callbacks for clipboard copy operations.
 * Used to notify the caller on success (e.g., show a toast) or on failure.
 */
interface IOptions {
	/** Called when the text is successfully copied to the clipboard. */
	handleSuccess?: () => void;
	/** Called when the copy operation fails. */
	handleError?: (e: Error) => void;
}

/**
 * Signature for a function that copies text to the clipboard.
 * @param text - The text to copy.
 * @param options - Optional success/error callbacks.
 * @param parentElement - Optional parent element used by the textarea fallback strategy.
 */
type ICopyToClipboard = (text: string, options?: IOptions, parentElement?: HTMLElement) => void;

/**
 * Copies text to the clipboard using the modern `navigator.clipboard` API.
 * Preferred when the Clipboard API is available; falls back handled by {@link copyToClipboard}.
 *
 * @param text - The text to copy.
 * @param options - Optional success/error callbacks.
 */
export const copyWithClipboardApi: ICopyToClipboard = (text, options) => {
	navigator.clipboard
		.writeText(text)
		.then(() => {
			if (options?.handleSuccess) {
				options.handleSuccess();
			}
		})
		.catch((e) => {
			if (options?.handleError) {
				options.handleError(e);
			}
		});
};

/**
 * Fallback clipboard copy that creates a hidden textarea, selects its content,
 * and executes `document.execCommand('copy')`. Used in environments where
 * the modern Clipboard API is unavailable.
 *
 * @param text - The text to copy.
 * @param options - Optional success/error callbacks.
 * @param parentElement - The DOM element to temporarily append the textarea to.
 */
const copyWithTextAreaAppend: ICopyToClipboard = (text, options, parentElement = document.body) => {
	// Create an off-screen textarea to hold the text for the copy command
	const textarea = document.createElement('textarea');
	textarea.textContent = text;
	textarea.setAttribute('value', text);
	textarea.style.position = 'fixed'; //avoid scrolling to bottom
	parentElement.appendChild(textarea);
	// Focus and select the textarea content so execCommand('copy') targets it
	textarea.focus();
	textarea.select();

	try {
		// Use the deprecated but widely-supported execCommand as a fallback
		document.execCommand('copy');
		if (options?.handleSuccess) {
			options.handleSuccess();
		}
	} catch (e) {
		// Normalize the error to an Error instance before passing to the callback
		if (options?.handleError) {
			options.handleError(e instanceof Error ? e : new Error(String(e)));
		}
	}

	// Clean up the temporary textarea from the DOM
	parentElement.removeChild(textarea);
	return;
};

/**
 * Copies text to the clipboard using the best available strategy.
 * Uses the modern Clipboard API when available, otherwise falls back to the
 * textarea-based `execCommand('copy')` approach.
 *
 * @param text - The text to copy.
 * @param options - Optional success/error callbacks.
 * @param parentElement - Optional parent element for the textarea fallback.
 */
export const copyToClipboard: ICopyToClipboard = (text, options = undefined, parentElement) => {
	// Feature-detect the modern Clipboard API; fall back to textarea approach if unavailable
	if (typeof navigator.clipboard === 'undefined') {
		copyWithTextAreaAppend(text, options, parentElement);
	} else {
		copyWithClipboardApi(text, options);
	}
};
