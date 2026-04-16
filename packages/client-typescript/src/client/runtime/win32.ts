/**
 * Win32 API bindings for process management via ffi-rs.
 *
 * Only loaded on Windows. All kernel32/psapi calls go through here
 * to avoid spawning console-subsystem processes (tasklist, taskkill)
 * which flash visible command prompt windows.
 */

// Win32 access flags
const SYNCHRONIZE = 0x00100000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_VM_READ = 0x0010;

// Toolhelp32 flags
const TH32CS_SNAPPROCESS = 0x00000002;

const MAX_PATH = 260;

// PROCESS_MEMORY_COUNTERS struct (x64): 72 bytes
// WorkingSetSize (SIZE_T) at offset 16
const SIZEOF_PROCESS_MEMORY_COUNTERS = 72;
const PMC_OFFSET_WORKING_SET_SIZE = 16;

// PROCESSENTRY32 (ANSI, x64): 304 bytes
// th32ProcessID (DWORD) at offset 8
// th32ParentProcessID (DWORD) at offset 32
const SIZEOF_PROCESSENTRY32 = 304;
const PE32_OFFSET_PID = 8;
const PE32_OFFSET_PARENT_PID = 32;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */

// Lazy-initialized ffi-rs bindings
let funcs: Record<string, (...args: any[]) => any> | null = null;
let spawnFuncs: Record<string, (...args: any[]) => any> | null = null;
let _isNullPointer: (ptr: any) => boolean;

function ensureInit(): void {
	if (funcs) return;

	const { open, define, DataType, isNullPointer } = require('ffi-rs');
	_isNullPointer = isNullPointer;

	open({ library: 'kernel32', path: 'kernel32.dll' });
	open({ library: 'psapi', path: 'psapi.dll' });

	funcs = define({
		OpenProcess: {
			library: 'kernel32',
			retType: DataType.External,
			paramsType: [DataType.U32, DataType.I32, DataType.U32],
		},
		CloseHandle: {
			library: 'kernel32',
			retType: DataType.I32,
			paramsType: [DataType.External],
		},
		TerminateProcess: {
			library: 'kernel32',
			retType: DataType.I32,
			paramsType: [DataType.External, DataType.U32],
		},
		WaitForSingleObject: {
			library: 'kernel32',
			retType: DataType.U32,
			paramsType: [DataType.External, DataType.U32],
		},
		CreateToolhelp32Snapshot: {
			library: 'kernel32',
			retType: DataType.External,
			paramsType: [DataType.U32, DataType.U32],
		},
		Process32First: {
			library: 'kernel32',
			retType: DataType.I32,
			paramsType: [DataType.External, DataType.U8Array],
		},
		Process32Next: {
			library: 'kernel32',
			retType: DataType.I32,
			paramsType: [DataType.External, DataType.U8Array],
		},
		QueryFullProcessImageNameA: {
			library: 'kernel32',
			retType: DataType.I32,
			paramsType: [DataType.External, DataType.U32, DataType.U8Array, DataType.U8Array],
		},
		GetProcessMemoryInfo: {
			library: 'psapi',
			retType: DataType.I32,
			paramsType: [DataType.External, DataType.U8Array, DataType.U32],
		},
	});

	// Separate define() for spawn functions — uses numeric handles (I64 return)
	// and U32 for NULL pointer params (ffi-rs I64 params reject BigInt values)
	spawnFuncs = define({
		CreateFileA: {
			library: 'kernel32',
			retType: DataType.I64,
			paramsType: [DataType.String, DataType.U32, DataType.U32, DataType.U8Array, DataType.U32, DataType.U32, DataType.U32],
		},
		CreateProcessA: {
			library: 'kernel32',
			retType: DataType.I32,
			paramsType: [
				DataType.String, // lpApplicationName
				DataType.String, // lpCommandLine
				DataType.U32, // lpProcessAttributes (NULL = 0)
				DataType.U32, // lpThreadAttributes (NULL = 0)
				DataType.I32, // bInheritHandles
				DataType.U32, // dwCreationFlags
				DataType.U32, // lpEnvironment (NULL = 0)
				DataType.String, // lpCurrentDirectory
				DataType.U8Array, // lpStartupInfo
				DataType.U8Array, // lpProcessInformation (out)
			],
		},
		CloseHandle: {
			library: 'kernel32',
			retType: DataType.I32,
			paramsType: [DataType.U32],
		},
	});
}

