import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
type AnyFn = (...args: any[]) => any;

// ── Mock ALL dependencies at module level ────────────────────────────
jest.mock('../src/client/runtime/downloader.js');
jest.mock('../src/client/runtime/process.js');
jest.mock('../src/client/runtime/ports.js');
jest.mock('../src/client/runtime/paths.js');
jest.mock('../src/client/runtime/resolver.js');
jest.mock('../src/client/runtime/state.js');
jest.mock('fs');
jest.mock('better-sqlite3');

import { RuntimeManager } from '../src/client/runtime/manager.js';
import { StateDB, InstanceRecord } from '../src/client/runtime/state.js';
import { downloadRuntime } from '../src/client/runtime/downloader.js';
import { spawnRuntime, stopRuntime, waitReady } from '../src/client/runtime/process.js';
import { findAvailablePort } from '../src/client/runtime/ports.js';
import { runtimeBinary, rocketrideHome, logsDir } from '../src/client/runtime/paths.js';
import { getCompatRange, resolveCompatibleVersion } from '../src/client/runtime/resolver.js';
import { existsSync, readdirSync, statSync } from 'fs';

// ── Typed mock accessors ─────────────────────────────────────────────
const mockedStateDB = jest.mocked(StateDB);
const mockedDownloadRuntime = jest.mocked(downloadRuntime);
const mockedSpawnRuntime = jest.mocked(spawnRuntime);
const mockedStopRuntime = jest.mocked(stopRuntime);
const mockedWaitReady = jest.mocked(waitReady);
const mockedFindAvailablePort = jest.mocked(findAvailablePort);
const mockedRuntimeBinary = jest.mocked(runtimeBinary);
const mockedRocketrideHome = jest.mocked(rocketrideHome);
const mockedLogsDir = jest.mocked(logsDir);
const mockedGetCompatRange = jest.mocked(getCompatRange);
const mockedResolveCompatibleVersion = jest.mocked(resolveCompatibleVersion);
const mockedExistsSync = jest.mocked(existsSync);
const mockedReaddirSync = jest.mocked(readdirSync);
const mockedStatSync = jest.mocked(statSync);

// ── Global fetch mock ────────────────────────────────────────────────
const originalFetch = globalThis.fetch;

// ── Helpers ──────────────────────────────────────────────────────────

function makeInstance(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
	return {
		id: '0',
		pid: 0,
		port: 0,
		version: '3.1.0',
		started_at: '2026-01-01T00:00:00.000Z',
		owner: 'sdk',
		restart_count: 0,
		desired_state: 'stopped',
		type: 'Local',
		deleted: 0,
		...overrides,
	};
}

