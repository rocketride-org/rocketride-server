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

import { useEffect } from 'react';
import isHotkey from 'is-hotkey';
import { isEditableElement } from '../utils/isEditableElement';

/**
 * Hook that registers a global keyboard shortcut listener. The callback fires when
 * the specified hotkey combination is pressed, unless the user is focused on an
 * editable element (input, textarea, contenteditable) to avoid interfering with typing.
 *
 * @param hotkey - The hotkey string recognized by `is-hotkey` (e.g., 'mod+z', 'shift+enter').
 * @param callback - The function to invoke when the hotkey is pressed.
 */
export function useKeyDown(hotkey: string, callback: () => void) {
	useEffect(() => {
		// Pre-compile the hotkey matcher once per effect cycle for efficient repeated checks
		const keyConditionFn = isHotkey(hotkey);

		const handleKeyDown = (event: KeyboardEvent) => {
			// Skip if focused on an editable element (input, textarea, contenteditable)
			// to avoid hijacking normal typing behavior
			if (isEditableElement(event.target)) {
				return;
			}

			if (keyConditionFn(event)) {
				// Prevent browser default action (e.g., Ctrl+S triggering save dialog)
				event.preventDefault();
				callback();
			}
		};

		// Attach at the window level so the shortcut works regardless of which element has focus
		window.addEventListener('keydown', handleKeyDown);
		return () => {
			window.removeEventListener('keydown', handleKeyDown);
		};
	}, [hotkey, callback]);
}