/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */

function openProcess(access: number, pid: number): any {
	const handle = funcs!.OpenProcess([access, 0, pid]);
	if (_isNullPointer(handle)) return null;
	return handle;
}

function closeHandle(handle: any): void {
	funcs!.CloseHandle([handle]);
}

export function isPidAlive(pid: number): boolean {
	ensureInit();
	const handle = openProcess(SYNCHRONIZE, pid);
	if (!handle) return false;
	closeHandle(handle);
	return true;
}

export function isRuntimeProcess(pid: number): boolean {
	if (pid === 0) return false;
	ensureInit();
	const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, pid);
	if (!handle) return false;

	try {
		const nameBuf = Buffer.alloc(MAX_PATH);
		const sizeBuf = Buffer.alloc(4);
		sizeBuf.writeUInt32LE(MAX_PATH, 0);

		const ok = funcs!.QueryFullProcessImageNameA([handle, 0, nameBuf, sizeBuf]);
		if (!ok) return false;

		const len = sizeBuf.readUInt32LE(0);
		const name = nameBuf.toString('ascii', 0, len);
		return name.toLowerCase().endsWith('engine.exe');
	} finally {
		closeHandle(handle);
	}
}

export function getProcessMemoryBytes(pid: number): number | null {
	ensureInit();
	const handle = openProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, pid);
	if (!handle) return null;

	try {
		const buf = Buffer.alloc(SIZEOF_PROCESS_MEMORY_COUNTERS);
		buf.writeUInt32LE(SIZEOF_PROCESS_MEMORY_COUNTERS, 0); // cb field

		const ok = funcs!.GetProcessMemoryInfo([handle, buf, SIZEOF_PROCESS_MEMORY_COUNTERS]);
		if (!ok) return null;

		// WorkingSetSize is SIZE_T (8 bytes on x64) at offset 16
		return Number(buf.readBigUInt64LE(PMC_OFFSET_WORKING_SET_SIZE));
	} finally {
		closeHandle(handle);
	}
}

export function terminateProcessTree(pid: number, timeoutMs: number = 10000): void {
	ensureInit();

	// Snapshot all processes
	const snapshot = funcs!.CreateToolhelp32Snapshot([TH32CS_SNAPPROCESS, 0]);

	// Build parent→children map
	const childrenOf = new Map<number, number[]>();
	const entry = Buffer.alloc(SIZEOF_PROCESSENTRY32);
	entry.writeUInt32LE(SIZEOF_PROCESSENTRY32, 0); // dwSize

	let ok = funcs!.Process32First([snapshot, entry]);
	while (ok) {
		const childPid = entry.readUInt32LE(PE32_OFFSET_PID);
		const parentPid = entry.readUInt32LE(PE32_OFFSET_PARENT_PID);

		let children = childrenOf.get(parentPid);
		if (!children) {
			children = [];
			childrenOf.set(parentPid, children);
		}
		children.push(childPid);

		entry.writeUInt32LE(SIZEOF_PROCESSENTRY32, 0); // reset dwSize
		ok = funcs!.Process32Next([snapshot, entry]);
	}

	closeHandle(snapshot);

	// Collect all descendants recursively (children before parent)
	const toKill: number[] = [];
	const collect = (p: number) => {
		const children = childrenOf.get(p);
		if (children) {
			for (const child of children) {
				collect(child);
				toKill.push(child);
			}
		}
	};
	collect(pid);
	toKill.push(pid);

	// Terminate all
	for (const p of toKill) {
		const handle = openProcess(PROCESS_TERMINATE, p);
		if (handle) {
			funcs!.TerminateProcess([handle, 1]);
			closeHandle(handle);
		}
	}

	// Wait for main process to exit
	const handle = openProcess(SYNCHRONIZE, pid);
	if (handle) {
		funcs!.WaitForSingleObject([handle, timeoutMs]);
		closeHandle(handle);
	}
}

export function terminateSingleProcess(pid: number): void {
	ensureInit();
	const handle = openProcess(PROCESS_TERMINATE, pid);
	if (!handle) return;
	funcs!.TerminateProcess([handle, 1]);
	closeHandle(handle);
}

