// =============================================================================
// HEX VIEWER — binary file viewer with configurable display widths
// =============================================================================
//
// Shows file data as hex values on the left and decoded ASCII on the right.
// Supports byte, word (16-bit), dword (32-bit), and qword (64-bit) groupings.
// Little-endian display for multi-byte modes (matches x86/ARM convention).
//
// Data is fetched on demand via HTTP Range requests against a presigned URL
// from the server, so arbitrarily large files (videos, databases) can be
// inspected without loading the entire file into memory.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RocketRideClient } from 'rocketride';
import { viewerStyles } from './styles';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type DisplayMode = 'byte' | 'word' | 'dword' | 'qword';
type Endianness = 'little' | 'big';

interface DisplayModeInfo {
	label: string;
	bytesPerUnit: number;
	/** Number of hex chars per unit (2 per byte). */
	hexWidth: number;
}

const DISPLAY_MODES: Record<DisplayMode, DisplayModeInfo> = {
	byte: { label: 'Byte', bytesPerUnit: 1, hexWidth: 2 },
	word: { label: 'Word', bytesPerUnit: 2, hexWidth: 4 },
	dword: { label: 'DWord', bytesPerUnit: 4, hexWidth: 8 },
	qword: { label: 'QWord', bytesPerUnit: 8, hexWidth: 16 },
};

/** Bytes per row — always 16 for consistent address alignment. */
const BYTES_PER_ROW = 16;

/** How many bytes to fetch per range request (64 KB chunks). */
const CHUNK_SIZE = 64 * 1024;

/** Row height in pixels for virtual scroll calculation. */
const ROW_HEIGHT = 20;

/** Extra rows to render above and below the visible area. */
const OVERSCAN = 10;

// Browsers clamp an element's scroll extent (~2^24 px in Chromium). Cap the spacer
// well under that; for larger files the byte offset is driven from an authoritative
// `topRow` rather than raw scrollTop, so it never inherits the pixel clamp.
const MAX_SPACER_HEIGHT = 8_000_000;

