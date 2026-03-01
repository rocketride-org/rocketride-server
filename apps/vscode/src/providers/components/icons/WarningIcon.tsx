import React from 'react';

interface WarningIconProps {
	size?: number;
}

export const WarningIcon: React.FC<WarningIconProps> = ({ size = 14 }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		style={{ display: 'inline-block', verticalAlign: 'middle' }}
	>
		<path
			d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
			fill="#F0C000"
			stroke="#222"
			strokeWidth="1.5"
			strokeLinejoin="round"
		/>
		<line x1="12" y1="9" x2="12" y2="15" stroke="#222" strokeWidth="2.2" strokeLinecap="round" />
		<circle cx="12" cy="18" r="1.2" fill="#222" />
	</svg>
);
