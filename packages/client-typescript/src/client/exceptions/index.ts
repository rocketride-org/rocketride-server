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
 * Base exception class for Debug Adapter Protocol (DAP) errors.
 * 
 * This exception wraps DAP error responses to provide structured access to
 * error information including file locations, line numbers, and other
 * contextual data returned by RocketRide servers.
 */
export class DAPException extends Error {
	public readonly dapResult: Record<string, unknown>;

	/**
	 * Machine-readable error code sent by the server, when the failure has one.
	 *
	 * Task failures carry one (`TASK_NOT_REGISTERED`, `TASK_AMBIGUOUS`,
	 * `TASK_COMPLETED`, `TASK_STOPPED`); classify on it rather than on the
	 * message text, which is written for people and may be reworded.
	 */
	public readonly code?: string;

	/**
	 * Troubleshooting text the SDK attached for a developer, when there is any.
	 *
	 * Kept out of `message` so an application can show the message to an end
	 * user without the developer checklist.
	 */
	public readonly hint?: string;

	constructor(dapResult: Record<string, unknown>) {
		const errorMessage = String(dapResult.message || 'Unknown DAP error');
		super(errorMessage);
		this.name = 'DAPException';
		this.dapResult = dapResult || {};

		// Optional so a frozen contract floor, whose ConnectionException predates
		// these fields, stays assignable where a callback takes one as a parameter.
		const code = this.dapResult.code;
		if (typeof code === 'string') this.code = code;
		const hint = this.dapResult.hint;
		if (typeof hint === 'string') this.hint = hint;
	}
}

/**
 * Base exception for all RocketRide operations.
 * 
 * This is the root exception class for all RocketRide-specific errors.
 * Catch this exception type to handle any error that originates from
 * RocketRide operations while still having access to detailed error context.
 */
export class RocketRideException extends DAPException {
	constructor(dapResult: Record<string, unknown>) {
		super(dapResult);
		this.name = 'RocketRideException';
	}
}

/**
 * Exception raised for connection-related issues.
 * 
 * Raised when there are problems connecting to RocketRide servers,
 * maintaining connections, or when connections are lost unexpectedly.
 */
export class ConnectionException extends RocketRideException {
	constructor(dapResult: Record<string, unknown>) {
		super(dapResult);
		this.name = 'ConnectionException';
	}
}

/**
 * The engine's answer when a client connects without sending a key.
 *
 * Server-authored: kept as a literal so both SDKs recognise the same words.
 */
export const NO_AUTHORIZATION_MESSAGE = 'No authorization provided';

/**
 * Advice for {@link NO_AUTHORIZATION_MESSAGE}.
 *
 * The server text names what went wrong; this says what to do about it, and is
 * attached as the exception's `hint` rather than folded into `message`, which
 * stays server-authored so both SDKs report the same words (#3187).
 */
export const NO_AUTHORIZATION_HINT =
	'No API key was sent. Set ROCKETRIDE_APIKEY or pass `auth` when connecting: a local ' +
	'engine accepts any non-empty value unless ROCKETRIDE_APIKEY is set on the engine, and ' +
	'RocketRide Cloud needs a key from `rocketride login`.';

/**
 * Attach the missing-API-key advice to a failed auth response.
 *
 * Returns a copy of `response` with `hint` set to {@link NO_AUTHORIZATION_HINT},
 * but only when the server answered exactly {@link NO_AUTHORIZATION_MESSAGE} and
 * did not already send a hint of its own - a server hint is never overwritten,
 * and the `message` is never touched, so both SDKs report the same words (#3187).
 */
export function withNoAuthorizationHint(response: Record<string, unknown>): Record<string, unknown> {
	if (response.message === NO_AUTHORIZATION_MESSAGE && typeof response.hint !== 'string') {
		return { ...response, hint: NO_AUTHORIZATION_HINT };
	}
	return response;
}

/**
 * Exception raised when authentication fails (bad API key or credentials).
 */
export class AuthenticationException extends ConnectionException {
	constructor(dapResult: Record<string, unknown>) {
		super(dapResult);
		this.name = 'AuthenticationException';
	}
}

/**
 * Terminal reason for a public login or connect attempt cancelled by later
 * user intent: replacement credentials (`superseded`), `logout`, or `detach`
 * (`detached`).
 */
export type LoginAttemptCancellationReason = 'superseded' | 'logout' | 'detached';

/**
 * Raised when a public `login()` or `connect()` attempt is cancelled by newer
 * user intent. Callers may inspect `reason` to distinguish replacement,
 * logout, and detachment from transport or server failures.
 *
 * This deliberately extends Error directly: cancellation is control flow, not a
 * RocketRide server or protocol failure.
 */
export class LoginAttemptCancelledError extends Error {
	public readonly reason: LoginAttemptCancellationReason;

	constructor(reason: LoginAttemptCancellationReason) {
		super(reason);
		this.name = 'LoginAttemptCancelledError';
		this.reason = reason;
	}
}

/**
 * Exception raised for data pipe operations.
 * 
 * Raised when there are problems with data pipes used for sending
 * data to pipelines, uploading files, or streaming operations.
 */
export class PipeException extends RocketRideException {
	constructor(dapResult: Record<string, unknown>) {
		super(dapResult);
		this.name = 'PipeException';
	}
}

/**
 * Exception raised for pipeline execution issues.
 * 
 * Raised when there are problems starting, running, or managing
 * RocketRide pipelines and processing tasks.
 */
export class ExecutionException extends RocketRideException {
	constructor(dapResult: Record<string, unknown>) {
		super(dapResult);
		this.name = 'ExecutionException';
	}
}

/**
 * Exception raised for input validation failures.
 * 
 * Raised when input data, configurations, or parameters don't meet
 * the requirements for RocketRide operations.
 */
export class ValidationException extends RocketRideException {
	constructor(dapResult: Record<string, unknown>) {
		super(dapResult);
		this.name = 'ValidationException';
	}
}
