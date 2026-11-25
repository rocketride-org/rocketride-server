// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * LaneView — one lane of one answer, drawn by its type: a field table for a
 * record, markdown for text, "From …" chips with passages for documents, a
 * gallery for media (a link or base64), a table, the question text, and Raw
 * JSON for a lane type the Playground does not know. One renderer per lane
 * type, never one per agent.
 */

import React, { useState, type CSSProperties } from 'react';
import { Button, LabelValue, MarkdownRenderer, commonStyles } from 'shell';
import { JsonTree } from 'shared/components/json-tree/JsonTree';
import { friendlyName } from '../../core/friendly';
import { cellText, isRecord, mediaSource, readAnswer, readDocument } from '../../core/results';
import type { ResultLane } from '../../core/results';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	block: {
		marginTop: 4,
	} as CSSProperties,
	fieldTable: {
		display: 'flex',
		flexDirection: 'column',
		gap: 2,
		marginTop: 4,
	} as CSSProperties,
	sources: {
		display: 'flex',
		alignItems: 'center',
		flexWrap: 'wrap',
		gap: 6,
		marginTop: 8,
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	passage: {
		marginTop: 8,
		padding: '8px 10px',
		borderLeft: '2px solid var(--rr-border)',
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'pre-wrap',
	} as CSSProperties,
	passageMeta: {
		...commonStyles.textMuted,
		fontSize: 11,
		marginBottom: 4,
	} as CSSProperties,
	gallery: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
		gap: 10,
		marginTop: 4,
	} as CSSProperties,
	media: {
		width: '100%',
		maxHeight: 220,
		borderRadius: 8,
		objectFit: 'cover',
		backgroundColor: 'var(--rr-bg-surface-alt)',
		display: 'block',
	} as CSSProperties,
	mediaGone: {
		height: 110,
		borderRadius: 8,
		border: '1px dashed var(--rr-border)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		textAlign: 'center',
		padding: 8,
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
	caption: {
		...commonStyles.textEllipsis,
		fontSize: 11,
		color: 'var(--rr-text-secondary)',
		marginTop: 3,
	} as CSSProperties,
	sentence: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,
};

// =============================================================================
// TYPES
// =============================================================================

/** Props for {@link LaneView}. */
export interface ILaneViewProps {
	/** The lane. */
	lane: ResultLane;
	/** Simple view: friendly names, no chunk numbers. */
	simple: boolean;
	/** The agent's name, for sentences. */
	agentName: string;
	/** A caption for media items (the file they came from), when there are several files. */
	caption?: string;
}

// =============================================================================
// PIECES
// =============================================================================

/**
 * A record as label/value rows: keys friendly in Simple, as returned in Advanced.
 *
 * @param props - The record and the view.
 * @returns The rows.
 */
export const FieldTable: React.FC<{ record: Record<string, unknown>; simple: boolean }> = ({ record, simple }) => (
	<div style={styles.fieldTable}>
		{Object.entries(record).map(([key, value]) => (
			<LabelValue key={key} label={simple ? friendlyName(key) : key}>
				{cellText(value)}
			</LabelValue>
		))}
	</div>
);

/**
 * One media item: the element, or a sentence when its link no longer loads.
 *
 * @param props - The lane, the item and its caption.
 * @returns The item.
 */
const MediaItem: React.FC<{ lane: string; item: unknown; caption?: string }> = ({ lane, item, caption }) => {
	const media = mediaSource(lane, item);
	// The source that failed, not a flag: when this slot is reused for another
	// item (another lane's tab, another file), the new source gets its own try.
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	const failed = failedSrc !== null && failedSrc === media.src;
	const setFailed = () => setFailedSrc(media.src);
	const name = media.name ?? caption ?? 'This file';

	let element: React.ReactNode;
	if (!media.src || failed) {
		element = <div style={styles.mediaGone}>{media.isLink || failed ? `${name} has been removed.` : `${name} can't be shown here.`}</div>;
	} else if (lane === 'image') {
		// Media elements: the shell has no image, audio or video control.
		element = <img src={media.src} alt={name} style={styles.media} onError={setFailed} />;
	} else if (lane === 'audio') {
		element = <audio src={media.src} controls style={styles.media} onError={setFailed} />;
	} else {
		element = <video src={media.src} controls style={styles.media} onError={setFailed} />;
	}
	return (
		<div>
			{element}
			{caption && <div style={styles.caption}>{caption}</div>}
		</div>
	);
};