// A successful ranged fetch returns 206 Partial Content. Anything else — most
// notably 200 (server/proxy ignored the Range header and sent the whole file) —
// must not be cached under a single chunk index, so we skip it.
const HTTP_PARTIAL_CONTENT = 206;

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const S = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		flex: 1,
		minHeight: 0,
		overflow: 'hidden',
		backgroundColor: 'var(--rr-bg-paper)',
		color: 'var(--rr-text-primary)',
		fontFamily: 'var(--rr-font-mono, "Cascadia Code", Consolas, "Courier New", monospace)',
		fontSize: 13,
	} as CSSProperties,
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		gap: 12,
		padding: '6px 16px',
		borderBottom: '1px solid var(--rr-border)',
		flexShrink: 0,
		fontSize: 12,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	toolbarGroup: {
		display: 'flex',
		alignItems: 'center',
		gap: 4,
	} as CSSProperties,
	modeBtn: (active: boolean): CSSProperties => ({
		padding: '2px 8px',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		cursor: 'pointer',
		fontSize: 11,
		fontFamily: 'var(--rr-font-family)',
		fontWeight: active ? 600 : 400,
		color: active ? 'var(--rr-fg-button)' : 'var(--rr-text-primary)',
		backgroundColor: active ? 'var(--rr-accent)' : 'transparent',
	}),
	endianBtn: (active: boolean): CSSProperties => ({
		padding: '2px 6px',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		cursor: 'pointer',
		fontSize: 11,
		fontFamily: 'var(--rr-font-family)',
		fontWeight: active ? 600 : 400,
		color: active ? 'var(--rr-fg-button)' : 'var(--rr-text-primary)',
		backgroundColor: active ? 'var(--rr-color-secondary)' : 'transparent',
	}),
	label: {
		color: 'var(--rr-text-secondary)',
		fontSize: 11,
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	separator: {
		width: 1,
		height: 16,
		backgroundColor: 'var(--rr-border)',
	} as CSSProperties,
	infoText: {
		color: 'var(--rr-text-secondary)',
		fontSize: 11,
		marginLeft: 'auto',
		fontFamily: 'var(--rr-font-family)',
	} as CSSProperties,
	viewport: {
		flex: 1,
		overflow: 'auto',
		scrollbarWidth: 'thin',
		scrollbarColor: 'var(--rr-bg-scrollbar-thumb) transparent',
		position: 'relative',
	} as CSSProperties,
	spacer: (height: number): CSSProperties => ({
		height,
		position: 'relative',
	}),
	rowsContainer: (top: number): CSSProperties => ({
		position: 'absolute',
		left: 0,
		right: 0,
		top,
	}),
	row: {
		display: 'flex',
		lineHeight: `${ROW_HEIGHT}px`,
		height: ROW_HEIGHT,
		whiteSpace: 'pre',
	} as CSSProperties,
	hoveredRow: {
		display: 'flex',
		lineHeight: `${ROW_HEIGHT}px`,
		height: ROW_HEIGHT,
		whiteSpace: 'pre',
		backgroundColor: 'var(--rr-bg-surface-alt)',
	} as CSSProperties,
	loadingRow: {
		display: 'flex',
		lineHeight: `${ROW_HEIGHT}px`,
		height: ROW_HEIGHT,
		whiteSpace: 'pre',
		color: 'var(--rr-text-disabled)',
		fontStyle: 'italic',
	} as CSSProperties,
	errorRow: {
		display: 'flex',
		lineHeight: `${ROW_HEIGHT}px`,
		height: ROW_HEIGHT,
		whiteSpace: 'pre',
		color: 'var(--rr-color-error, var(--rr-text-secondary))',
	} as CSSProperties,
	address: {
		color: 'var(--rr-text-secondary)',
		paddingLeft: 16,
		paddingRight: 16,
		userSelect: 'none',
		minWidth: 100,
		textAlign: 'right',
	} as CSSProperties,
	hexArea: {
		paddingRight: 16,
		letterSpacing: 0,
	} as CSSProperties,
	divider: {
		width: 1,
		backgroundColor: 'var(--rr-border)',
		margin: '0 8px',
		alignSelf: 'stretch',
	} as CSSProperties,
	ascii: {
		paddingLeft: 8,
		paddingRight: 16,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	nonPrintable: {
		opacity: 0.3,
	} as CSSProperties,
	goToInput: {
		width: 80,
		padding: '2px 6px',
		fontSize: 11,
		fontFamily: 'var(--rr-font-mono, monospace)',
		border: '1px solid var(--rr-border)',
		borderRadius: 3,
		backgroundColor: 'var(--rr-bg-input)',
		color: 'var(--rr-text-primary)',
		outline: 'none',
	} as CSSProperties,
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function formatAddress(offset: number): string {
	return offset.toString(16).toUpperCase().padStart(8, '0');
}

function byteToHex(b: number): string {
	return b.toString(16).toUpperCase().padStart(2, '0');
}

function formatUnit(data: Uint8Array, offset: number, bytesPerUnit: number, endian: Endianness): string {
	const available = Math.min(bytesPerUnit, data.length - offset);
	if (available <= 0) return '';
	const bytes: number[] = [];
	for (let i = 0; i < available; i++) bytes.push(data[offset + i]);
	if (endian === 'little') bytes.reverse();
	return bytes.map(byteToHex).join('');
}

function isPrintable(b: number): boolean {
	return b >= 0x20 && b <= 0x7e;
}

function decodeChar(b: number): string {
	return isPrintable(b) ? String.fromCharCode(b) : '.';
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// -----------------------------------------------------------------------------
// Range-fetching data source
// -----------------------------------------------------------------------------

/**
 * Manages a sparse buffer backed by HTTP Range requests against a presigned URL.
 * Automatically refreshes the URL when it expires (403).
 */
class RangeDataSource {
	private _url: string = '';
	private _fileSize: number = 0;
	private _chunks = new Map<number, Uint8Array>(); // chunkIndex → data (LRU: insertion order = age)
	private _pending = new Map<number, Promise<void>>(); // in-flight fetches
	private _failures = new Map<number, number>(); // chunkIndex → consecutive failures
	private _errors = new Map<number, string>(); // chunkIndex → last error message
	private _getUrl: () => Promise<string>;
	private _getStat: () => Promise<number>;
	private _onUpdate: () => void;
	/** Aborts in-flight range fetches on dispose. */
	private _abort = new AbortController();

	/** Resident chunk ceiling (256 × 64 KB ≈ 16 MB) — far more than any viewport needs. */
	private static readonly MAX_CACHED_CHUNKS = 256;
	/** Stop refetching a chunk after this many consecutive failures. */
	private static readonly MAX_RETRIES = 3;

	constructor(getUrl: () => Promise<string>, getStat: () => Promise<number>, onUpdate: () => void) {
		this._getUrl = getUrl;
		this._getStat = getStat;
		this._onUpdate = onUpdate;
	}

	get fileSize() {
		return this._fileSize;
	}

	async init(): Promise<void> {
		this._fileSize = await this._getStat();
		this._url = await this._getUrl();
	}

	/**
	 * Read bytes from the virtual file. Returns null for ranges not yet fetched.
	 * Triggers a background fetch for missing chunks.
	 */
	read(offset: number, length: number): Uint8Array | null {
		if (offset >= this._fileSize) return new Uint8Array(0);
		const end = Math.min(offset + length, this._fileSize);
		const actualLength = end - offset;

		// Figure out which chunks we need
		const firstChunk = Math.floor(offset / CHUNK_SIZE);
		const lastChunk = Math.floor((end - 1) / CHUNK_SIZE);

		// Check if all needed chunks are loaded
		let allLoaded = true;
		for (let ci = firstChunk; ci <= lastChunk; ci++) {
			if (!this._chunks.has(ci)) {
				allLoaded = false;
				this._fetchChunk(ci);
			}
		}
		if (!allLoaded) return null;

		// Assemble the result from cached chunks
		const result = new Uint8Array(actualLength);
		let written = 0;
		let pos = offset;
		while (written < actualLength) {
			const ci = Math.floor(pos / CHUNK_SIZE);
			const chunk = this._chunks.get(ci)!;
			this._touch(ci);
			const chunkStart = ci * CHUNK_SIZE;
			const localOffset = pos - chunkStart;
			const available = Math.min(chunk.length - localOffset, actualLength - written);
			result.set(chunk.subarray(localOffset, localOffset + available), written);
			written += available;
			pos += available;
		}

		return result;
	}

	/** Move a chunk to the "newest" end of the insertion-ordered map. */
	private _touch(chunkIndex: number): void {
		const v = this._chunks.get(chunkIndex);
		if (v !== undefined) {
			this._chunks.delete(chunkIndex);
			this._chunks.set(chunkIndex, v);
		}
	}

	/** Drop least-recently-used chunks once the budget is exceeded. */
	private _evict(): void {
		while (this._chunks.size > RangeDataSource.MAX_CACHED_CHUNKS) {
			const oldest = this._chunks.keys().next().value;
			if (oldest === undefined) break;
			this._chunks.delete(oldest);
		}
	}

	private async _fetchChunk(chunkIndex: number): Promise<void> {
		if (this._pending.has(chunkIndex) || this._chunks.has(chunkIndex)) return;
		// Give up after MAX_RETRIES — otherwise a permanently-failing chunk is
		// refetched on every re-render (a silent request storm). See chunkError().
		if ((this._failures.get(chunkIndex) ?? 0) >= RangeDataSource.MAX_RETRIES) return;

		const promise = this._doFetch(chunkIndex);
		this._pending.set(chunkIndex, promise);

		try {
			await promise;
		} finally {
			this._pending.delete(chunkIndex);
		}
	}

	private async _doFetch(chunkIndex: number): Promise<void> {
		const start = chunkIndex * CHUNK_SIZE;
		const end = Math.min(start + CHUNK_SIZE - 1, this._fileSize - 1);

		let response: Response;
		try {
			response = await fetch(this._url, {
				headers: { Range: `bytes=${start}-${end}` },
				signal: this._abort.signal,
			});

			// If the URL expired, refresh it and retry once
			if (response.status === 403 || response.status === 401) {
				this._url = await this._getUrl();
				response = await fetch(this._url, {
					headers: { Range: `bytes=${start}-${end}` },
					signal: this._abort.signal,
				});
			}
		} catch (err) {
			// A dispose-abort is not a chunk failure; the fire-and-forget
			// _fetchChunk caller must not see the rejection.
			if (this._abort.signal.aborted) return;
			throw err;
		}

		if (response.status !== HTTP_PARTIAL_CONTENT) {
			// A 200 means the server/proxy ignored Range and is streaming the WHOLE
			// file — cancel the body so a multi-GB response isn't buffered into memory.
			if (response.status === 200) {
				await response.body?.cancel();
				this._recordFailure(chunkIndex, 'Server ignored Range header (200) — partial content unsupported');
			} else {
				this._recordFailure(chunkIndex, `Expected 206, got ${response.status}`);
			}
			return;
		}

		const buf = await response.arrayBuffer();
		this._failures.delete(chunkIndex);
		this._errors.delete(chunkIndex);
		this._chunks.set(chunkIndex, new Uint8Array(buf));
		this._evict();
		this._onUpdate();
	}

	/** Record a failed fetch and let the UI paint the error state. */
	private _recordFailure(chunkIndex: number, message: string): void {
		// delete+set moves the record to the newest end (like _touch does for _chunks),
		// so eviction below drops the least-recently-failed chunk — never one that's
		// still actively failing (which would reset its retry count and bypass MAX_RETRIES).
		const count = (this._failures.get(chunkIndex) ?? 0) + 1;
		this._failures.delete(chunkIndex);
		this._failures.set(chunkIndex, count);
		this._errors.delete(chunkIndex);
		this._errors.set(chunkIndex, message);
		// Bound the failure bookkeeping like _chunks (oldest-first) so a long session
		// with many transient failures can't grow these maps without limit.
		while (this._failures.size > RangeDataSource.MAX_CACHED_CHUNKS) {
			const oldest = this._failures.keys().next().value;
			if (oldest === undefined) break;
			this._failures.delete(oldest);
			this._errors.delete(oldest);
		}
		this._onUpdate();
	}

	/**
	 * For the row renderer: the permanent error message for the chunk covering
	 * `offset`, or null while it is still loading / has retries left.
	 */
	chunkError(offset: number): string | null {
		const ci = Math.floor(offset / CHUNK_SIZE);
		return (this._failures.get(ci) ?? 0) >= RangeDataSource.MAX_RETRIES ? (this._errors.get(ci) ?? 'Failed to load') : null;
	}

	/** True when at least one chunk has permanently failed (drives the Retry button). */
	hasFailures(): boolean {
		for (const count of this._failures.values()) {
			if (count >= RangeDataSource.MAX_RETRIES) return true;
		}
		return false;
	}

	/** Clear failure bookkeeping so failed chunks are fetched again. */
	retryFailed(): void {
		this._failures.clear();
		this._errors.clear();
		this._onUpdate();
	}

	dispose(): void {
		this._abort.abort();
		this._chunks.clear();
		this._pending.clear();
		this._failures.clear();
		this._errors.clear();
	}
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

interface Props {
	client: RocketRideClient;
	uri: string;
}

export const HexViewer: React.FC<Props> = ({ client, uri }) => {
	const [mode, setMode] = useState<DisplayMode>('byte');
	const [endian, setEndian] = useState<Endianness>('little');
	const [hoveredRowIdx, setHoveredRowIdx] = useState(-1);
	const [goToValue, setGoToValue] = useState('');
	const [topRow, setTopRow] = useState(0); // authoritative top file row (drives the byte offset)
	const [viewportHeight, setViewportHeight] = useState(0);
	const [fileSize, setFileSize] = useState(0);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [tick, setTick] = useState(0); // force re-render when chunks arrive

	const viewportRef = useRef<HTMLDivElement>(null);
	const dsRef = useRef<RangeDataSource | null>(null);
	const syncingRef = useRef(false); // guards against the programmatic-scroll feedback loop

	// --- Initialise the range data source ------------------------------------

	useEffect(() => {
		setReady(false);
		setError(null);
		setFileSize(0);
		setTopRow(0); // reset scroll offset so a stale row from a bigger file can't outrun a smaller one
		let disposed = false;

		const ds = new RangeDataSource(
			() => client.fsGetUrl(uri),
			async () => {
				const stat = await client.fsStat(uri);
				return stat.size ?? 0;
			},
			() => {
				if (!disposed) setTick((t) => t + 1);
			}
		);

		dsRef.current = ds;

		ds.init()
			.then(() => {
				if (disposed) return;
				setFileSize(ds.fileSize);
				setReady(true);
			})
			.catch((err) => {
				if (!disposed) setError(err instanceof Error ? err.message : String(err));
			});

		return () => {
			disposed = true;
			ds.dispose();
			dsRef.current = null;
		};
	}, [client, uri]);

	// --- Track viewport size for virtual scrolling ---------------------------

	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;

		const observer = new ResizeObserver(([entry]) => {
			setViewportHeight(entry.contentRect.height);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [ready]);

	// --- Virtual scroll calculations -----------------------------------------
	//
	// `topRow` (the file row shown at the top of the viewport) is the single
	// source of truth for the byte offset. The scrollbar is only an input device:
	//   - files under the spacer cap → scrollbar maps 1:1 to rows (exact, native feel)
	//   - larger files → spacer is clamped, scrollbar becomes an approximate ratio
	//     control, and go-to / keyboard provide exact positioning.

	const totalRows = Math.ceil(fileSize / BYTES_PER_ROW) || 1;
	const idealHeight = totalRows * ROW_HEIGHT;
	const spacerHeight = Math.min(idealHeight, MAX_SPACER_HEIGHT);
	const isScaled = idealHeight > MAX_SPACER_HEIGHT;

	const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);
	const renderStart = Math.max(0, topRow - OVERSCAN);
	const renderEnd = Math.min(totalRows, topRow + visibleCount + OVERSCAN);

	const modeInfo = DISPLAY_MODES[mode];

	// Map an authoritative row back to a scrollbar position (best-effort sync
	// after go-to / keyboard navigation). Exact for unscaled files.
	const rowToScrollTop = useCallback(
		(rowIndex: number): number => {
			const el = viewportRef.current;
			if (!el || !isScaled) return rowIndex * ROW_HEIGHT;
			const maxScroll = Math.max(1, spacerHeight - el.clientHeight);
			const maxTopRow = Math.max(1, totalRows - Math.floor(el.clientHeight / ROW_HEIGHT));
			return Math.round((rowIndex / maxTopRow) * maxScroll);
		},
		[isScaled, spacerHeight, totalRows]
	);

	// User-driven scroll → derive topRow. Ignore the programmatic scrolls we trigger.
	const handleScroll = useCallback(() => {
		const el = viewportRef.current;
		if (!el) return;
		if (syncingRef.current) {
			syncingRef.current = false;
			return;
		}
		if (!isScaled) {
			setTopRow(Math.floor(el.scrollTop / ROW_HEIGHT));
			return;
		}
		const maxScroll = Math.max(1, spacerHeight - el.clientHeight);
		const maxTopRow = Math.max(0, totalRows - Math.floor(el.clientHeight / ROW_HEIGHT));
		setTopRow(Math.round((el.scrollTop / maxScroll) * maxTopRow));
	}, [isScaled, spacerHeight, totalRows]);

	// Move to an exact row (authoritative) and best-effort sync the scrollbar.
	const goToRow = useCallback(
		(rowIndex: number) => {
			const clampedRow = Math.min(Math.max(rowIndex, 0), totalRows - 1);
			setTopRow(clampedRow);
			const el = viewportRef.current;
			if (el) {
				// Only arm the guard when the scroll position actually changes — a no-op
				// assignment fires no scroll event, which would leave the flag stuck true
				// and swallow the user's next real scroll.
				const nextScrollTop = rowToScrollTop(clampedRow);
				if (nextScrollTop !== el.scrollTop) {
					syncingRef.current = true;
					el.scrollTop = nextScrollTop;
				}
			}
		},
		[totalRows, rowToScrollTop]
	);

	// --- Go-to-offset handler ------------------------------------------------

	const handleGoTo = useCallback(() => {
		const offset = parseInt(goToValue, 16);
		if (isNaN(offset)) return;
		const clamped = Math.min(Math.max(offset, 0), fileSize - 1);
		goToRow(Math.floor(clamped / BYTES_PER_ROW));
	}, [goToValue, fileSize, goToRow]);

	// --- Keyboard navigation (essential once the scrollbar is coarse) ---------

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			const el = viewportRef.current;
			const page = Math.max(1, Math.floor((el?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
			let next: number;
			switch (e.key) {
				case 'ArrowDown':
					next = topRow + 1;
					break;
				case 'ArrowUp':
					next = topRow - 1;
					break;
				case 'PageDown':
					next = topRow + page;
					break;
				case 'PageUp':
					next = topRow - page;
					break;
				case 'Home':
					next = 0;
					break;
				case 'End':
					next = totalRows - 1;
					break;
				default:
					return;
			}
			e.preventDefault();
			goToRow(next);
		},
		[topRow, totalRows, goToRow]
	);

	// --- Build visible rows --------------------------------------------------

	interface HexRow {
		rowIndex: number;
		address: string;
		hex: string | null;
		asciiCells: Array<{ char: string; printable: boolean }> | null;
		/** Permanent load error for this row's chunk, or null while loading/ok. */
		error: string | null;
	}

	const rows = useMemo((): HexRow[] => {
		const ds = dsRef.current;
		if (!ds) return [];

		const { bytesPerUnit, hexWidth } = modeInfo;
		const unitsPerRow = BYTES_PER_ROW / bytesPerUnit;
		const result: HexRow[] = [];

		// We need all bytes from renderStart to renderEnd
		const rangeStart = renderStart * BYTES_PER_ROW;
		const rangeEnd = Math.min(renderEnd * BYTES_PER_ROW, fileSize);
		const data = rangeStart < rangeEnd ? ds.read(rangeStart, rangeEnd - rangeStart) : null;

		for (let rowIdx = renderStart; rowIdx < renderEnd; rowIdx++) {
			const rowByteOffset = rowIdx * BYTES_PER_ROW;
			const addr = formatAddress(rowByteOffset);

			if (!data) {
				// Distinguish "still loading" from a permanent failure for this row's chunk.
				const err = ds.chunkError(rowByteOffset) ?? ds.chunkError(rowByteOffset + BYTES_PER_ROW - 1);
				result.push({ rowIndex: rowIdx, address: addr, hex: null, asciiCells: null, error: err });
				continue;
			}

			const localStart = rowByteOffset - rangeStart;
			const rowBytes = Math.min(BYTES_PER_ROW, fileSize - rowByteOffset);

			// Hex part
			const hexParts: string[] = [];
			for (let u = 0; u < unitsPerRow; u++) {
				const unitLocalOffset = localStart + u * bytesPerUnit;
				const unitFileOffset = rowByteOffset + u * bytesPerUnit;
				if (unitFileOffset >= fileSize) {
					hexParts.push(' '.repeat(hexWidth));
				} else {
					const slice = data.subarray(unitLocalOffset, unitLocalOffset + bytesPerUnit);
					const hex = formatUnit(slice, 0, Math.min(bytesPerUnit, fileSize - unitFileOffset), endian);
					hexParts.push(hex.padEnd(hexWidth, ' '));
				}
			}

			// ASCII part
			const asciiCells: HexRow['asciiCells'] = [];
			for (let i = 0; i < BYTES_PER_ROW; i++) {
				if (i >= rowBytes) {
					asciiCells.push({ char: ' ', printable: true });
				} else {
					const b = data[localStart + i];
					asciiCells.push({ char: decodeChar(b), printable: isPrintable(b) });
				}
			}

			result.push({ rowIndex: rowIdx, address: addr, hex: hexParts.join(' '), asciiCells, error: null });
		}

		return result;
	}, [renderStart, renderEnd, fileSize, modeInfo, endian, tick]);

	// --- Render --------------------------------------------------------------

	// Re-read each render (tick drives re-renders when chunk state changes).
	const hasErrors = dsRef.current?.hasFailures() ?? false;

	if (error) return <div style={viewerStyles.message}>{error}</div>;
	if (!ready) return <div style={viewerStyles.message}>Loading...</div>;
	if (fileSize === 0) return <div style={viewerStyles.message}>(empty file)</div>;

	return (
		<div style={S.container}>
			{/* Toolbar */}
			<div style={S.toolbar}>
				<div style={S.toolbarGroup}>
					<span style={S.label}>Display:</span>
					{(Object.entries(DISPLAY_MODES) as [DisplayMode, DisplayModeInfo][]).map(([key, info]) => (
						<button key={key} style={S.modeBtn(mode === key)} onClick={() => setMode(key)}>
							{info.label}
						</button>
					))}
				</div>

				<div style={S.separator} />

				<div style={S.toolbarGroup}>
					<span style={S.label}>Endian:</span>
					<button style={S.endianBtn(endian === 'little')} onClick={() => setEndian('little')}>
						LE
					</button>
					<button style={S.endianBtn(endian === 'big')} onClick={() => setEndian('big')}>
						BE
					</button>
				</div>

				<div style={S.separator} />

				<div style={S.toolbarGroup}>
					<span style={S.label}>Go to:</span>
					<input
						style={S.goToInput}
						placeholder="hex offset"
						value={goToValue}
						onChange={(e) => setGoToValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') handleGoTo();
						}}
					/>
				</div>

				{hasErrors && (
					<>
						<div style={S.separator} />
						<button style={S.modeBtn(false)} onClick={() => dsRef.current?.retryFailed()} title="Retry chunks that failed to load">
							⚠ Retry
						</button>
					</>
				)}

				<span style={S.infoText}>
					{fileSize.toLocaleString()} bytes ({formatFileSize(fileSize)})
				</span>
			</div>

			{/* Virtualized hex grid */}
			<div style={S.viewport} ref={viewportRef} onScroll={handleScroll} onKeyDown={handleKeyDown} tabIndex={0}>
				{/* Spacer supplies the scroll range (bounded so browsers don't clamp offsets) */}
				<div style={S.spacer(spacerHeight)}>
					{/*
					  Unscaled: rows sit at their true pixel offset (exact native scrolling,
					  unchanged for files under the cap). Scaled: the spacer no longer maps
					  1:1 to rows, so rows ride the top of the viewport via sticky positioning,
					  shifted up by the overscan rows above topRow.
					*/}
					<div style={isScaled ? { position: 'sticky', top: 0, transform: `translateY(${-(topRow - renderStart) * ROW_HEIGHT}px)` } : S.rowsContainer(renderStart * ROW_HEIGHT)}>
						{rows.map((row) => {
							if (!row.hex || !row.asciiCells) {
								return (
									<div key={row.rowIndex} style={row.error ? S.errorRow : S.loadingRow}>
										<span style={S.address}>{row.address}</span>
										<span style={S.hexArea}>{row.error ? `⚠ ${row.error}` : 'loading...'}</span>
									</div>
								);
							}
							return (
								<div key={row.rowIndex} style={hoveredRowIdx === row.rowIndex ? S.hoveredRow : S.row} onMouseEnter={() => setHoveredRowIdx(row.rowIndex)} onMouseLeave={() => setHoveredRowIdx(-1)}>
									<span style={S.address}>{row.address}</span>
									<span style={S.hexArea}>{row.hex}</span>
									<span style={S.divider} />
									<span style={S.ascii}>
										{row.asciiCells.map((cell, ci) =>
											cell.printable ? (
												<span key={ci}>{cell.char}</span>
											) : (
												<span key={ci} style={S.nonPrintable}>
													.
												</span>
											)
										)}
									</span>
								</div>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
};
