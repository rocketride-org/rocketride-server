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
 * Structured JSON Logger with OpenTelemetry trace context support.
 *
 * Writes JSON lines to stdout (info/debug) or stderr (warn/error).
 * Supports child loggers that inherit and extend context.
 */

import { scrubPii } from './pii';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export interface LoggerOptions {
	/** Minimum log level to emit. Defaults to 'info'. */
	level?: LogLevel;
	/** Enable PII scrubbing. Defaults to true. */
	scrubPii?: boolean;
	/** Custom output function for testing. Defaults to process.stdout/stderr.write. */
	output?: (json: string, level: LogLevel) => void;
}

function getOtelContext(): { trace_id: string; span_id: string; trace_flags: string } {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const api = require('@opentelemetry/api');
		const span = api.trace.getActiveSpan?.();
		if (span) {
			const ctx = span.spanContext();
			if (ctx && ctx.traceId && ctx.traceId !== '00000000000000000000000000000000') {
				return {
					trace_id: ctx.traceId,
					span_id: ctx.spanId,
					trace_flags: ctx.traceFlags?.toString(16).padStart(2, '0') ?? '',
				};
			}
		}
	} catch {
		// OTel not available — that's fine
	}
	return { trace_id: '', span_id: '', trace_flags: '' };
}

function defaultOutput(json: string, level: LogLevel): void {
	if (level === 'error' || level === 'warn') {
		process.stderr.write(json + '\n');
	} else {
		process.stdout.write(json + '\n');
	}
}

export class Logger {
	private _name: string;
	private _context: Record<string, unknown>;
	private _level: LogLevel;
	private _scrub: boolean;
	private _output: (json: string, level: LogLevel) => void;

	constructor(name: string, context: Record<string, unknown> = {}, options: LoggerOptions = {}) {
		this._name = name;
		this._context = { ...context };
		this._level = options.level ?? 'info';
		this._scrub = options.scrubPii ?? true;
		this._output = options.output ?? defaultOutput;
	}

	/**
	 * Create a child logger that inherits this logger's context
	 * and adds additional bound fields.
	 */
	child(context: Record<string, unknown>): Logger {
		const merged = { ...this._context, ...context };
		return new Logger(this._name, merged, {
			level: this._level,
			scrubPii: this._scrub,
			output: this._output,
		});
	}

	debug(event: string, data?: Record<string, unknown>): void {
		this._log('debug', event, data);
	}

	info(event: string, data?: Record<string, unknown>): void {
		this._log('info', event, data);
	}

	warn(event: string, data?: Record<string, unknown>): void {
		this._log('warn', event, data);
	}

	error(event: string, data?: Record<string, unknown>): void {
		this._log('error', event, data);
	}

	private _log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
		if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this._level]) {
			return;
		}

		const otel = getOtelContext();

		let record: Record<string, unknown> = {
			timestamp: new Date().toISOString(),
			level,
			logger: this._name,
			event,
			...otel,
			...this._context,
			...data,
		};

		if (this._scrub) {
			record = scrubPii(record);
		}

		this._output(JSON.stringify(record), level);
	}
}

/**
 * Create a new structured logger.
 *
 * @param name - Logger name (typically the module or service name)
 * @param options - Logger configuration
 */
export function createLogger(name: string, options?: LoggerOptions): Logger {
	return new Logger(name, {}, options);
}
