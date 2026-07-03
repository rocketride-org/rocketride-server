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
	byte:  { label: 'Byte',   bytesPerUnit: 1, hexWidth: 2 },
	word:  { label: 'Word',   bytesPerUnit: 2, hexWidth: 4 },
	dword: { label: 'DWord',  bytesPerUnit: 4, hexWidth: 8 },
	qword: { label: 'QWord',  bytesPerUnit: 8, hexWidth: 16 },
};

/** Bytes per row — always 16 for consistent address alignment. */
const BYTES_PER_ROW = 16;

/** How many bytes to fetch per range request (64 KB chunks). */
const CHUNK_SIZE = 64 * 1024;

/** Row height in pixels for virtual scroll calculation. */
const ROW_HEIGHT = 20;

/** Extra rows to render above and below the visible area. */
const OVERSCAN = 10;

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
	private _chunks = new Map<number, Uint8Array>();   // chunkIndex → data
	private _pending = new Map<number, Promise<void>>(); // in-flight fetches
	private _getUrl: () => Promise<string>;
	private _getStat: () => Promise<number>;
	private _onUpdate: () => void;

	constructor(
		getUrl: () => Promise<string>,
		getStat: () => Promise<number>,
		onUpdate: () => void,
	) {
		this._getUrl = getUrl;
		this._getStat = getStat;
		this._onUpdate = onUpdate;
	}

	get fileSize() { return this._fileSize; }

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
			const chunkStart = ci * CHUNK_SIZE;
			const localOffset = pos - chunkStart;
			const available = Math.min(chunk.length - localOffset, actualLength - written);
			result.set(chunk.subarray(localOffset, localOffset + available), written);
			written += available;
			pos += available;
		}

		return result;
	}

	private async _fetchChunk(chunkIndex: number): Promise<void> {
		if (this._pending.has(chunkIndex) || this._chunks.has(chunkIndex)) return;

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

		let response = await fetch(this._url, {
			headers: { Range: `bytes=${start}-${end}` },
		});

		// If the URL expired, refresh it and retry once
		if (response.status === 403 || response.status === 401) {
			this._url = await this._getUrl();
			response = await fetch(this._url, {
				headers: { Range: `bytes=${start}-${end}` },
			});
		}

		if (response.status !== HTTP_PARTIAL_CONTENT) {
			return; // silently skip failed / non-partial chunks
		}

		const buf = await response.arrayBuffer();
		this._chunks.set(chunkIndex, new Uint8Array(buf));
		this._onUpdate();
	}

	dispose(): void {
		this._chunks.clear();
		this._pending.clear();
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
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportHeight, setViewportHeight] = useState(0);
	const [fileSize, setFileSize] = useState(0);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [tick, setTick] = useState(0); // force re-render when chunks arrive

	const viewportRef = useRef<HTMLDivElement>(null);
	const dsRef = useRef<RangeDataSource | null>(null);

	// --- Initialise the range data source ------------------------------------

	useEffect(() => {
		setReady(false);
		setError(null);
		setFileSize(0);
		let disposed = false;

		const ds = new RangeDataSource(
			() => client.fsGetUrl(uri),
			async () => {
				const stat = await client.fsStat(uri);
				return stat.size ?? 0;
			},
			() => { if (!disposed) setTick(t => t + 1); },
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

	const handleScroll = useCallback(() => {
		if (viewportRef.current) {
			setScrollTop(viewportRef.current.scrollTop);
		}
	}, []);

	// --- Virtual scroll calculations -----------------------------------------

	const totalRows = Math.ceil(fileSize / BYTES_PER_ROW) || 1;
	const totalHeight = totalRows * ROW_HEIGHT;

	const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
	const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);
	const renderStart = Math.max(0, firstVisible - OVERSCAN);
	const renderEnd = Math.min(totalRows, firstVisible + visibleCount + OVERSCAN);

	const modeInfo = DISPLAY_MODES[mode];

	// --- Go-to-offset handler ------------------------------------------------

	const handleGoTo = useCallback(() => {
		const offset = parseInt(goToValue, 16);
		if (isNaN(offset) || !viewportRef.current) return;
		const rowIndex = Math.floor(Math.min(offset, fileSize - 1) / BYTES_PER_ROW);
		viewportRef.current.scrollTop = rowIndex * ROW_HEIGHT;
	}, [goToValue, fileSize]);

	// --- Build visible rows --------------------------------------------------

	interface HexRow {
		rowIndex: number;
		address: string;
		hex: string | null;
		asciiCells: Array<{ char: string; printable: boolean }> | null;
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
				result.push({ rowIndex: rowIdx, address: addr, hex: null, asciiCells: null });
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

			result.push({ rowIndex: rowIdx, address: addr, hex: hexParts.join(' '), asciiCells });
		}

		return result;
	}, [renderStart, renderEnd, fileSize, modeInfo, endian, tick]);

	// --- Render --------------------------------------------------------------

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
						<button
							key={key}
							style={S.modeBtn(mode === key)}
							onClick={() => setMode(key)}
						>
							{info.label}
						</button>
					))}
				</div>

				<div style={S.separator} />

				<div style={S.toolbarGroup}>
					<span style={S.label}>Endian:</span>
					<button style={S.endianBtn(endian === 'little')} onClick={() => setEndian('little')}>LE</button>
					<button style={S.endianBtn(endian === 'big')} onClick={() => setEndian('big')}>BE</button>
				</div>

				<div style={S.separator} />

				<div style={S.toolbarGroup}>
					<span style={S.label}>Go to:</span>
					<input
						style={S.goToInput}
						placeholder="hex offset"
						value={goToValue}
						onChange={(e) => setGoToValue(e.target.value)}
						onKeyDown={(e) => { if (e.key === 'Enter') handleGoTo(); }}
					/>
				</div>

				<span style={S.infoText}>
					{fileSize.toLocaleString()} bytes ({formatFileSize(fileSize)})
				</span>
			</div>

			{/* Virtualized hex grid */}
			<div
				style={S.viewport}
				ref={viewportRef}
				onScroll={handleScroll}
			>
				{/* Spacer sets the full scrollable height */}
				<div style={S.spacer(totalHeight)}>
					{/* Position visible rows absolutely within the spacer */}
					<div style={S.rowsContainer(renderStart * ROW_HEIGHT)}>
						{rows.map((row) => {
							if (!row.hex || !row.asciiCells) {
								return (
									<div key={row.rowIndex} style={S.loadingRow}>
										<span style={S.address}>{row.address}</span>
										<span style={S.hexArea}>loading...</span>
									</div>
								);
							}
							return (
								<div
									key={row.rowIndex}
									style={hoveredRowIdx === row.rowIndex ? S.hoveredRow : S.row}
									onMouseEnter={() => setHoveredRowIdx(row.rowIndex)}
									onMouseLeave={() => setHoveredRowIdx(-1)}
								>
									<span style={S.address}>{row.address}</span>
									<span style={S.hexArea}>{row.hex}</span>
									<span style={S.divider} />
									<span style={S.ascii}>
										{row.asciiCells.map((cell, ci) => (
											cell.printable
												? <span key={ci}>{cell.char}</span>
												: <span key={ci} style={S.nonPrintable}>.</span>
										))}
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
