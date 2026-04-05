// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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
 * TemplatePickerDialog — Modal dialog for filling a template's `requires` slots.
 *
 * For each required slot, displays the matching services (filtered by classType
 * from the inventory) and lets the user pick one. Once all slots are filled,
 * the "Create" button instantiates the template onto the canvas.
 */

import { ReactElement, useMemo, useState } from 'react';

import { useFlowProject } from '../context/FlowProjectContext';
import type { ITemplate } from '../templates/types';
import { IService, IServiceCapabilities } from '../types';
import { getIconPath } from '../util/get-icon-path';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	backdrop: {
		position: 'fixed' as const,
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: 'rgba(0, 0, 0, 0.4)',
		zIndex: 100,
	},
	dialog: {
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		borderRadius: '8px',
		padding: '24px 28px',
		maxWidth: '500px',
		width: '100%',
		maxHeight: '80vh',
		overflowY: 'auto' as const,
		fontFamily: 'var(--rr-font-family-widget)',
		color: 'var(--rr-fg-widget)',
		userSelect: 'none',
	},
	title: {
		margin: '0 0 4px 0',
		fontSize: '16px',
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	},
	description: {
		margin: '0 0 20px 0',
		fontSize: '12px',
		color: 'var(--rr-text-secondary)',
	},
	sectionLabel: {
		margin: '0 0 8px 0',
		fontSize: '12px',
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		textTransform: 'uppercase' as const,
		letterSpacing: '0.5px',
	},
	section: {
		marginBottom: '16px',
	},
	grid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
		gap: '6px',
	},
	item: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '6px 10px',
		borderRadius: '4px',
		border: '1px solid var(--rr-border)',
		cursor: 'pointer',
		backgroundColor: 'transparent',
		color: 'inherit',
		fontFamily: 'inherit',
		fontSize: '12px',
		textAlign: 'left' as const,
		transition: 'background-color 0.1s, border-color 0.1s',
	},
	itemSelected: {
		backgroundColor: 'var(--rr-bg-widget-hover)',
		borderColor: 'var(--rr-accent)',
	},
	itemIcon: {
		width: '18px',
		height: '18px',
		flexShrink: 0,
	},
	itemTitle: {
		whiteSpace: 'nowrap' as const,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	footer: {
		display: 'flex',
		justifyContent: 'flex-end',
		gap: '8px',
		marginTop: '20px',
	},
	button: {
		padding: '6px 16px',
		borderRadius: '4px',
		border: '1px solid var(--rr-border)',
		cursor: 'pointer',
		fontFamily: 'inherit',
		fontSize: '12px',
		backgroundColor: 'transparent',
		color: 'inherit',
	},
	buttonPrimary: {
		padding: '6px 16px',
		borderRadius: '4px',
		border: '1px solid var(--rr-accent)',
		cursor: 'pointer',
		fontFamily: 'inherit',
		fontSize: '12px',
		backgroundColor: 'var(--rr-accent)',
		color: 'var(--rr-bg-widget)',
		fontWeight: 600,
	},
	buttonDisabled: {
		opacity: 0.4,
		cursor: 'default',
	},
};

// =============================================================================
// Props
// =============================================================================

interface ITemplatePickerDialogProps {
	template: ITemplate;
	onClose: () => void;
	instantiateTemplate: (template: ITemplate, resolvedProviders: Record<string, string>) => void;
}

// =============================================================================
// Component
// =============================================================================

export default function TemplatePickerDialog({ template, onClose, instantiateTemplate }: ITemplatePickerDialogProps): ReactElement {
	const { servicesJson } = useFlowProject();

	// Track user selections: slot key → chosen provider key
	const [selections, setSelections] = useState<Record<string, string>>({});

	// Build the options for each requires slot
	const slotOptions = useMemo(() => {
		const catalog = (servicesJson ?? {}) as Record<string, IService>;
		const result: Record<string, { key: string; service: IService }[]> = {};

		for (const [slotKey, requirement] of Object.entries(template.requires)) {
			const items: { key: string; service: IService }[] = [];

			for (const [providerKey, service] of Object.entries(catalog)) {
				if (!Array.isArray(service.classType) || !service.classType.includes(requirement.classType)) continue;

				const isDeprecated = service.capabilities && (IServiceCapabilities.Deprecated & service.capabilities) === IServiceCapabilities.Deprecated;
				if (isDeprecated) continue;
				items.push({ key: providerKey, service });
			}

			items.sort((a, b) => {
				const titleA = (a.service.title ?? a.key).toLowerCase();
				const titleB = (b.service.title ?? b.key).toLowerCase();
				return titleA.localeCompare(titleB);
			});

			result[slotKey] = items;
		}

		return result;
	}, [servicesJson, template.requires]);

	const allSlotsFilled = Object.keys(template.requires).every((key) => selections[key]);

	const onSelect = (slotKey: string, providerKey: string) => {
		setSelections((prev) => ({
			...prev,
			[slotKey]: prev[slotKey] === providerKey ? '' : providerKey,
		}));
	};

	const onCreate = () => {
		if (!allSlotsFilled) return;
		instantiateTemplate(template, selections);
		onClose();
	};

	return (
		<div
			style={styles.backdrop}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div style={styles.dialog}>
				<h3 style={styles.title}>{template.title}</h3>
				<p style={styles.description}>{template.description}</p>

				{Object.entries(template.requires).map(([slotKey, requirement]) => (
					<div key={slotKey} style={styles.section}>
						<p style={styles.sectionLabel}>{requirement.label}</p>
						<div style={styles.grid}>
							{(slotOptions[slotKey] ?? []).map(({ key, service }) => {
								const isSelected = selections[slotKey] === key;
								return (
									<button
										key={key}
										style={{
											...styles.item,
											...(isSelected ? styles.itemSelected : {}),
										}}
										onClick={() => onSelect(slotKey, key)}
									>
										{(() => {
											const icon = getIconPath(service.icon);
											return (
												<img
													src={icon}
													alt=""
													style={{
														...styles.itemIcon,
														filter: icon.includes('#td') ? 'var(--icon-filter)' : undefined,
													}}
												/>
											);
										})()}
										<span style={styles.itemTitle}>{service.title ?? key}</span>
									</button>
								);
							})}
							{(slotOptions[slotKey] ?? []).length === 0 && <span style={{ fontSize: '12px', color: 'var(--rr-text-disabled)' }}>No {requirement.label.toLowerCase()} services available</span>}
						</div>
					</div>
				))}

				<div style={styles.footer}>
					<button style={styles.button} onClick={onClose}>
						Cancel
					</button>
					<button
						style={{
							...styles.buttonPrimary,
							...(!allSlotsFilled ? styles.buttonDisabled : {}),
						}}
						onClick={onCreate}
						disabled={!allSlotsFilled}
					>
						Create
					</button>
				</div>
			</div>
		</div>
	);
}
