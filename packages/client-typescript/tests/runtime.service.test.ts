import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// ── Mock ALL dependencies at module level ────────────────────────────
jest.mock('../src/client/runtime/downloader.js');
jest.mock('../src/client/runtime/process.js');
jest.mock('../src/client/runtime/ports.js');
jest.mock('../src/client/runtime/paths.js');
jest.mock('../src/client/runtime/resolver.js');
jest.mock('../src/client/runtime/platform.js');
jest.mock('../src/client/runtime/state.js');
jest.mock('../src/client/runtime/docker.js');
jest.mock('fs');

import { RuntimeService } from '../src/client/runtime/service.js';
import { StateDB, isPidAlive, isRuntimeProcess, InstanceRecord } from '../src/client/runtime/state.js';
import { downloadRuntime } from '../src/client/runtime/downloader.js';
import { spawnRuntime, stopRuntime, waitReady } from '../src/client/runtime/process.js';
import { findAvailablePort } from '../src/client/runtime/ports.js';
import { runtimeBinary, runtimesDir, logsDir } from '../src/client/runtime/paths.js';
import { getCompatRange, resolveCompatibleVersion, resolveDockerTag, listCompatibleVersions } from '../src/client/runtime/resolver.js';
import { normalizeVersion } from '../src/client/runtime/platform.js';
import { DockerRuntime } from '../src/client/runtime/docker.js';
import { RuntimeManagementError, RuntimeNotFoundError } from '../src/client/exceptions/index.js';
import { existsSync, rmSync } from 'fs';

// ── Typed mock accessors ─────────────────────────────────────────────
const mockedStateDB = jest.mocked(StateDB);
const mockedExistsSync = jest.mocked(existsSync);
const mockedRmSync = jest.mocked(rmSync);
const mockedDownloadRuntime = jest.mocked(downloadRuntime);
const mockedSpawnRuntime = jest.mocked(spawnRuntime);
const mockedStopRuntime = jest.mocked(stopRuntime);
const mockedWaitReady = jest.mocked(waitReady);
const mockedFindAvailablePort = jest.mocked(findAvailablePort);
const mockedRuntimeBinary = jest.mocked(runtimeBinary);
const mockedRuntimesDir = jest.mocked(runtimesDir);
const mockedLogsDir = jest.mocked(logsDir);
const mockedGetCompatRange = jest.mocked(getCompatRange);
const mockedResolveCompatibleVersion = jest.mocked(resolveCompatibleVersion);
const mockedResolveDockerTag = jest.mocked(resolveDockerTag);
const mockedListCompatibleVersions = jest.mocked(listCompatibleVersions);
const mockedNormalizeVersion = jest.mocked(normalizeVersion);
const mockedIsPidAlive = jest.mocked(isPidAlive);
const mockedIsRuntimeProcess = jest.mocked(isRuntimeProcess);
const mockedDockerRuntime = jest.mocked(DockerRuntime);

// ── Helpers ──────────────────────────────────────────────────────────

function makeInstance(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
	return {
		id: '0',
		pid: 0,
		port: 0,
		version: '3.1.0',
		started_at: '2026-01-01T00:00:00.000Z',
		owner: 'cli',
		restart_count: 0,
		desired_state: 'stopped',
		type: 'Service',
		deleted: 0,
		...overrides,
	};
}

