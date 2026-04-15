/**
 * SQLite-backed state for tracked runtime instances.
 *
 * File: ~/.rocketride/instances/state.db
 *
 * Uses SQLite for concurrent access safety — the SDK auto-spawn and CLI
 * can hit the state file simultaneously without race conditions.
 *
 * Shares the same DB file and schema as the Python client.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { stateDbPath, ensureDirs } from './paths.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS instances (
    id              TEXT PRIMARY KEY,
    pid             INTEGER NOT NULL,
    port            INTEGER NOT NULL,
    version         TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    owner           TEXT NOT NULL,
    restart_count   INTEGER NOT NULL DEFAULT 0,
    desired_state   TEXT NOT NULL DEFAULT 'stopped',
    type            TEXT NOT NULL DEFAULT 'Local',
    deleted         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS id_sequence (
    next_id         INTEGER NOT NULL
);

INSERT INTO id_sequence (next_id)
SELECT COALESCE(MAX(CAST(id AS INTEGER)), -1) + 1 FROM instances
WHERE NOT EXISTS (SELECT 1 FROM id_sequence);
`;

export interface InstanceRecord {
	id: string;
	pid: number;
	port: number;
	version: string;
	started_at: string;
	owner: string;
	restart_count: number;
	desired_state: 'running' | 'stopped';
	type: 'Local' | 'Service' | 'Docker';
	deleted: number;
}

export function isPidAlive(pid: number): boolean {
	if (pid === 0) return false;

	if (process.platform === 'win32') {
		// process.kill(pid, 0) is unreliable on Windows — use tasklist instead
		try {
			const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
				encoding: 'utf-8',
				timeout: 5000,
				windowsHide: true,
			}).trim();
			return !output.includes('No tasks') && output.includes(String(pid));
		} catch {
			return false;
		}
	}

	// Unix
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}

	// Check for zombie on Linux
	try {
		const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
		for (const line of status.split('\n')) {
			if (line.startsWith('State:')) {
				return !line.includes('Z');
			}
		}
	} catch {
		// /proc not available (macOS) — fall through
	}
	return true;
}

/**
 * Verify a PID belongs to the runtime binary (engine.exe), not a recycled PID.
 * Slower than isPidAlive — use only for display (e.g. runtime list), never in tight loops.
 */
export function isRuntimeProcess(pid: number): boolean {
	if (pid === 0) return false;
	if (process.platform !== 'win32') return isPidAlive(pid);

	try {
		const output = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
			encoding: 'utf-8',
			timeout: 5000,
			windowsHide: true,
		}).trim();
		if (output.includes('No tasks')) return false;
		return output.toLowerCase().includes('engine.exe');
	} catch {
		return false;
	}
}

export function getProcessMemory(pid: number): number | null {
	if (pid === 0 || !isPidAlive(pid)) return null;

	if (process.platform === 'win32') {
		try {
			const output = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).WorkingSet64"`, { encoding: 'utf-8', timeout: 5000, windowsHide: true }).trim();
			const bytes = parseInt(output, 10);
			return isNaN(bytes) ? null : bytes;
		} catch {
			return null;
		}
	}

	// Linux: read /proc
	try {
		const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
		for (const line of status.split('\n')) {
			if (line.startsWith('VmRSS:')) {
				const kb = parseInt(line.split(/\s+/)[1], 10);
				return isNaN(kb) ? null : kb * 1024;
			}
		}
	} catch {
		// /proc not available (macOS)
	}
	return null;
}

export class StateDB {
	private db: Database.Database | null = null;

	open(): void {
		ensureDirs();
		this.db = new Database(stateDbPath());
		this.db.pragma('journal_mode = WAL');
		this.db.exec(SCHEMA);
	}

	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	register(instanceId: string, pid: number, port: number, version: string, owner: string, restartCount: number = 0, desiredState: string = 'running', instanceType: string = 'Local'): void {
		const now = new Date().toISOString();
		this.db!.prepare('INSERT OR REPLACE INTO instances (id, pid, port, version, started_at, owner, restart_count, desired_state, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(instanceId, pid, port, version, now, owner, restartCount, desiredState, instanceType);
	}

	unregister(instanceId: string): void {
		this.db!.prepare('DELETE FROM instances WHERE id = ?').run(instanceId);
	}

	softDelete(instanceId: string): void {
		this.db!.prepare('UPDATE instances SET deleted = 1, pid = 0, port = 0, desired_state = ? WHERE id = ?').run('stopped', instanceId);
	}

	markStopped(instanceId: string): void {
		this.db!.prepare('UPDATE instances SET pid = 0, port = 0 WHERE id = ?').run(instanceId);
	}

	get(instanceId: string): InstanceRecord | null {
		return (this.db!.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) as InstanceRecord | undefined) ?? null;
	}

	getAll(): InstanceRecord[] {
		return this.db!.prepare('SELECT * FROM instances WHERE deleted = 0 ORDER BY CAST(id AS INTEGER) ASC').all() as InstanceRecord[];
	}

	nextId(): string {
		const row = this.db!.prepare('SELECT next_id FROM id_sequence').get() as { next_id: number } | undefined;
		if (row) {
			this.db!.prepare('UPDATE id_sequence SET next_id = ?').run(row.next_id + 1);
			return String(row.next_id);
		}
		return '0';
	}

	findByVersion(version: string, includeDeleted: boolean = false): InstanceRecord | null {
		const sql = includeDeleted ? 'SELECT * FROM instances WHERE version = ?' : 'SELECT * FROM instances WHERE version = ? AND deleted = 0';
		return (this.db!.prepare(sql).get(version) as InstanceRecord | undefined) ?? null;
	}

	findByVersionAndType(version: string, instanceType: string, includeDeleted: boolean = false): InstanceRecord | null {
		let sql = 'SELECT * FROM instances WHERE version = ? AND type = ?';
		if (!includeDeleted) sql += ' AND deleted = 0';
		return (this.db!.prepare(sql).get(version, instanceType) as InstanceRecord | undefined) ?? null;
	}

	findByType(instanceType: string): InstanceRecord[] {
		return this.db!.prepare('SELECT * FROM instances WHERE type = ? AND deleted = 0 ORDER BY CAST(id AS INTEGER) ASC').all(instanceType) as InstanceRecord[];
	}

	setDesiredState(instanceId: string, state: string): void {
		this.db!.prepare('UPDATE instances SET desired_state = ? WHERE id = ?').run(state, instanceId);
	}

	findDesiredRunning(): InstanceRecord[] {
		return this.db!.prepare("SELECT * FROM instances WHERE deleted = 0 AND desired_state = 'running' ORDER BY CAST(id AS INTEGER) ASC").all() as InstanceRecord[];
	}

	findRunning(): InstanceRecord | null {
		const all = this.getAll();
		for (const inst of all) {
			if (inst.pid === 0) continue;
			if (isPidAlive(inst.pid)) return inst;
			this.markStopped(inst.id);
		}
		return null;
	}
}
