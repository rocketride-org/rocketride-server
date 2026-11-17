// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * DropperDocument — one drop zone for one pipe (plan 3.6).
 *
 * Bound to ONE address (`developerId.pipelineId[.source]`). Dropped files go
 * in through the pipe's dropper source with the SDK's `sendFiles()`; the
 * address is the token slot, so the server resolves the publication that
 * answers THIS caller and starts its engine when it is dormant. Each upload
 * is listed with its outcome and the result the pipeline returned.
 *
 * The same component serves both mounts: the shell app (browser, `pipe=`)
 * and the dev-tool frame (workbench, the document key is the address).
 */

import React, { useCallback, useState } from 'react';
import type { UPLOAD_RESULT } from 'rocketride';
import { Button, DropZone, useShellConnection } from 'shell';

// =============================================================================
// TYPES
// =============================================================================

/** One file the person dropped, from upload to outcome. */
interface IUploadRow {
	/** Stable key for the list. */
	id: number;
	/** The file name as dropped. */
	name: string;
	/** The file size in bytes. */
	size: number;
	/** Where the upload is. */
	status: 'uploading' | 'done' | 'failed';
	/** The pipeline's result for this file, when it returned one. */
	result?: Record<string, unknown>;
	/** The failure, when the upload or the pipeline failed. */
	error?: string;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	column: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		minHeight: 0,
		background: 'var(--rr-bg-primary)',
		fontFamily: 'var(--rr-font-family, system-ui)',
	},
	header: {
		display: 'flex',
		alignItems: 'baseline',
		gap: 10,
		padding: '10px 16px',
		borderBottom: '1px solid var(--rr-border)',
	},
	headerLabel: {
		fontSize: 11,
		textTransform: 'uppercase',
		letterSpacing: 0.6,
		color: 'var(--rr-text-secondary)',
	},
	headerAddress: {
		fontSize: 13,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-primary)',
	},
	body: {
		flex: 1,
		minHeight: 0,
		overflow: 'auto',
		padding: 16,
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	},
	list: {
		display: 'flex',
		flexDirection: 'column',
		gap: 8,
	},
	row: {
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		padding: '10px 12px',
	},
	rowHead: {
		display: 'flex',
		alignItems: 'baseline',
		gap: 10,
		fontSize: 13,
		color: 'var(--rr-text-primary)',
	},
	rowMeta: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		marginLeft: 'auto',
	},
	rowError: {
		marginTop: 6,
		fontSize: 12,
		color: 'var(--rr-error, #d33)',
	},
	result: {
		marginTop: 8,
		fontSize: 12,
		fontFamily: 'var(--rr-font-mono, monospace)',
		color: 'var(--rr-text-primary)',
		background: 'var(--rr-bg-secondary)',
		borderRadius: 6,
		padding: 10,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
		maxHeight: 320,
		overflow: 'auto',
	},
	toolbar: {
		display: 'flex',
		justifyContent: 'flex-end',
	},
	disconnected: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
	},
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Human-readable byte count.
 *
 * @param bytes - The size in bytes.
 * @returns `12 KB`, `3.4 MB`, ...
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The outcome of one `sendFiles` entry as a row update.
 *
 * @param upload - The SDK's per-file result.
 * @returns The status, result and error for the row.
 */
function outcomeOf(upload: UPLOAD_RESULT | undefined): Pick<IUploadRow, 'status' | 'result' | 'error'> {
	if (!upload) return { status: 'failed', error: 'No result came back for this file' };
	const error = (upload as { error?: unknown }).error;
	if (upload.action === 'error' || error) {
		return { status: 'failed', error: typeof error === 'string' ? error : 'The upload failed' };
	}
	// The transport succeeded; the pipeline may still have failed the object
	// and said so in the close body
	const result = upload.result as Record<string, unknown> | undefined;
	const resultError = result?.error;
	if (typeof resultError === 'string' && resultError.length > 0) {
		return { status: 'failed', error: resultError, result };
	}
	return { status: 'done', result };
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for {@link DropperDocument}. */
export interface IDropperDocumentProps {
	/** The pipe address this drop zone is bound to. */
	address: string;
}

/**
 * One drop zone for the pipe at `address`.
 *
 * @param props - {@link IDropperDocumentProps}.
 */
export const DropperDocument: React.FC<IDropperDocumentProps> = ({ address }) => {
	// Step 1: this realm's client
	const { client, isConnected } = useShellConnection();
	const [rows, setRows] = useState<IUploadRow[]>([]);
	const [nextId, setNextId] = useState(1);

	// Step 2: send a drop through the pipe; a dormant engine starts on the first file
	const handleFiles = useCallback(
		(list: FileList) => {
			if (!client) return;
			const files = Array.from(list);
			if (files.length === 0) return;
			const firstId = nextId;
			setNextId(firstId + files.length);
			const pending: IUploadRow[] = files.map((file, index) => ({
				id: firstId + index,
				name: file.name,
				size: file.size,
				status: 'uploading',
			}));
			setRows((prev) => [...pending, ...prev]);

			const payload = files.map((file) => ({
				file,
				objinfo: { name: file.name, size: file.size },
				mimetype: file.type || 'application/octet-stream',
			}));
			void client
				.sendFiles(payload, address)
				.then((results) => {
					setRows((prev) =>
						prev.map((row) => {
							const index = row.id - firstId;
							if (index < 0 || index >= files.length) return row;
							return { ...row, ...outcomeOf(results[index]) };
						})
					);
				})
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					setRows((prev) =>
						prev.map((row) => {
							const index = row.id - firstId;
							if (index < 0 || index >= files.length) return row;
							return { ...row, status: 'failed', error: message };
						})
					);
				});
		},
		[client, address, nextId]
	);

	const clear = useCallback(() => setRows([]), []);
	const ready = isConnected && client !== null;

	return (
		<div style={styles.column}>
			<div style={styles.header}>
				<span style={styles.headerLabel}>Dropper</span>
				<span style={styles.headerAddress}>{address}</span>
			</div>
			<div style={styles.body}>
				{ready ? (
					<DropZone
						title="Drop files here"
						hint="Each file goes through the pipeline; its result appears below. The first drop starts the engine if nobody has used it recently."
						onFiles={handleFiles}
					/>
				) : (
					<div style={styles.disconnected}>Connect to a RocketRide server to drop files.</div>
				)}
				{rows.length > 0 && (
					<>
						<div style={styles.toolbar}>
							<Button variant="ghost" small onClick={clear}>
								Clear
							</Button>
						</div>
						<div style={styles.list}>
							{rows.map((row) => (
								<div key={row.id} style={styles.row}>
									<div style={styles.rowHead}>
										<span>{row.name}</span>
										<span style={styles.rowMeta}>
											{formatBytes(row.size)} · {row.status === 'uploading' ? 'uploading…' : row.status}
										</span>
									</div>
									{row.error && <div style={styles.rowError}>{row.error}</div>}
									{row.result && <pre style={styles.result}>{JSON.stringify(row.result, null, 2)}</pre>}
								</div>
							))}
						</div>
					</>
				)}
			</div>
		</div>
	);
};

export default DropperDocument;