describe('RuntimeService', () => {
	let service: RuntimeService;
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

		service = new RuntimeService();

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
		mockedNormalizeVersion.mockImplementation((v: string) => v.replace(/^v/, ''));
		mockedGetCompatRange.mockReturnValue('>=3.0.0 <4.0.0');
		mockedResolveCompatibleVersion.mockResolvedValue('3.1.0');
		mockedResolveDockerTag.mockResolvedValue('3.1.0');
		mockedRuntimeBinary.mockImplementation((v: string) => `/home/user/.rocketride/runtimes/${v}/engine`);
		mockedRuntimesDir.mockImplementation((v: string) => `/home/user/.rocketride/runtimes/${v}`);
		mockedLogsDir.mockImplementation((id: string) => `/home/user/.rocketride/logs/${id}`);
		mockedFindAvailablePort.mockResolvedValue(5565);
		mockedSpawnRuntime.mockReturnValue(12345);
		mockedStopRuntime.mockResolvedValue(undefined);
		mockedWaitReady.mockResolvedValue(undefined);
		mockedDownloadRuntime.mockResolvedValue('/home/user/.rocketride/runtimes/3.1.0/engine');
		mockedExistsSync.mockReturnValue(false);
		mockedIsPidAlive.mockReturnValue(false);
		mockedIsRuntimeProcess.mockReturnValue(false);
	});

	// ── install ──────────────────────────────────────────────────────

	describe('install', () => {
		it('installs latest when no version specified', async () => {
			mockDb.get.mockReturnValue(makeInstance({ id: '0', version: '3.1.0', desired_state: 'running' }));
			await service.install();

			expect(mockedResolveCompatibleVersion).toHaveBeenCalledWith('>=3.0.0 <4.0.0');
		});

		it('downloads binary when not present', async () => {
			mockedExistsSync.mockReturnValue(false);
			mockDb.get.mockReturnValue(makeInstance({ id: '0', version: '3.1.0', desired_state: 'running' }));

			await service.install({ version: '3.1.0', type: 'Local' });

			expect(mockedDownloadRuntime).toHaveBeenCalledWith('3.1.0', expect.anything());
		});

		it('skips download when binary already exists', async () => {
			mockedExistsSync.mockReturnValue(true);
			mockDb.findByVersionAndType.mockReturnValue(null);
			mockDb.get.mockReturnValue(makeInstance({ id: '0', version: '3.1.0', type: 'Local' }));

			await service.install({ version: '3.1.0', type: 'Local' });

			expect(mockedDownloadRuntime).not.toHaveBeenCalled();
		});

		it('returns existing instance when not allowDuplicate and already installed', async () => {
			const existing = makeInstance({ id: '5', version: '3.1.0', type: 'Service' });
			mockedExistsSync.mockReturnValue(true);
			mockDb.findByVersionAndType.mockReturnValue(existing);

			const result = await service.install({ version: '3.1.0', type: 'Service', allowDuplicate: false });

			expect(result).toBe(existing);
			expect(mockDb.register).not.toHaveBeenCalled();
		});

		it('creates new ID when allowDuplicate is true', async () => {
			const existing = makeInstance({ id: '5', version: '3.1.0', type: 'Local' });
			mockedExistsSync.mockImplementation((p: any) => {
				// Binary exists so download is skipped
				if (typeof p === 'string' && p.includes('engine')) return true;
				return false;
			});
			mockDb.findByVersionAndType.mockReturnValue(existing);
			mockDb.nextId.mockReturnValue('6');
			mockDb.get.mockReturnValue(makeInstance({ id: '6', version: '3.1.0', type: 'Local' }));

			await service.install({ version: '3.1.0', type: 'Local', allowDuplicate: true });

			expect(mockDb.nextId).toHaveBeenCalled();
			expect(mockDb.register).toHaveBeenCalledWith('6', 0, 0, '3.1.0', 'cli', 0, 'stopped', 'Local');
		});

		it('Service type auto-starts after install', async () => {
			mockedExistsSync.mockReturnValue(false);
			mockDb.get.mockReturnValue(makeInstance({ id: '0', version: '3.1.0', desired_state: 'running', pid: 12345, port: 5565 }));

			await service.install({ version: '3.1.0', type: 'Service' });

			expect(mockedSpawnRuntime).toHaveBeenCalled();
			expect(mockedWaitReady).toHaveBeenCalled();
		});

		it('Local type does not auto-start', async () => {
			mockedExistsSync.mockReturnValue(false);
			mockDb.get.mockReturnValue(makeInstance({ id: '0', version: '3.1.0', type: 'Local' }));

			await service.install({ version: '3.1.0', type: 'Local' });

			expect(mockedSpawnRuntime).not.toHaveBeenCalled();
		});

		it('auto-start failure rolls back to stopped', async () => {
			mockedExistsSync.mockReturnValue(false);
			mockedWaitReady.mockRejectedValue(new Error('health check timeout'));

			await expect(service.install({ version: '3.1.0', type: 'Service' })).rejects.toThrow(RuntimeManagementError);

			expect(mockedStopRuntime).toHaveBeenCalledWith(12345);
			// Verify the rollback registration with 'stopped' state
			expect(mockDb.register).toHaveBeenCalledWith('0', 0, 0, '3.1.0', 'cli', 0, 'stopped', 'Service');
		});

		it('rejects incompatible version', async () => {
			mockedNormalizeVersion.mockReturnValue('2.0.0');
			mockedGetCompatRange.mockReturnValue('>=3.0.0 <4.0.0');

			await expect(service.install({ version: '2.0.0' })).rejects.toThrow(RuntimeManagementError);
			await expect(service.install({ version: '2.0.0' })).rejects.toThrow(/not compatible/);
		});

		it('force=true skips compat check', async () => {
			mockedNormalizeVersion.mockReturnValue('2.0.0');
			mockedGetCompatRange.mockReturnValue('>=3.0.0 <4.0.0');
			mockedExistsSync.mockReturnValue(false);
			mockDb.get.mockReturnValue(makeInstance({ id: '0', version: '2.0.0', type: 'Local' }));
			mockedRuntimeBinary.mockReturnValue('/home/user/.rocketride/runtimes/2.0.0/engine');

			await service.install({ version: '2.0.0', type: 'Local', force: true });

			expect(mockedDownloadRuntime).toHaveBeenCalled();
		});

		it('"latest" keyword resolves via resolveDockerTag', async () => {
			mockedNormalizeVersion.mockReturnValue('latest');
			mockedResolveDockerTag.mockResolvedValue('3.2.0');
			mockedExistsSync.mockReturnValue(false);
			mockDb.get.mockReturnValue(makeInstance({ id: '0', version: '3.2.0', type: 'Local' }));

			await service.install({ version: 'latest', type: 'Local' });

			expect(mockedResolveDockerTag).toHaveBeenCalledWith('latest');
		});

		it('fires onProgress callback', async () => {
			mockedExistsSync.mockReturnValue(false);
			mockDb.get.mockReturnValue(makeInstance({ id: '0', version: '3.1.0', type: 'Local' }));

			const progress = jest.fn();
			await service.install({ version: '3.1.0', type: 'Local', onProgress: progress });

			expect(progress).toHaveBeenCalled();
			// Should fire at least the "Installed runtime..." message
			expect(progress).toHaveBeenCalledWith(expect.stringContaining('Installed runtime'));
		});

		it('uses explicit port for Service type', async () => {
			mockedExistsSync.mockReturnValue(false);
			mockDb.get.mockReturnValue(makeInstance({ id: '0', version: '3.1.0', pid: 12345, port: 9999 }));

			await service.install({ version: '3.1.0', type: 'Service', port: 9999 });

			expect(mockedSpawnRuntime).toHaveBeenCalledWith(expect.any(String), 9999, '0');
			expect(mockedFindAvailablePort).not.toHaveBeenCalled();
		});
	});

	// ── start ────────────────────────────────────────────────────────

	describe('start', () => {
		it('starts stopped instance by ID', async () => {
			const inst = makeInstance({ id: '2', version: '3.1.0', pid: 0, port: 0, type: 'Local' });
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockImplementation((p: any) => {
				if (typeof p === 'string' && p.includes('engine')) return true;
				return false;
			});

			// After start, return the updated instance
			const started = makeInstance({ id: '2', version: '3.1.0', pid: 12345, port: 5565, desired_state: 'running' });
			// The second StateDB call (db2) will use the same mock
			// Override get to return started instance on subsequent calls
			let getCalls = 0;
			mockDb.get.mockImplementation((_id: unknown) => {
				getCalls++;
				if (getCalls <= 1) return inst;
				return started;
			});

			await service.start('2');

			expect(mockedSpawnRuntime).toHaveBeenCalled();
			expect(mockedWaitReady).toHaveBeenCalled();
		});

		it('finds instance by version', async () => {
			const inst = makeInstance({ id: '3', version: '3.1.0', pid: 0, type: 'Local' });
			mockDb.findByVersion.mockReturnValue(inst);
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockReturnValue(true);

			const started = makeInstance({ id: '3', version: '3.1.0', pid: 12345, port: 5565, desired_state: 'running' });
			let getCalls = 0;
			mockDb.get.mockImplementation(() => {
				getCalls++;
				if (getCalls <= 1) return inst;
				return started;
			});

			await service.start(null, { version: '3.1.0' });

			expect(mockDb.findByVersion).toHaveBeenCalledWith('3.1.0');
		});

		it('uses first instance when no ID or version', async () => {
			const inst = makeInstance({ id: '0', version: '3.1.0', pid: 0, type: 'Local' });
			mockDb.getAll.mockReturnValue([inst]);
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockReturnValue(true);

			const started = makeInstance({ id: '0', version: '3.1.0', pid: 12345, port: 5565, desired_state: 'running' });
			let getCalls = 0;
			mockDb.get.mockImplementation(() => {
				getCalls++;
				if (getCalls <= 1) return inst;
				return started;
			});

			await service.start();

			expect(mockDb.getAll).toHaveBeenCalled();
		});

		it('throws RuntimeNotFoundError when no instances', async () => {
			mockDb.getAll.mockReturnValue([]);

			await expect(service.start()).rejects.toThrow(RuntimeNotFoundError);
			await expect(service.start()).rejects.toThrow(/No runtime instances found/);
		});

		it('throws RuntimeManagementError if already running', async () => {
			const inst = makeInstance({ id: '1', version: '3.1.0', pid: 9999, port: 5565, desired_state: 'running' });
			mockDb.get.mockReturnValue(inst);
			mockedIsPidAlive.mockReturnValue(true);

			await expect(service.start('1')).rejects.toThrow(RuntimeManagementError);
			await expect(service.start('1')).rejects.toThrow(/already running/);
		});

		it('health check failure kills process and rolls back', async () => {
			const inst = makeInstance({ id: '1', version: '3.1.0', pid: 0, port: 0, type: 'Local' });
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockReturnValue(true);
			mockedWaitReady.mockRejectedValue(new Error('not ready'));

			await expect(service.start('1')).rejects.toThrow(RuntimeManagementError);
			await expect(service.start('1')).rejects.toThrow(/health check failed/);

			expect(mockedStopRuntime).toHaveBeenCalledWith(12345);
		});

		it('binary not found throws RuntimeNotFoundError', async () => {
			const inst = makeInstance({ id: '1', version: '3.1.0', pid: 0, port: 0, type: 'Local' });
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockReturnValue(false);

			await expect(service.start('1')).rejects.toThrow(RuntimeNotFoundError);
			await expect(service.start('1')).rejects.toThrow(/binary not found/);
		});

		it('tracks restart count', async () => {
			const inst = makeInstance({ id: '1', version: '3.1.0', pid: 0, port: 0, type: 'Local', restart_count: 3 });
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockReturnValue(true);

			const started = makeInstance({ id: '1', version: '3.1.0', pid: 12345, port: 5565, restart_count: 4 });
			let getCalls = 0;
			mockDb.get.mockImplementation(() => {
				getCalls++;
				if (getCalls <= 1) return inst;
				return started;
			});

			await service.start('1');

			// Register should be called with incremented restart count (3 + 1 = 4)
			expect(mockDb.register).toHaveBeenCalledWith('1', 12345, expect.any(Number), '3.1.0', 'cli', 4, 'running');
		});

		it('uses explicit port when provided', async () => {
			const inst = makeInstance({ id: '1', version: '3.1.0', pid: 0, port: 0, type: 'Local' });
			mockDb.get.mockReturnValue(inst);
			mockedExistsSync.mockReturnValue(true);

			const started = makeInstance({ id: '1', version: '3.1.0', pid: 12345, port: 7777 });
			let getCalls = 0;
			mockDb.get.mockImplementation(() => {
				getCalls++;
				if (getCalls <= 1) return inst;
				return started;
			});

			await service.start('1', { port: 7777 });

			expect(mockedSpawnRuntime).toHaveBeenCalledWith(expect.any(String), 7777, '1');
			expect(mockedFindAvailablePort).not.toHaveBeenCalled();
		});

		it('throws when instance ID not found', async () => {
			mockDb.get.mockReturnValue(null);

			await expect(service.start('999')).rejects.toThrow(RuntimeNotFoundError);
			await expect(service.start('999')).rejects.toThrow(/No instance found with id: 999/);
		});
	});

	// ── stop ─────────────────────────────────────────────────────────

	describe('stop', () => {
		it('stops running instance', async () => {
			const inst = makeInstance({ id: '1', pid: 12345, port: 5565, version: '3.1.0', type: 'Service', desired_state: 'running' });
			mockDb.get.mockReturnValue(inst);

			await service.stop('1');

			expect(mockedStopRuntime).toHaveBeenCalledWith(12345);
			expect(mockDb.register).toHaveBeenCalledWith('1', 0, 0, '3.1.0', 'cli', 0, 'stopped', 'Service');
		});

		it('throws for missing ID', async () => {
			mockDb.get.mockReturnValue(null);

			await expect(service.stop('999')).rejects.toThrow(RuntimeNotFoundError);
		});

		it('stops Docker instance via DockerRuntime', async () => {
			const inst = makeInstance({ id: '1', pid: 0, port: 5565, version: '3.1.0', type: 'Docker', desired_state: 'running' });
			mockDb.get.mockReturnValue(inst);

			const mockDockerInstance = { stop: jest.fn(), start: jest.fn(), remove: jest.fn(), getStatus: jest.fn(), install: jest.fn(), checkDockerStatus: jest.fn(), isDockerAvailable: jest.fn() };
			mockedDockerRuntime.mockImplementation(() => mockDockerInstance as any);

			await service.stop('1');

			expect(mockDockerInstance.stop).toHaveBeenCalledWith('1');
			expect(mockDb.register).toHaveBeenCalledWith('1', 0, 5565, '3.1.0', 'cli', 0, 'stopped', 'Docker');
		});
	});

	// ── delete ───────────────────────────────────────────────────────

	describe('delete', () => {
		it('soft-delete by default', async () => {
			const inst = makeInstance({ id: '1', pid: 0, port: 0, version: '3.1.0', type: 'Local' });
			mockDb.get.mockReturnValue(inst);

			await service.delete('1');

			expect(mockDb.softDelete).toHaveBeenCalledWith('1');
			expect(mockDb.unregister).not.toHaveBeenCalled();
		});

		it('already-deleted is noop', async () => {
			const inst = makeInstance({ id: '1', pid: 0, port: 0, version: '3.1.0', type: 'Local', deleted: 1 });
			mockDb.get.mockReturnValue(inst);

			await service.delete('1');

			expect(mockDb.softDelete).not.toHaveBeenCalled();
			expect(mockDb.unregister).not.toHaveBeenCalled();
		});

		it('purge removes binary and hard-deletes', async () => {
			const inst = makeInstance({ id: '1', pid: 0, port: 0, version: '3.1.0', type: 'Local' });
			mockDb.get.mockReturnValue(inst);
			mockDb.getAll.mockReturnValue([inst]);
			mockedExistsSync.mockReturnValue(true);
			mockedRmSync.mockImplementation(() => undefined as any);

			await service.delete('1', { purge: true });

			expect(mockDb.unregister).toHaveBeenCalledWith('1');
		});

		it('purge KEEPS binary when other instance uses same version', async () => {
			const inst = makeInstance({ id: '1', pid: 0, port: 0, version: '3.1.0', type: 'Local' });
			const other = makeInstance({ id: '2', pid: 0, port: 0, version: '3.1.0', type: 'Service' });
			mockDb.get.mockReturnValue(inst);
			mockDb.getAll.mockReturnValue([inst, other]);
			mockedExistsSync.mockReturnValue(true);
			mockedRmSync.mockImplementation(() => undefined as any);

			const progress = jest.fn();
			await service.delete('1', { purge: true, onProgress: progress });

			// Should keep binary, indicated by a progress message
			expect(progress).toHaveBeenCalledWith(expect.stringContaining('Keeping runtime'));
			expect(mockDb.unregister).toHaveBeenCalledWith('1');
		});

		it('purge stops running instance first', async () => {
			const inst = makeInstance({ id: '1', pid: 9999, port: 5565, version: '3.1.0', type: 'Local' });
			mockDb.get.mockReturnValue(inst);
			mockDb.getAll.mockReturnValue([inst]);
			mockedIsPidAlive.mockReturnValue(true);
			mockedExistsSync.mockReturnValue(true);
			mockedRmSync.mockImplementation(() => undefined as any);

			await service.delete('1', { purge: true });

			expect(mockedStopRuntime).toHaveBeenCalledWith(9999);
			expect(mockDb.unregister).toHaveBeenCalledWith('1');
		});

		it('lookup by version string', async () => {
			const inst = makeInstance({ id: '1', version: '3.1.0', type: 'Local' });
			// First get returns null (by id), then findByVersion returns the instance
			mockDb.get.mockReturnValue(null);
			mockDb.findByVersion.mockReturnValue(inst);

			await service.delete('3.1.0');

			expect(mockDb.findByVersion).toHaveBeenCalledWith('3.1.0', true);
			expect(mockDb.softDelete).toHaveBeenCalledWith('1');
		});

		it('throws for missing ID/version', async () => {
			mockDb.get.mockReturnValue(null);
			mockDb.findByVersion.mockReturnValue(null);

			await expect(service.delete('999')).rejects.toThrow(RuntimeNotFoundError);
			await expect(service.delete('999')).rejects.toThrow(/No instance found/);
		});

		it('soft-delete stops running process first', async () => {
			const inst = makeInstance({ id: '1', pid: 8888, port: 5565, version: '3.1.0', type: 'Local' });
			mockDb.get.mockReturnValue(inst);
			mockedIsPidAlive.mockReturnValue(true);

			await service.delete('1');

			expect(mockedStopRuntime).toHaveBeenCalledWith(8888);
			expect(mockDb.softDelete).toHaveBeenCalledWith('1');
		});
	});

	// ── list ─────────────────────────────────────────────────────────

	describe('list', () => {
		it('returns all non-deleted instances', () => {
			const instances = [makeInstance({ id: '0', version: '3.1.0' }), makeInstance({ id: '1', version: '3.2.0' })];
			mockDb.getAll.mockReturnValue(instances);

			const result = service.list();

			expect(result).toEqual(instances);
			expect(mockDb.open).toHaveBeenCalled();
			expect(mockDb.close).toHaveBeenCalled();
		});

		it('returns empty array when none', () => {
			mockDb.getAll.mockReturnValue([]);

			const result = service.list();

			expect(result).toEqual([]);
		});
	});

	// ── get ──────────────────────────────────────────────────────────

	describe('get', () => {
		it('returns instance by ID', () => {
			const inst = makeInstance({ id: '5', version: '3.1.0' });
			mockDb.get.mockReturnValue(inst);

			const result = service.get('5');

			expect(result).toBe(inst);
			expect(mockDb.get).toHaveBeenCalledWith('5');
		});

		it('returns null for missing', () => {
			mockDb.get.mockReturnValue(null);

			const result = service.get('999');

			expect(result).toBeNull();
		});
	});

	// ── getRunning ───────────────────────────────────────────────────

	describe('getRunning', () => {
		it('returns only alive instances', () => {
			const running = makeInstance({ id: '0', pid: 1234, port: 5565, desired_state: 'running', type: 'Local' });
			const stopped = makeInstance({ id: '1', pid: 5678, port: 5566, desired_state: 'running', type: 'Local' });
			mockDb.getAll.mockReturnValue([running, stopped]);

			mockedIsRuntimeProcess.mockImplementation((pid: number) => pid === 1234);

			const result = service.getRunning();

			expect(result).toEqual([running]);
		});

		it('skips pid=0', () => {
			const inst = makeInstance({ id: '0', pid: 0, port: 5565, type: 'Local' });
			mockDb.getAll.mockReturnValue([inst]);

			const result = service.getRunning();

			expect(result).toEqual([]);
			expect(mockedIsRuntimeProcess).not.toHaveBeenCalled();
		});

		it('checks Docker instances via DockerRuntime', () => {
			const inst = makeInstance({ id: '0', pid: 1, port: 5565, type: 'Docker', desired_state: 'running' });
			mockDb.getAll.mockReturnValue([inst]);

			const mockDockerInstance = {
				getStatus: jest.fn().mockReturnValue({ state: 'running', imageTag: '3.1.0' }),
				stop: jest.fn(),
				start: jest.fn(),
				remove: jest.fn(),
				install: jest.fn(),
				checkDockerStatus: jest.fn(),
				isDockerAvailable: jest.fn(),
			};
			mockedDockerRuntime.mockImplementation(() => mockDockerInstance as any);

			const result = service.getRunning();

			expect(result).toEqual([inst]);
			expect(mockDockerInstance.getStatus).toHaveBeenCalledWith('0');
		});
	});

	// ── listVersions ─────────────────────────────────────────────────

	describe('listVersions', () => {
		it('returns versions with install status', async () => {
			mockedListCompatibleVersions.mockResolvedValue([
				{ version: '3.2.0', prerelease: false, publishedAt: '2026-01-15T00:00:00Z' },
				{ version: '3.1.0', prerelease: false, publishedAt: '2026-01-01T00:00:00Z' },
			]);
			// 3.2.0 binary exists, 3.1.0 does not
			mockedExistsSync.mockImplementation((p: any) => {
				if (typeof p === 'string' && p.includes('3.2.0')) return true;
				return false;
			});
			mockDb.getAll.mockReturnValue([]);

			const result = await service.listVersions();

			expect(result).toHaveLength(2);
			expect(result[0].version).toBe('3.2.0');
			expect(result[0].installed).toBe(true);
			expect(result[1].version).toBe('3.1.0');
			expect(result[1].installed).toBe(false);
		});

		it('cross-references with instances', async () => {
			mockedListCompatibleVersions.mockResolvedValue([{ version: '3.1.0', prerelease: false, publishedAt: '2026-01-01T00:00:00Z' }]);
			mockedExistsSync.mockReturnValue(true);
			const inst = makeInstance({ id: '0', pid: 12345, port: 5565, version: '3.1.0', type: 'Local' });
			mockDb.getAll.mockReturnValue([inst]);
			mockedIsPidAlive.mockReturnValue(true);

			const result = await service.listVersions();

			expect(result[0].instances).toHaveLength(1);
			expect(result[0].instances[0]).toEqual({ id: '0', port: 5565, running: true });
		});

		it('excludes prerelease by default', async () => {
			await service.listVersions();

			expect(mockedListCompatibleVersions).toHaveBeenCalledWith('>=3.0.0 <4.0.0', false);
		});

		it('includes prerelease when flag true', async () => {
			mockedListCompatibleVersions.mockResolvedValue([]);

			await service.listVersions({ includePrerelease: true });

			expect(mockedListCompatibleVersions).toHaveBeenCalledWith('>=3.0.0 <4.0.0', true);
		});
	});
});
