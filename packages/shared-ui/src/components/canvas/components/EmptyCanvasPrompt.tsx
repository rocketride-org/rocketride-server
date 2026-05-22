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
 * EmptyCanvasPrompt — Shown when the canvas has no nodes.
 *
 * Displays a centered overlay (outside the ReactFlow zoom/pan layer)
 * listing all available source services so the user can pick a
 * starting point with a single click, plus a templates section
 * for pre-built pipeline skeletons.
 *
 * Hidden when:
 *   - There is at least one node on the canvas
 *   - The create-node panel is open
 */

import { ReactElement, useMemo, useState } from 'react';

import { useFlowProject } from '../context/FlowProjectContext';
import { useFlowGraph } from '../context/FlowGraphContext';
import { IService, IServiceCapabilities } from '../types';
import { templates as templateCatalog } from '../templates';
import { commonStyles } from '../../../themes/styles';
import type { ITemplate } from '../templates/types';
import { getIconPath } from '../util/get-icon-path';
import { resolveDefaultFormData } from '../util/helpers';
import { validateFormData } from '../util/rjsf';
import TemplatePickerDialog from './TemplatePickerDialog';

// =============================================================================
// Styles — uses --rr-* design tokens
// =============================================================================

const styles = {
	overlay: {
		position: 'absolute' as const,
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		pointerEvents: 'none' as const,
		zIndex: 5,
	},
	card: {
		pointerEvents: 'auto' as const,
		backgroundColor: 'var(--rr-bg-widget)',
		border: '1px solid var(--rr-border)',
		borderRadius: '8px',
		padding: '24px 28px',
		maxWidth: '480px',
		width: '100%',
		fontFamily: 'var(--rr-font-family-widget)',
		color: 'var(--rr-fg-widget)',
		userSelect: 'none',
	},
	heading: {
		margin: '0 0 4px 0',
		fontSize: '14px',
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	},
	subheading: {
		margin: '0 0 16px 0',
		fontSize: '12px',
		color: 'var(--rr-text-secondary)',
	},
	grid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
		gap: '6px',
	},
	item: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '6px 10px',
		borderRadius: '4px',
		borderWidth: '1px',
		borderStyle: 'solid',
		borderColor: 'var(--rr-border)',
		cursor: 'pointer',
		backgroundColor: 'transparent',
		color: 'inherit',
		fontFamily: 'inherit',
		fontSize: '12px',
		textAlign: 'left' as const,
		transition: 'background-color 0.1s, border-color 0.1s',
	},
	itemIcon: {
		width: '18px',
		height: '18px',
		flexShrink: 0,
	},
	itemTitle: commonStyles.textEllipsis,
	divider: {
		margin: '16px 0',
		borderTop: '1px solid var(--rr-border)',
	},
	templateItem: {
		display: 'flex',
		flexDirection: 'column' as const,
		gap: '2px',
		padding: '8px 12px',
		borderRadius: '4px',
		borderWidth: '1px',
		borderStyle: 'solid',
		borderColor: 'var(--rr-border)',
		cursor: 'pointer',
		backgroundColor: 'transparent',
		color: 'inherit',
		fontFamily: 'inherit',
		fontSize: '12px',
		textAlign: 'left' as const,
		transition: 'background-color 0.1s, border-color 0.1s',
	},
	templateTitle: {
		fontWeight: 600,
		fontSize: '12px',
	},
	templateDescription: {
		fontSize: '11px',
		color: 'var(--rr-text-secondary)',
		lineHeight: '1.3',
	},
};

// =============================================================================
// Component
// =============================================================================

interface IEmptyCanvasPromptProps {
	instantiateTemplate: (template: ITemplate, resolvedProviders: Record<string, string>) => void;
	/** Called after a source node is added so the host can fitView + show config toast. */
	onNodeAdded: (nodeId: string, formDataValid: boolean) => void;
}

