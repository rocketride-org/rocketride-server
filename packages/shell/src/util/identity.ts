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
 * The signed-in user as app code may see it.
 *
 * Apps mounted in the shell (the `identity` prop) and iframes the shell
 * bridges to (`shell:init`, `shell:login`) get the user without the session
 * token: `userToken` never leaves the shell (#1022). Every other field is
 * passed through unchanged.
 */

/**
 * Return a shallow copy of the user without `userToken`.
 *
 * The stored user object is never mutated.
 *
 * @param user - The authenticated user, or null when not logged in.
 * @returns A new object with every field except `userToken`, or null for null.
 */
export function withoutCredentials<T extends object>(user: T): Omit<T, 'userToken'>;
export function withoutCredentials<T extends object>(user: T | null): Omit<T, 'userToken'> | null;
export function withoutCredentials<T extends object>(user: T | null): Omit<T, 'userToken'> | null {
	if (!user) return null;
	const { userToken: _userToken, ...rest } = user as T & { userToken?: unknown };
	return rest;
}
