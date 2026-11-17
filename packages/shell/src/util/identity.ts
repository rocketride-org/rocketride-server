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
 * What app code and bridged iframes may see of the session.
 *
 * Apps mounted in the shell (the `identity` prop and `useAuthUser()`) and
 * iframes the shell bridges to (`shell:init`, `shell:login`) get the user
 * with a blank session token, and the iframe config without the API key
 * (#1022). This is preparation, not isolation: app code that runs on the
 * shell origin can still read the token from storage or ConnectionManager
 * until PR2 moves third-party apps off-origin. It stops handing the token
 * out through the documented app surface.
 */

/**
 * Return a shallow copy of the user whose `userToken` is blanked (`''`).
 *
 * The token is blanked rather than deleted because `userToken` is a required
 * string in the frozen shell-api contract (`ConnectResult`): the projection
 * keeps the published type honest while carrying no credential. A user
 * without the field is copied as is. The stored user is never mutated.
 * First-party shell code that needs the token reads it with
 * `ConnectionManager.loadToken()`.
 *
 * @param user - The authenticated user, or null when not logged in.
 * @returns A new object with every field kept and `userToken` blank, or null for null.
 */
export function withoutCredentials<T extends object>(user: T): T;
export function withoutCredentials<T extends object>(user: T | null): T | null;
export function withoutCredentials<T extends object>(user: T | null): T | null {
	if (!user) return null;
	const copy = { ...user };
	if ('userToken' in copy) (copy as { userToken?: unknown }).userToken = '';
	return copy;
}

/**
 * Return a copy of the RR_* runtime config without `RR_APIKEY`.
 *
 * No bridged iframe reads the API key (the iframe talks to the engine
 * through the shell), so it is not sent. The config is never mutated.
 *
 * @param config - The shell's runtime API config.
 * @returns A new object with every key except `RR_APIKEY`.
 */
export function bridgedApiConfig<T extends object>(config: T): Omit<T, 'RR_APIKEY'> {
	const { RR_APIKEY: _apiKey, ...rest } = config as T & { RR_APIKEY?: unknown };
	return rest;
}
