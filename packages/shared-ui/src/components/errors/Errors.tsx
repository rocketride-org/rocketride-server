// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * Errors — Parses and displays structured error/warning messages.
 *
 * Expected message format: "ErrorType*`message`*filepath:linenumber"
 * Falls back gracefully for unstructured messages.
 *
 * Migrated from the VS Code extension's ErrWarnSection component.
 * Plain React + inline styles using --rr-* theme tokens. No MUI.
 */

import React from 'react';
import type { CSSProperties } from 'react';

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, CSSProperties> = {
	section: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
	},
	header: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		fontSize: '13px',
		fontWeight: 600,
		color: 'var(--rr-text-primary, #ccc)',
	},
	countBadge: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		minWidth: '18px',
		height: '18px',
		padding: '0 5px',
		borderRadius: '9px',
		fontSize: '11px',
		fontWeight: 600,
		lineHeight: 1,
		color: '#fff',
		backgroundColor: 'var(--rr-brand, #007acc)',
	},
	content: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		maxHeight: '300px',
		overflowY: 'auto',
	},
	entry: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		padding: '6px 8px',
		borderRadius: '4px',
		border: '1px solid var(--rr-border, #333)',
		backgroundColor: 'var(--rr-bg-default, #1e1e1e)',
	},
	errorHeader: {
		display: 'flex',
		alignItems: 'baseline',
		gap: '8px',
		flexWrap: 'wrap',
	},
	typeBadge: {
		display: 'inline-block',
		padding: '1px 6px',
		borderRadius: '3px',
		fontSize: '11px',
		fontWeight: 600,
		lineHeight: '16px',
		whiteSpace: 'nowrap',
	},
	errorBadge: {
		color: '#fff',
		backgroundColor: 'var(--rr-color-error, #f44747)',
	},
	warningBadge: {
		color: '#fff',
		backgroundColor: 'var(--rr-color-warning, #cca700)',
	},
	message: {
		fontSize: '12px',
		color: 'var(--rr-text-primary, #ccc)',
		wordBreak: 'break-word',
	},
	location: {
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
	},
	fileInfo: {
		fontSize: '11px',
		fontFamily: 'monospace',
		color: 'var(--rr-text-secondary, #999)',
	},
	fileName: {
		fontWeight: 600,
	},
	lineNumber: {
		color: 'var(--rr-text-secondary, #999)',
	},
	fullPath: {
		fontSize: '10px',
		color: 'var(--rr-text-secondary, #999)',
		opacity: 0.7,
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
};

// =============================================================================
// TYPES
// =============================================================================

export interface ErrorsProps {
	/** Section title (e.g. "Errors", "Warnings") */
	title: string;
	/** Array of structured error/warning strings */
	items: string[];
	/** Type of messages for appropriate styling */
	type: 'error' | 'warning';
}

interface ParsedErrWarn {
	errorType: string;
	message: string;
	filePath: string;
	fileName: string;
	lineNumber?: number;
	raw: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export const Errors: React.FC<ErrorsProps> = ({ title, items, type }) => {
	/** Parse a structured error string into its components. */
	const parseItem = (item: string): ParsedErrWarn => {
		const parts = item.split('*');

		if (parts.length >= 3) {
			const errorType = parts[0].trim();
			const message = parts[1].replace(/^`|`$/g, '').trim();
			const fileInfo = parts[2].trim();

			const colonIndex = fileInfo.lastIndexOf(':');
			let filePath = fileInfo;
			let lineNumber: number | undefined;

			if (colonIndex > 0) {
				const lineStr = fileInfo.substring(colonIndex + 1);
				const parsedLine = parseInt(lineStr, 10);
				if (!isNaN(parsedLine)) {
					filePath = fileInfo.substring(0, colonIndex);
					lineNumber = parsedLine;
				}
			}

			const fileName = filePath.split(/[/\\]/).pop() || filePath;

			return { errorType, message, filePath, fileName, lineNumber, raw: item };
		}

		return {
			errorType: type.charAt(0).toUpperCase() + type.slice(1),
			message: item,
			filePath: '',
			fileName: '',
			lineNumber: undefined,
			raw: item,
		};
	};

	const badgeStyle: CSSProperties = {
		...styles.typeBadge,
		...(type === 'error' ? styles.errorBadge : styles.warningBadge),
	};

	return (
		<section style={styles.section}>
			<header style={styles.header}>
				{title}
				<span style={styles.countBadge}>{items.length}</span>
			</header>

			<div style={styles.content}>
				{items.map((item, index) => {
					const parsed = parseItem(item);
					return (
						<div key={index} style={styles.entry}>
							<div style={styles.errorHeader}>
								<span style={badgeStyle}>{parsed.errorType}</span>
								{parsed.message && <span style={styles.message}>{parsed.message}</span>}
							</div>

							{parsed.filePath && (
								<div style={styles.location}>
									<span style={styles.fileInfo}>
										<span style={styles.fileName}>{parsed.fileName}</span>
										{parsed.lineNumber && <span style={styles.lineNumber}>:{parsed.lineNumber}</span>}
									</span>
									{parsed.filePath !== parsed.fileName && (
										<div style={styles.fullPath} title={parsed.filePath}>
											{parsed.filePath}
										</div>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</section>
	);
};

export default Errors;