describe('RuntimeManager', () => {
	let manager: RuntimeManager;
	let mockDb: {
		open: jest.Mock;
		close: jest.Mock;
		get: jest.Mock;
		getAll: jest.Mock;
		register: jest.Mock;
		nextId: jest.Mock;
		findByVersion: jest.Mock;
		findByVersionAndType: jest.Mock;
		findRunning: jest.Mock;
		softDelete: jest.Mock;
		unregister: jest.Mock;
		markStopped: jest.Mock;
		setDesiredState: jest.Mock;
		findByType: jest.Mock;
		findDesiredRunning: jest.Mock;
	};

	beforeEach(() => {
		jest.clearAllMocks();

		manager = new RuntimeManager();

		mockDb = {
			open: jest.fn(),
			close: jest.fn(),
			get: jest.fn().mockReturnValue(null),
			getAll: jest.fn().mockReturnValue([]),
			register: jest.fn(),
			nextId: jest.fn().mockReturnValue('0'),
			findByVersion: jest.fn().mockReturnValue(null),
			findByVersionAndType: jest.fn().mockReturnValue(null),
			findRunning: jest.fn().mockReturnValue(null),
			softDelete: jest.fn(),
			unregister: jest.fn(),
			markStopped: jest.fn(),
			setDesiredState: jest.fn(),
			findByType: jest.fn().mockReturnValue([]),
			findDesiredRunning: jest.fn().mockReturnValue([]),
		};
		mockedStateDB.mockImplementation(() => mockDb as any);

		// Default mock implementations
		mockedGetCompatRange.mockReturnValue('>=3.0.0 <4.0.0');
		mockedResolveCompatibleVersion.mockResolvedValue('3.1.0');
		mockedRuntimeBinary.mockImplementation((v: string) => `/home/user/.rocketride/runtimes/${v}/engine`);
		mockedRocketrideHome.mockReturnValue('/home/user/.rocketride');
		mockedLogsDir.mockImplementation((id: string) => `/home/user/.rocketride/logs/${id}`);
		mockedFindAvailablePort.mockResolvedValue(5565);
		mockedSpawnRuntime.mockReturnValue(12345);
		mockedStopRuntime.mockResolvedValue(undefined);
		mockedWaitReady.mockResolvedValue(undefined);
		mockedDownloadRuntime.mockResolvedValue('/home/user/.rocketride/runtimes/3.1.0/engine');
		mockedExistsSync.mockReturnValue(false);

		// Mock fetch for health checks — default to unhealthy
		(globalThis as any).fetch = jest.fn<AnyFn>().mockRejectedValue(new Error('connection refused'));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	// ── ensureRunning with instanceId ────────────────────────────────

	describe('ensureRunning with instanceId', () => {
		it('reuses running instance when healthy', async () => {
			const inst = makeInstance({ id: '5', pid: 9999, port: 5565, version: '3.1.0' });
			mockDb.get.mockReturnValue(inst);

			// Mock healthy response
			(globalThis as any).fetch = jest.fn<AnyFn>().mockResolvedValue({ ok: true });

			const [uri, weStarted] = await manager.ensureRunning({ instanceId: '5' });

			expect(uri).toBe('http://127.0.0.1:5565');
			expect(weStarted).toBe(false);
			expect(mockedSpawnRuntime).not.toHaveBeenCalled();
		});

		it('starts stopped instance', async () => {
			const inst = makeInstance({ id: '5', pid: 0, port: 0, version: '3.1.0' });
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockReturnValue(true);

			const [uri, weStarted] = await manager.ensureRunning({ instanceId: '5' });

			expect(uri).toBe('http://127.0.0.1:5565');
			expect(weStarted).toBe(true);
			expect(mockedSpawnRuntime).toHaveBeenCalled();
			expect(mockedWaitReady).toHaveBeenCalled();
			expect(mockDb.register).toHaveBeenCalledWith('5', 12345, 5565, '3.1.0', 'sdk');
		});

		it('throws if instance not found', async () => {
			mockDb.get.mockReturnValue(null);

			await expect(manager.ensureRunning({ instanceId: '999' })).rejects.toThrow(/not found/);
		});

		it('rolls back on waitReady failure', async () => {
			const inst = makeInstance({ id: '5', pid: 0, port: 0, version: '3.1.0' });
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockReturnValue(true);
			mockedWaitReady.mockRejectedValue(new Error('not ready'));

			await expect(manager.ensureRunning({ instanceId: '5' })).rejects.toThrow('not ready');

			expect(mockedStopRuntime).toHaveBeenCalledWith(12345);
			expect(mockDb.register).toHaveBeenCalledWith('5', 0, 0, '3.1.0', 'sdk', 0, 'stopped');
		});

		it('throws when binary not found for instance', async () => {
			const inst = makeInstance({ id: '5', pid: 0, port: 0, version: '3.1.0' });
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockReturnValue(false);

			await expect(manager.ensureRunning({ instanceId: '5' })).rejects.toThrow(/binary not found/);
		});
	});

	// ── ensureRunning with port ──────────────────────────────────────

	describe('ensureRunning with port', () => {
		it('reuses healthy instance on specified port', async () => {
			(globalThis as any).fetch = jest.fn<AnyFn>().mockResolvedValue({ ok: true });
			mockDb.getAll.mockReturnValue([makeInstance({ id: '1', port: 7777 })]);

			const [uri, weStarted] = await manager.ensureRunning({ port: 7777 });

			expect(uri).toBe('http://127.0.0.1:7777');
			expect(weStarted).toBe(false);
			expect(mockedSpawnRuntime).not.toHaveBeenCalled();
		});

		it('throws if port is not healthy', async () => {
			// fetch rejects by default (connection refused)
			await expect(manager.ensureRunning({ port: 7777 })).rejects.toThrow(/No healthy runtime found on port 7777/);
		});
	});

	// ── ensureRunning auto-discovery ─────────────────────────────────

	describe('ensureRunning auto-discovery', () => {
		it('reuses existing running instance', async () => {
			const running = makeInstance({ id: '0', pid: 1234, port: 5565, version: '3.1.0' });
			mockDb.findRunning.mockReturnValue(running);
			(globalThis as any).fetch = jest.fn<AnyFn>().mockResolvedValue({ ok: true });

			const [resultUri, weStarted] = await manager.ensureRunning();

			expect(resultUri).toBe('http://127.0.0.1:5565');
			expect(weStarted).toBe(false);
			expect(mockedSpawnRuntime).not.toHaveBeenCalled();
		});

		it('spawns when nothing running and binary available', async () => {
			mockDb.findRunning.mockReturnValue(null);
			// resolveBinary: runtimesRoot exists with a valid version dir
			mockedExistsSync.mockImplementation((p: any) => {
				const path = String(p);
				if (path.endsWith('runtimes')) return true;
				if (path.includes('engine')) return true;
				return false;
			});
			mockedReaddirSync.mockReturnValue(['3.1.0'] as any);
			mockedStatSync.mockReturnValue({ isDirectory: () => true } as any);
			mockDb.findByVersion.mockReturnValue(makeInstance({ id: '0', version: '3.1.0' }));

			const [, weStarted] = await manager.ensureRunning();

			expect(weStarted).toBe(true);
			expect(mockedSpawnRuntime).toHaveBeenCalled();
			expect(mockedWaitReady).toHaveBeenCalled();
		});

		it('downloads binary if none installed', async () => {
			mockDb.findRunning.mockReturnValue(null);
			// runtimesRoot does not exist
			mockedExistsSync.mockReturnValue(false);
			mockDb.nextId.mockReturnValue('0');

			const [, weStarted] = await manager.ensureRunning();

			expect(weStarted).toBe(true);
			expect(mockedResolveCompatibleVersion).toHaveBeenCalled();
			expect(mockedDownloadRuntime).toHaveBeenCalled();
			expect(mockedSpawnRuntime).toHaveBeenCalled();
		});
	});

	// ── teardown ─────────────────────────────────────────────────────

	describe('teardown', () => {
		it('stops process and marks stopped', async () => {
			// First, make the manager think it started something
			const inst = makeInstance({ id: '5', pid: 0, port: 0, version: '3.1.0' });
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockReturnValue(true);

			await manager.ensureRunning({ instanceId: '5' });

			// Now teardown
			await manager.teardown();

			expect(mockedStopRuntime).toHaveBeenCalledWith(12345);
			expect(mockDb.markStopped).toHaveBeenCalledWith('5');
		});

		it('is noop if we did not start', async () => {
			// Fresh manager — weStarted is false
			await manager.teardown();

			expect(mockedStopRuntime).not.toHaveBeenCalled();
			// No StateDB should be opened for teardown
		});

		it('resets internal state after teardown', async () => {
			const inst = makeInstance({ id: '5', pid: 0, port: 0, version: '3.1.0' });
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockReturnValue(true);

			await manager.ensureRunning({ instanceId: '5' });
			expect(manager.weStarted).toBe(true);
			expect(manager.uri).toBe('http://127.0.0.1:5565');

			await manager.teardown();

			expect(manager.weStarted).toBe(false);
			expect(manager.uri).toBeNull();
		});
	});
});
