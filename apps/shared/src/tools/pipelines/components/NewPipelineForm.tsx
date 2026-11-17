// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * The New Pipeline form (plan §2.1, §9): the pipelines editor's UNBOUND
 * state, shown for an untitled document that has no pipeline yet. It asks the
 * one thing the author must decide, the pipeline's NAME, which is its short id
 * (`project_id`, one dot-free segment); the developer id is derived from the
 * publisher, never typed. Create writes the bundle `pipelines/<name>/<name>.pipe`
 * with `project_id: <name>` and opens it; the file may later be called
 * anything, since the identity lives inside it.
 *
 * Mirrors the App Builder's New App form (apps/shared/.../new-app/NewAppForm):
 * name, display name, the derived identity summary, a footer with Cancel and
 * Create. Hosts supply only transport, through the editor's host seam.
 */

import React, { useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, Card, InputField, commonStyles } from 'shell';
import { SHORT_ID_PATTERN } from '../sidebar/bundles';

// =============================================================================
// Types
// =============================================================================

/** What the host knows about where and under whose namespace a pipeline is born. */
export interface NewPipelineIdentity {
	/** The org's developer id ('' when none is claimed yet; the banner above says so). */
	developerId: string;
	/** Whether a create target exists (a workspace folder / a connected store). */
	workspaceOpen: boolean;
	/** Names already taken under the pipelines directory (folders and pipe stems), for live collision checks. */
	existingNames: string[];
}

/** Props for {@link NewPipelineForm}. */
export interface INewPipelineFormProps {
	/** The host's identity snapshot. */
	identity: NewPipelineIdentity;
	/** True while a create is in flight (locks the form). */
	creating: boolean;
	/** Error from a failed create, shown in the footer. */
	error?: string | null;
	/** Where the bundle lands, for the summary (e.g. 'pipelines/'). */
	locationPrefix?: string;
	/** Footer note when identity.workspaceOpen is false. */
	noWorkspaceNote?: string;
	/** Create the pipeline named `name` (its short id) with the display name. */
	onCreate: (name: string, displayName: string) => void;
	/** Close the untitled document without creating anything. */
	onCancel: () => void;
}

// =============================================================================
// Styles
// =============================================================================

const styles: Record<string, CSSProperties> = {
	page: { flex: 1, overflow: 'auto', padding: 24, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' },
	cardWrap: { width: '100%', maxWidth: 640 },
	heading: { margin: '0 0 4px', fontSize: 15, fontWeight: 600 },
	subheading: { margin: '0 0 14px', fontSize: 12, color: 'var(--rr-text-secondary)' },
	field: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 },
	fieldLabel: { fontSize: 12, fontWeight: 600 },
	input: { width: '100%' },
	inputInvalid: { borderColor: 'var(--rr-text-error, #c33)' },
	fieldError: { fontSize: 12, color: 'var(--rr-text-error, #c33)' },
	divider: { height: 1, background: 'var(--rr-border)', margin: '14px 0' },
	identity: { display: 'flex', flexDirection: 'column', gap: 6 },
	identityRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 },
	identityKey: { width: 110, color: 'var(--rr-text-secondary)' },
	identityValue: { ...commonStyles.fontMono },
	chip: { ...commonStyles.fontMono, padding: '1px 6px', borderRadius: 4, background: 'var(--rr-bg-input)', border: '1px solid var(--rr-border)' },
	chipSource: { fontSize: 11, color: 'var(--rr-text-secondary)' },
	footer: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 },
	footerNote: { flex: 1, fontSize: 12, color: 'var(--rr-text-secondary)' },
	footerError: { flex: 1, fontSize: 12, color: 'var(--rr-text-error, #c33)' },
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * A display name derived from the short id while the author has not typed
 * one: `doc-brain_v2` → `Doc Brain V2`.
 *
 * @param name - The short id.
 * @returns The derived display name.
 */