/**
 * Documents as "From <files>" chips; a chip shows its passages.
 *
 * @param props - The items and the view.
 * @returns The documents.
 */
const Documents: React.FC<{ items: unknown[]; simple: boolean }> = ({ items, simple }) => {
	const passages = items.map(readDocument);
	const files = [...new Set(passages.map((p) => p.file))];
	const [open, setOpen] = useState<string | null>(null);
	return (
		<div>
			<div style={styles.sources}>
				From
				{files.map((file) => (
					<Button key={file} variant={open === file ? 'secondary' : 'ghost'} mini pressed={open === file} onClick={() => setOpen(open === file ? null : file)}>
						{file}
					</Button>
				))}
			</div>
			{open &&
				passages
					.filter((p) => p.file === open)
					.map((p, i) => (
						<div key={i} style={styles.passage}>
							{!simple && (p.chunk !== undefined || p.score !== undefined) && (
								<div style={styles.passageMeta}>
									{p.chunk !== undefined ? `Chunk ${p.chunk}` : ''}
									{p.chunk !== undefined && p.score !== undefined ? ' · ' : ''}
									{p.score !== undefined ? `Score ${p.score.toFixed(2)}` : ''}
								</div>
							)}
							{p.text}
						</div>
					))}
		</div>
	);
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders one lane of one answer.
 *
 * @param props - {@link ILaneViewProps}.
 * @returns The lane.
 */
export const LaneView: React.FC<ILaneViewProps> = ({ lane, simple, agentName, caption }) => {
	switch (lane.type) {
		case 'answers':
		case 'json':
			return (
				<div style={styles.block}>
					{lane.items.map((item, i) => {
						const read = readAnswer(item);
						return read.kind === 'record' ? <FieldTable key={i} record={read.record} simple={simple} /> : <MarkdownRenderer key={i} content={read.text} />;
					})}
				</div>
			);
		case 'text':
		case 'table':
			return <MarkdownRenderer content={lane.items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n\n')} />;
		case 'documents':
			return <Documents items={lane.items} simple={simple} />;
		case 'image':
		case 'audio':
		case 'video':
			return (
				<div style={styles.gallery}>
					{lane.items.map((item, i) => (
						<MediaItem key={i} lane={lane.type} item={item} caption={caption} />
					))}
				</div>
			);
		case 'questions':
			return (
				<div style={styles.block}>
					{lane.items.map((item, i) => {
						const questions = isRecord(item) && Array.isArray(item.questions) ? item.questions : [];
						return <div key={i}>{questions.map((q) => (isRecord(q) && typeof q.text === 'string' ? q.text : '')).join(' ')}</div>;
					})}
				</div>
			);
		default:
			return simple ? <div style={styles.sentence}>{agentName} sent back something this page can't show. Download keeps it.</div> : <JsonTree data={lane.items} defaultExpanded={1} />;
	}
};

/**
 * The tab label for a lane type ("Answers", "Images").
 *
 * @param type - The lane type.
 * @returns The label.
 */
export function laneLabel(type: string): string {
	const words: Record<string, string> = { image: 'Images', audio: 'Audio', video: 'Video', answers: 'Answers', text: 'Text', documents: 'Documents', table: 'Tables', json: 'JSON', questions: 'Questions' };
	return words[type] ?? friendlyName(type);
}
