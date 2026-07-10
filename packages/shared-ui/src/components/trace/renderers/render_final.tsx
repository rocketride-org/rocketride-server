// =============================================================================
// Trace Renderer: Final Pipeline Result
// =============================================================================

import React, { CSSProperties, ReactElement } from 'react';
import { renderAnswer, isAnswer } from './render_answer';
import { renderQuestion, isQuestion } from './render_question';
import { renderDocument, isDocument } from './render_document';
import { renderImage, isImage } from './render_image';
import { renderText, isText } from './render_text';
import { renderAudio, isAudio } from './render_audio';
import { renderVideo, isVideo } from './render_video';
import { renderTable, isTable } from './render_table';
import { JsonTree } from '../JsonTree';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	section: {
		padding: '8px 10px',
		borderBottom: '1px solid var(--rr-border)',
	} as CSSProperties,
	sectionLast: {
		padding: '8px 10px',
	} as CSSProperties,
	sectionLabel: {
		fontSize: 10,
		fontWeight: 600,
		color: 'var(--rr-text-disabled)',
		textTransform: 'uppercase' as const,
		letterSpacing: '0.05em',
		marginBottom: 6,
	} as CSSProperties,
};

// =============================================================================
// HELPERS
// =============================================================================

// Pipeline result fields are always arrays (IInstance.py appends one item per write call).
// Wrap functions operate on individual items; renderSection iterates the array.
const LANE_RENDERERS: Array<{
	type: string;
	check: (data: unknown) => boolean;
	render: (data: any) => ReactElement | null;
	wrap: (key: string, value: unknown) => unknown;
}> = [
	{
		type: 'answers',
		check: isAnswer,
		render: renderAnswer,
		// For string items: detect JSON by checking first/last chars and pass expectJson so format_answer renders it correctly.
		wrap: (k, v) => {
			const isJsonStr = typeof v === 'string' && v.trimStart().startsWith('{') && v.trimEnd().endsWith('}');
			return { answers: { answer: v, ...(isJsonStr ? { expectJson: true } : {}) } };
		},
	},
	{ type: 'questions', check: isQuestion, render: renderQuestion, wrap: (k, v) => ({ questions: v }) },
	{ type: 'documents', check: isDocument, render: renderDocument, wrap: (k, v) => ({ documents: v }) },
	{ type: 'image', check: isImage, render: renderImage, wrap: (k, v) => v },
	{ type: 'text', check: isText, render: renderText, wrap: (k, v) => ({ text: v }) },
	{ type: 'audio', check: isAudio, render: renderAudio, wrap: (k, v) => ({ audio: v }) },
	{ type: 'video', check: isVideo, render: renderVideo, wrap: (k, v) => ({ video: v }) },
	{ type: 'table', check: isTable, render: renderTable, wrap: (k, v) => ({ text: v }) },
];

function renderSection(key: string, type: string, value: unknown, isLast: boolean): ReactElement {
	const renderer = LANE_RENDERERS.find((r) => r.type === type);
	const items = renderer && Array.isArray(value) ? value : [value];

	const content = items.map((item, i) => {
		if (renderer) {
			const wrapped = renderer.wrap(key, item);
			if (wrapped && renderer.check(wrapped)) {
				return <React.Fragment key={i}>{renderer.render(wrapped)}</React.Fragment>;
			}
		}
		return (
			<div key={i} style={{ fontSize: 11, color: 'var(--rr-text-secondary)' }}>
				<JsonTree data={item} defaultExpanded={1} />
			</div>
		);
	});

	return (
		<div style={isLast ? S.sectionLast : S.section}>
			{key !== type && <div style={S.sectionLabel}>{key}</div>}
			{content}
		</div>
	);
}

// =============================================================================
// RENDERER
// =============================================================================

/** Renders just the result sections (no container/header) — used by the collapsible ResultRow in Trace.tsx. */
export function renderFinalSections(result: Record<string, unknown>): ReactElement | null {
	const resultTypes = result.result_types as Record<string, string> | undefined;
	if (!resultTypes || Object.keys(resultTypes).length === 0) return null;

	const entries = Object.entries(resultTypes);

	return (
		<>
			{entries.map(([key, type], i) => (
				<React.Fragment key={key}>{renderSection(key, type, result[key], i === entries.length - 1)}</React.Fragment>
			))}
		</>
	);
}

/** Returns the number of result fields (for the collapsed row summary). */
export function resultFieldCount(result: Record<string, unknown>): number {
	const resultTypes = result.result_types as Record<string, string> | undefined;
	return resultTypes ? Object.keys(resultTypes).length : 0;
}