export function deriveDisplayName(name: string): string {
	return name
		.split(/[-_]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the New Pipeline form.
 *
 * @param props - See {@link INewPipelineFormProps}.
 * @returns The form.
 */
export const NewPipelineForm: React.FC<INewPipelineFormProps> = ({ identity, creating, error, locationPrefix = 'pipelines/', noWorkspaceNote, onCreate, onCancel }) => {
	const [name, setName] = useState('');
	const [displayName, setDisplayName] = useState('');
	const [displayTouched, setDisplayTouched] = useState(false);

	// Step 1: the name is the short id; one dot-free segment (plan §2.1, B5)
	const nameValid = SHORT_ID_PATTERN.test(name);
	const collision = nameValid && identity.existingNames.some((n) => n.toLowerCase() === name.toLowerCase());
	const canCreate = nameValid && !collision && displayName.trim() !== '' && identity.workspaceOpen && !creating;

	// Step 2: the identity summary; the developer id is derived, never typed
	const developerId = identity.developerId || '<developerId>';
	const shownName = nameValid ? name : '<name>';
	const address = `${developerId}.${shownName}`;
	const location = `${locationPrefix}${shownName}/${shownName}.pipe`;

	const onNameChange = useCallback(
		(value: string) => {
			setName(value);
			if (!displayTouched) setDisplayName(deriveDisplayName(value));
		},
		[displayTouched]
	);

	const note = !identity.workspaceOpen
		? (noWorkspaceNote ?? 'Open a workspace first. The pipeline is created in it.')
		: identity.developerId
			? 'The developer id is your organization’s; it is added when the pipeline is published, never typed here.'
			: 'Your organization has no developer id yet; the pipeline can be authored, but nothing runs or publishes until an admin claims one.';

	return (
		<div style={styles.page}>
			<div style={styles.cardWrap}>
				<Card>
					<h3 style={styles.heading}>Name your pipeline</h3>
					<p style={styles.subheading}>The name is the pipeline&rsquo;s id; the display name is what people see</p>
					<div style={styles.field}>
						<label htmlFor="pipelineName" style={styles.fieldLabel}>
							Pipeline name
						</label>
						<InputField id="pipelineName" type="text" spellCheck={false} placeholder="letters, digits, underscores, hyphens" value={name} onChange={(e) => onNameChange(e.target.value.trim())} style={{ ...styles.input, ...(name !== '' && !nameValid ? styles.inputInvalid : {}) }} />
						{name !== '' && !nameValid && <div style={styles.fieldError}>One segment of letters, digits, underscores and hyphens; no dots (the developer id is added when it is published).</div>}
						{collision && <div style={styles.fieldError}>&quot;{locationPrefix}{name}&quot; already exists.</div>}
					</div>
					<div style={styles.field}>
						<label htmlFor="pipelineDisplayName" style={styles.fieldLabel}>
							Display name
						</label>
						<InputField
							id="pipelineDisplayName"
							type="text"
							spellCheck={false}
							value={displayName}
							onChange={(e) => {
								setDisplayTouched(true);
								setDisplayName(e.target.value);
							}}
							style={styles.input}
						/>
					</div>
					<div style={styles.divider} />
					<h3 style={styles.heading}>Identity</h3>
					<p style={styles.subheading}>How the pipeline is addressed and where it lives</p>
					<div style={styles.identity}>
						<div style={styles.identityRow}>
							<span style={styles.identityKey}>Developer ID</span>
							<span style={styles.chip}>{developerId}</span>
							<span style={styles.chipSource}>{identity.developerId ? 'from your organization' : 'not claimed yet'}</span>
						</div>
						<div style={styles.identityRow}>
							<span style={styles.identityKey}>Address</span>
							<span style={styles.identityValue}>{address}</span>
						</div>
						<div style={styles.identityRow}>
							<span style={styles.identityKey}>Location</span>
							<span style={styles.identityValue}>{location}</span>
						</div>
					</div>
					<div style={styles.divider} />
					<div style={styles.footer}>
						<div style={error ? styles.footerError : styles.footerNote}>{error ?? note}</div>
						<Button variant="secondary" onClick={onCancel}>
							Cancel
						</Button>
						<Button variant="primary" disabled={!canCreate} onClick={() => onCreate(name, displayName.trim())}>
							{creating ? 'Creating…' : 'Create Pipeline'}
						</Button>
					</div>
				</Card>
			</div>
		</div>
	);
};

export default NewPipelineForm;
