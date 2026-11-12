/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * The "No authorization provided" error says what to do next (#3187).
 *
 * The message is the engine's and stays byte-identical; the advice travels
 * separately in the exception's `hint`, which the CLI prints and an app can
 * show to a developer without exposing it to end users.
 */

import {
	AuthenticationException,
	NO_AUTHORIZATION_HINT,
	NO_AUTHORIZATION_MESSAGE,
	withNoAuthorizationHint,
} from '../src/client/exceptions';

describe('withNoAuthorizationHint', () => {
	it('attaches actionable advice for the engine\'s answer', () => {
		const response = withNoAuthorizationHint({ message: NO_AUTHORIZATION_MESSAGE });

		expect(response.message).toBe(NO_AUTHORIZATION_MESSAGE);
		expect(response.hint).toBe(NO_AUTHORIZATION_HINT);
	});

	it('leaves other auth failures alone', () => {
		const response = withNoAuthorizationHint({ message: 'Authentication failed' });

		expect(response.hint).toBeUndefined();
	});

	it('never overwrites a server-sent hint', () => {
		const response = withNoAuthorizationHint({ message: NO_AUTHORIZATION_MESSAGE, hint: 'server advice' });

		expect(response.hint).toBe('server advice');
	});

	it('does not mutate the response packet the engine sent', () => {
		const original = { message: NO_AUTHORIZATION_MESSAGE };

		withNoAuthorizationHint(original);

		expect('hint' in original).toBe(false);
	});
});

describe('AuthenticationException carrying the hint', () => {
	it('keeps the server message and exposes the advice as hint', () => {
		const exception = new AuthenticationException(withNoAuthorizationHint({ message: NO_AUTHORIZATION_MESSAGE }));

		expect(exception.message).toBe(NO_AUTHORIZATION_MESSAGE);
		expect(exception.hint).toBe(NO_AUTHORIZATION_HINT);
		expect(exception.hint).toContain('ROCKETRIDE_APIKEY');
		expect(exception.hint).toContain('`auth`');
		expect(exception.hint).toContain('rocketride login');
	});

	it('other auth failures carry no hint', () => {
		const exception = new AuthenticationException(withNoAuthorizationHint({ message: 'Authentication failed' }));

		expect(exception.hint).toBeUndefined();
	});
});
