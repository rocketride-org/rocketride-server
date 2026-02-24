/**
 * MIT License
 *
 * Copyright (c) 2026 RocketRide, Inc.
 */

import { Logger, createLogger } from '../src/logger';

describe('Logger', () => {
	let lines: { json: string; level: string }[];
	const capture = (json: string, level: string) => {
		lines.push({ json, level });
	};

	beforeEach(() => {
		lines = [];
	});

	it('should output valid JSON with expected fields', () => {
		const logger = createLogger('myapp', { output: capture });
		logger.info('server started', { port: 8080 });

		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0].json);
		expect(record.event).toBe('server started');
		expect(record.level).toBe('info');
		expect(record.port).toBe(8080);
		expect(record.logger).toBe('myapp');
		expect(record.timestamp).toBeDefined();
	});

	it('should include trace context fields (empty when no OTel)', () => {
		const logger = createLogger('test', { output: capture });
		logger.info('no trace');

		const record = JSON.parse(lines[0].json);
		expect(record.trace_id).toBe('');
		expect(record.span_id).toBe('');
	});

	it('should respect log level filtering', () => {
		const logger = createLogger('test', { level: 'warn', output: capture });
		logger.debug('should not appear');
		logger.info('should not appear');
		logger.warn('should appear');
		logger.error('should appear');

		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0].json).level).toBe('warn');
		expect(JSON.parse(lines[1].json).level).toBe('error');
	});

	it('should route warn/error to stderr level', () => {
		const logger = createLogger('test', { output: capture });
		logger.info('info msg');
		logger.error('error msg');

		expect(lines[0].level).toBe('info');
		expect(lines[1].level).toBe('error');
	});

	it('should scrub PII by default', () => {
		const logger = createLogger('test', { output: capture });
		logger.info('login', { email: 'alice@example.com' });

		const record = JSON.parse(lines[0].json);
		expect(record.email).toBe('***@example.com');
		expect(record.email).not.toContain('alice');
	});

	it('should allow disabling PII scrubbing', () => {
		const logger = createLogger('test', { output: capture, scrubPii: false });
		logger.info('login', { email: 'alice@example.com' });

		const record = JSON.parse(lines[0].json);
		expect(record.email).toBe('alice@example.com');
	});
});

describe('Logger.child', () => {
	let lines: { json: string; level: string }[];
	const capture = (json: string, level: string) => {
		lines.push({ json, level });
	};

	beforeEach(() => {
		lines = [];
	});

	it('should inherit parent context', () => {
		const parent = new Logger('parent', { service: 'api' }, { output: capture });
		const child = parent.child({ requestId: 'req-123' });

		child.info('handling request');

		const record = JSON.parse(lines[0].json);
		expect(record.service).toBe('api');
		expect(record.requestId).toBe('req-123');
		expect(record.logger).toBe('parent');
	});

	it('should allow child to override parent context', () => {
		const parent = new Logger('parent', { env: 'prod' }, { output: capture });
		const child = parent.child({ env: 'staging' });

		child.info('overridden');

		const record = JSON.parse(lines[0].json);
		expect(record.env).toBe('staging');
	});

	it('should not affect parent when child adds context', () => {
		const parent = new Logger('parent', { base: true }, { output: capture });
		const child = parent.child({ extra: 'data' });

		parent.info('from parent');
		child.info('from child');

		const parentRecord = JSON.parse(lines[0].json);
		const childRecord = JSON.parse(lines[1].json);

		expect(parentRecord.extra).toBeUndefined();
		expect(childRecord.extra).toBe('data');
		expect(childRecord.base).toBe(true);
	});
});
