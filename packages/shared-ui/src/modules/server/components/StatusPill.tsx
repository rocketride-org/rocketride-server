// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React from 'react';

interface StatusPillProps {
	label: string;
	variant: 'success' | 'warning' | 'error' | 'info' | 'muted';
	pulse?: boolean;
}

export const StatusPill: React.FC<StatusPillProps> = ({ label, variant, pulse }) => (
	<span className={`sm-pill sm-pill-${variant}`}>
		{pulse && <span className="sm-pill-dot sm-pill-dot-pulse" />}
		{label}
	</span>
);
