// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * ExposeNameDialog — the ONLY naming moment for a pipeline parameter (mockup
 * M-1.2). The public name is pre-filled from the field, checked live against
 * the pipeline's `parameters` map (duplicate or malformed names flag red and
 * disable the action — the map never holds a duplicate), and the dialog
 * returns the name to the owner of the map. An exposed property reopens with
 * Save / Remove.
 */

import { CSSProperties, ReactElement, useMemo, useState } from 'react';
import type { ServiceParamDescriptor } from 'rocketride';
import { Button, InputField, Modal, commonStyles } from 'shell';

import { fieldStyles } from './PropertyField';

// =============================================================================
// Constants
// =============================================================================

/** A public name: `[A-Za-z0-9_]+` (plan §5.4 item 1). */
export const PUBLIC_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

// =============================================================================
// Styles
// =============================================================================

const styles = {
	subtitle: {
		...commonStyles.textMuted,
		marginBottom: 12,
	} as CSSProperties,

	collision: {
		...fieldStyles.error,
	} as CSSProperties,

	help: {
		...commonStyles.textMuted,
		marginTop: 6,
	} as CSSProperties,

	code: {
		...commonStyles.fontMono,
	} as CSSProperties,
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Formats the descriptor's value space for the subtitle: enum options, or
 * numeric bounds, plus the default.
 *
 * @param descriptor - The param descriptor.
 * @returns The summary text.
 */
export function describeParam(descriptor: ServiceParamDescriptor): string {
	const parts: string[] = [];
	if (descriptor.enum?.length) parts.push(descriptor.enum.map(String).join(' | '));
	else {
		let type = descriptor.type ?? '';
		if (descriptor.type === 'integer' || descriptor.type === 'number') {
			if (descriptor.minimum !== undefined && descriptor.maximum !== undefined) type += ` ${descriptor.minimum}–${descriptor.maximum}`;
			else if (descriptor.minimum !== undefined) type += ` ≥ ${descriptor.minimum}`;
			else if (descriptor.maximum !== undefined) type += ` ≤ ${descriptor.maximum}`;
		}
		if (type) parts.push(type);
	}
	if (descriptor.default !== null && descriptor.default !== undefined) parts.push(`default ${String(descriptor.default)}`);
	return parts.join(' · ');
}

/**
 * The live collision check: the name must be well-formed and not used by a
 * DIFFERENT target in the map.
 *
 * @param name - The candidate public name.
 * @param target - This property's `nodeId.path` target.
 * @param parameters - The pipeline's `parameters` map.
 * @param describeTarget - Renders a target for the message.
 * @returns The problem text, or null when the name is free.
 */
export function publicNameProblem(name: string, target: string, parameters: Record<string, string>, describeTarget: (target: string) => string): string | null {
	if (!name) return 'Enter a public name.';
	if (!PUBLIC_NAME_PATTERN.test(name)) return 'Letters, digits and underscore only.';
	// Own entries only: "constructor" or "toString" must read as free names
	const owner = Object.hasOwn(parameters, name) ? parameters[name] : undefined;
	if (owner !== undefined && owner !== target) return `Already used by ${describeTarget(owner)} — pick another name.`;
	return null;
}

// =============================================================================
// Props
// =============================================================================

/** Props for {@link ExposeNameDialog}. */
export interface IExposeNameDialogProps {
	/** Node display name (subtitle). */
	nodeTitle: string;
	/** The param descriptor of the property being exposed. */
	descriptor: ServiceParamDescriptor;
	/** This property's `nodeId.path` target in the map. */
	target: string;
	/** The pipeline's current `parameters` map. */
	parameters: Record<string, string>;
	/** The name the property is currently exposed under, when it is. */
	currentName?: string;
	/** Renders a target (`nodeId.path`) for the collision message. */
	describeTarget: (target: string) => string;
	/** Commits the name (expose or rename). */
	onExpose: (name: string) => void;
	/** Removes the exposure (only offered when `currentName` is set). */
	onRemove?: () => void;
	/** Dismisses the dialog. */
	onClose: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the naming dialog.
 *
 * @param props - {@link IExposeNameDialogProps}.
 * @returns The dialog.
 */
export default function ExposeNameDialog({ nodeTitle, descriptor, target, parameters, currentName, describeTarget, onExpose, onRemove, onClose }: IExposeNameDialogProps): ReactElement {
	// Pre-fill: the current public name, else the field's short name.
	const [name, setName] = useState(currentName ?? descriptor.field.split('.').pop() ?? '');
	const problem = useMemo(() => publicNameProblem(name.trim(), target, parameters, describeTarget), [name, target, parameters, describeTarget]);
	const unchanged = currentName !== undefined && name.trim() === currentName;

	const commit = (): void => {
		if (problem || unchanged) return;
		onExpose(name.trim());
	};

	return (
		<Modal
			title="Expose as parameter"
			onClose={onClose}
			width={440}
			footer={
				<>
					<Button variant="ghost" small onClick={onClose}>
						Cancel
					</Button>
					{currentName !== undefined && onRemove && (
						<Button variant="danger" small onClick={onRemove}>
							Remove
						</Button>
					)}
					<Button variant="primary" small disabled={Boolean(problem) || unchanged} onClick={commit}>
						{currentName !== undefined ? 'Save' : 'Expose'}
					</Button>
				</>
			}
		>
			<div style={styles.subtitle}>
				{nodeTitle} · <span style={styles.code}>{descriptor.field}</span>
				{describeParam(descriptor) ? ` · ${describeParam(descriptor)}` : ''}
			</div>
			<label style={fieldStyles.label} htmlFor="rr-expose-name">
				Public name
			</label>
			<InputField
				id="rr-expose-name"
				value={name}
				autoFocus
				spellCheck={false}
				style={{ marginTop: 5, ...(problem && name ? fieldStyles.inputError : {}) }}
				onChange={(event) => setName(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter') commit();
				}}
			/>
			{problem && name ? (
				<div style={styles.collision}>{problem}</div>
			) : (
				<div style={styles.help}>
					Callers use this in <span style={styles.code}>params={'{…}'}</span>. Renaming after publish is a breaking change.
				</div>
			)}
		</Modal>
	);
}
