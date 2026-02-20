/**
 * MIT License
 * 
 * Copyright (c) 2026 RocketRide, Inc.
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

	constructor(dapResult: Record<string, unknown>) {
		const errorMessage = String(dapResult.message || 'Unknown DAP error');
		super(errorMessage);
		this.name = 'DAPException';
		this.dapResult = dapResult || {};
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
 * Exception raised when authentication fails (bad API key or credentials).
 */
export class AuthenticationException extends ConnectionException {
	constructor(dapResult: Record<string, unknown>) {
		super(dapResult);
		this.name = 'AuthenticationException';
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
