// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** The old list view. Nothing imports it any more. */

import React from 'react';

export const LegacyList: React.FC<{ items: string[] }> = ({ items }) => (
	<ul>
		{items.map((item) => (
			<li key={item.id}>{item}</li>
		))}
	</ul>
);