/**
 * Spawn a process with CREATE_NO_WINDOW via CreateProcessA.
 *
 * Node.js spawn() only supports SW_HIDE (windowsHide: true), which
 * creates a hidden console. Child processes spawned by the target
 * (e.g. torch importing nvidia-smi for GPU detection) each get their
 * own VISIBLE console window — causing the flashes.
 *
 * CREATE_NO_WINDOW prevents console allocation entirely, matching
 * Python's subprocess.Popen(creationflags=CREATE_NO_WINDOW).
 */
export function spawnProcessHidden(binaryPath: string, args: string[], cwd: string, stdoutPath: string, stderrPath: string): number {
	ensureInit();

	const GENERIC_WRITE = 0x40000000;
	const FILE_SHARE_READ = 0x00000001;
	const CREATE_ALWAYS = 2;
	const FILE_ATTRIBUTE_NORMAL = 0x00000080;

	// SECURITY_ATTRIBUTES (24 bytes x64) with bInheritHandle = TRUE
	const sa = Buffer.alloc(24);
	sa.writeUInt32LE(24, 0); // nLength
	sa.writeInt32LE(1, 16); // bInheritHandle = TRUE

	// ffi-rs returns I64 as number (not BigInt). INVALID_HANDLE_VALUE = -1.
	const hStdout: number = spawnFuncs!.CreateFileA([stdoutPath, GENERIC_WRITE, FILE_SHARE_READ, sa, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0]);
	if (hStdout === -1) {
		throw new Error(`CreateFileA failed for: ${stdoutPath}`);
	}

	const hStderr: number = spawnFuncs!.CreateFileA([stderrPath, GENERIC_WRITE, FILE_SHARE_READ, sa, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0]);
	if (hStderr === -1) {
		spawnFuncs!.CloseHandle([hStdout]);
		throw new Error(`CreateFileA failed for: ${stderrPath}`);
	}

	try {
		// STARTUPINFOA (104 bytes on x64, same layout as STARTUPINFOW)
		// Handle values are numbers from ffi-rs I64 return — write as UInt32
		// (Windows handles fit in 32 bits even on x64)
		const si = Buffer.alloc(104);
		si.writeUInt32LE(104, 0); // cb
		si.writeUInt32LE(0x100, 60); // dwFlags = STARTF_USESTDHANDLES
		// hStdInput at offset 80 = 0 (NULL — engine doesn't use stdin)
		si.writeUInt32LE(hStdout, 88); // hStdOutput
		si.writeUInt32LE(hStderr, 96); // hStdError

		// PROCESS_INFORMATION (24 bytes on x64)
		const pi = Buffer.alloc(24);

		// Build command line (exe must be first token, quote args with spaces)
		const cmdLine = [binaryPath, ...args].map((a) => (a.includes(' ') || a.includes('"') ? `"${a}"` : a)).join(' ');

		// CREATE_NO_WINDOW: no console allocated — child processes can't flash
		// CREATE_NEW_PROCESS_GROUP: detach from parent's Ctrl+C group
		const CREATE_NO_WINDOW = 0x08000000;
		const CREATE_NEW_PROCESS_GROUP = 0x00000200;

		const ok: number = spawnFuncs!.CreateProcessA([
			binaryPath,
			cmdLine,
			0, // lpProcessAttributes = NULL
			0, // lpThreadAttributes = NULL
			1, // bInheritHandles = TRUE
			CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
			0, // lpEnvironment = NULL (inherit parent)
			cwd,
			si,
			pi,
		]);

		if (!ok) {
			throw new Error(`CreateProcessA failed\n  binaryPath: ${binaryPath}\n  cmdLine: ${cmdLine}\n  cwd: ${cwd}`);
		}

		const pid = pi.readUInt32LE(16); // dwProcessId at offset 16

		// Close process/thread handles — we only need the PID
		spawnFuncs!.CloseHandle([pi.readUInt32LE(0)]); // hProcess
		spawnFuncs!.CloseHandle([pi.readUInt32LE(8)]); // hThread

		return pid;
	} finally {
		// Close file handles (child has inherited copies)
		spawnFuncs!.CloseHandle([hStdout]);
		spawnFuncs!.CloseHandle([hStderr]);
	}
}
