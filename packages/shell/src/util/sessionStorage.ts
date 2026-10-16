// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * sessionStorage access can synchronously throw when browser privacy policy,
 * iframe restrictions, or storage quotas block it. Keep those failures from
 * aborting application bootstrap; callers can treat an unavailable store like
 * an empty one.
 */
export function getSessionStorageItem(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

/**
 * Best-effort sessionStorage write.
 *
 * @returns true when the value was stored, false when storage is unavailable.
 */
export function setSessionStorageItem(key: string, value: string): boolean {
	try {
		sessionStorage.setItem(key, value);
		return true;
	} catch {
		return false;
	}
}

/** Best-effort sessionStorage removal. */
export function removeSessionStorageItem(key: string): void {
	try {
		sessionStorage.removeItem(key);
	} catch {
		// Storage is unavailable; there is nothing else the caller can clear.
	}
}
