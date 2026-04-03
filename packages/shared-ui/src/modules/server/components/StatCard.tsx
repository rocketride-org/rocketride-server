// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

import React from 'react';

interface StatCardProps {
	label: string;
	value: string | number;
	colorClass?: string;
	accentClass?: string;
	subtitle?: string;
}

export const StatCard: React.FC<StatCardProps> = ({ label, value, colorClass, accentClass, subtitle }) => (
	<div className={`sm-stat-card ${accentClass ?? ''}`}>
		<div className="sm-stat-label">{label}</div>
		<div className={`sm-stat-value ${colorClass ?? ''}`}>{value}</div>
		{subtitle && <div className="sm-stat-sub">{subtitle}</div>}
	</div>
);
