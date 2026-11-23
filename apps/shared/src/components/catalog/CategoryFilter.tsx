// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CATEGORY FILTER — a row of pills ("All" + each catalog category) that narrows
// the visible apps. Active pill fills with accent; inactive pills are outlined.
// =============================================================================

import React, { useState } from 'react';
import type { ICatalogPalette } from './palette';


/** A selectable category — `key` is the catalog value, `label` the display text. */
export interface CategoryOption {
	key: string;
	label: string;
}

interface CategoryFilterProps {
	/** Active theme tokens. */
	t: ICatalogPalette;
	/** Categories to offer, in display order. (The "All" pill is added here.) */
	categories: CategoryOption[];
	/** Currently selected category key, or 'all'. */
	active: string;
	/** Called with the newly selected key. */
	onChange: (key: string) => void;
}

/** One pill. Active = filled accent; inactive = outlined, brightening on hover. */
const Pill: React.FC<{
	t: ICatalogPalette;
	active: boolean;
	label: string;
	onClick: () => void;
}> = ({ t, active, label, onClick }) => {
	const [hovered, setHovered] = useState(false);
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			style={{
				flexShrink: 0,
				padding: '7px 16px', borderRadius: 999,
				fontFamily: t.font, fontSize: 13, fontWeight: 600, cursor: 'pointer',
				whiteSpace: 'nowrap',
				color: active ? t.accentText : t.textTri,
				backgroundColor: active ? t.accent : 'transparent',
				border: `1px solid ${active ? t.accent : hovered ? t.borderHover : t.border}`,
				transition: 'background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease',
			}}
		>
			{label}
		</button>
	);
};

/**
 * Horizontal, wrap-friendly row of category pills. Renders an "All" pill first,
 * then one per supplied category.
 */
export const CategoryFilter: React.FC<CategoryFilterProps> = ({ t, categories, active, onChange }) => {
	if (categories.length === 0) return null;

	return (
		<div style={{
			display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
			fontFamily: t.font,
		}}>
			<Pill t={t} active={active === 'all'} label="All" onClick={() => onChange('all')} />
			{categories.map((c) => (
				<Pill key={c.key} t={t} active={active === c.key} label={c.label} onClick={() => onChange(c.key)} />
			))}
		</div>
	);
};
