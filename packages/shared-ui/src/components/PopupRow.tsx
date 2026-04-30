// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PopupRow — a single clickable item inside a popup menu.
 *
 * Uses --rr-* CSS variables for theming.
 */

import React, { useState } from 'react';

export const PopupRow: React.FC<{ children: React.ReactNode; onClick?: () => void }> = ({ children, onClick }) => {
	const [hovered, setHovered] = useState(false);
	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 8,
				padding: '6px 10px',
				borderRadius: 6,
				cursor: 'pointer',
				fontSize: 13,
				color: 'var(--rr-text-primary)',
				whiteSpace: 'nowrap',
				background: hovered ? 'var(--rr-bg-surface-alt)' : 'transparent',
			}}
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			{children}
		</div>
	);
};