export default function EmptyCanvasPrompt({ instantiateTemplate, onNodeAdded }: IEmptyCanvasPromptProps): ReactElement | null {
	const { servicesJson } = useFlowProject();
	const { addNode } = useFlowGraph();

	// Hover tracking by key (source provider key or template slug)
	const [hoveredKey, setHoveredKey] = useState<string | null>(null);

	// Template picker dialog state
	const [pickerTemplate, setPickerTemplate] = useState<ITemplate | null>(null);

	// Extract source services from the service catalog
	const sources = useMemo(() => {
		const catalog = (servicesJson ?? {}) as Record<string, IService>;

		const items: { key: string; service: IService }[] = [];
		for (const [providerKey, service] of Object.entries(catalog)) {
			if (!Array.isArray(service.classType) || !service.classType.includes('source')) continue;

			// Skip NoSaas services (not available in SaaS UI, e.g. Filesys)
			const isNoSaas = service.capabilities && (IServiceCapabilities.NoSaas & service.capabilities) === IServiceCapabilities.NoSaas;
			if (isNoSaas) continue;

			// Skip deprecated services
			const isDeprecated = service.capabilities && (IServiceCapabilities.Deprecated & service.capabilities) === IServiceCapabilities.Deprecated;
			if (isDeprecated) continue;

			items.push({ key: providerKey, service });
		}

		// Sort alphabetically by display title
		items.sort((a, b) => {
			const titleA = (a.service.title ?? a.key).toLowerCase();
			const titleB = (b.service.title ?? b.key).toLowerCase();
			return titleA.localeCompare(titleB);
		});

		return items;
	}, [servicesJson]);

	// Build template list from the static catalog
	const templateList = useMemo(() => {
		return Object.entries(templateCatalog).map(([slug, template]) => ({
			slug,
			template: template as ITemplate,
		}));
	}, []);

	const onClickSource = (providerKey: string) => {
		const nodeId = addNode({
			provider: providerKey,
			name: '',
			description: '',
			config: {},
			input: [],
			control: [],
		});

		// Check if the newly added node needs configuration
		const service = servicesJson?.[providerKey];
		const pipe = service?.Pipe as { schema?: Record<string, unknown> } | undefined;
		let formDataValid = true;
		if (pipe?.schema) {
			const formData = resolveDefaultFormData(providerKey, pipe.schema);
			const validation = validateFormData(pipe.schema, formData);
			formDataValid = validation.errors.length === 0;
		}
		onNodeAdded(nodeId, formDataValid);
	};

	if (sources.length === 0 && templateList.length === 0) return null;

	return (
		<>
			<div style={styles.overlay}>
				<div style={styles.card}>
					{/* Sources section */}
					<h3 style={styles.heading}>Select your starting point</h3>
					<p style={styles.subheading}>Choose a source to begin building your pipeline</p>
					<div style={styles.grid}>
						{sources.map(({ key, service }) => (
							<button
								key={key}
								style={{
									...styles.item,
									...(hoveredKey === key
										? {
												backgroundColor: 'var(--rr-bg-widget-hover)',
												borderColor: 'var(--rr-accent)',
											}
										: {}),
								}}
								onClick={() => onClickSource(key)}
								onMouseEnter={() => setHoveredKey(key)}
								onMouseLeave={() => setHoveredKey(null)}
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
						))}
					</div>

					{/* Templates section */}
					{templateList.length > 0 && (
						<>
							<div style={styles.divider} />
							<h3 style={styles.heading}>Or start from a template</h3>
							<p style={styles.subheading}>Pre-built pipeline skeletons you can customize</p>
							<div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
								{templateList.map(({ slug, template }) => (
									<button
										key={slug}
										style={{
											...styles.templateItem,
											...(hoveredKey === `tpl:${slug}`
												? {
														backgroundColor: 'var(--rr-bg-widget-hover)',
														borderColor: 'var(--rr-accent)',
													}
												: {}),
										}}
										onClick={() => {
											if (Object.keys(template.requires).length === 0) {
												// No requires — instantiate directly (future-proofing)
												setPickerTemplate(template);
											} else {
												setPickerTemplate(template);
											}
										}}
										onMouseEnter={() => setHoveredKey(`tpl:${slug}`)}
										onMouseLeave={() => setHoveredKey(null)}
									>
										<span style={styles.templateTitle}>{template.title}</span>
										<span style={styles.templateDescription}>{template.description}</span>
									</button>
								))}
							</div>
						</>
					)}
				</div>
			</div>

			{/* Template picker dialog — shown when a template with requires is selected */}
			{pickerTemplate && <TemplatePickerDialog template={pickerTemplate} onClose={() => setPickerTemplate(null)} instantiateTemplate={instantiateTemplate} />}
		</>
	);
}
