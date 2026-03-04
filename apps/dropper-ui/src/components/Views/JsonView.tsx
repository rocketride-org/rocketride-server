/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import React from 'react';
import { Download } from 'lucide-react';
import { JsonViewer } from '@textea/json-viewer';
import { useTheme } from '../../hooks/useTheme';

/**
 * Props for the JsonView component
 */
interface JsonViewProps {
	/** Raw JSON data to display */
	rawJson: any;
}

/**
 * JsonView Component
 * 
 * Displays the raw JSON results from file processing in an interactive viewer.
 * Provides syntax highlighting, collapsible sections, and clipboard copy functionality.
 * Includes a download button to save the JSON data as a file.
 * 
 * Features:
 * - Syntax-highlighted JSON display with theme-aware colors
 * - Collapsible tree structure for nested data
 * - Click-to-copy functionality for JSON values
 * - Download button to export JSON as a file
 * - Configurable inspection depth for initial render
 * - Adapts to current theme (standalone or VSCode)
 * 
 * Theme Behavior:
 * - Standalone mode: Uses dark theme for all themes except "corporate"
 * - VSCode mode: Automatically uses VSCode's current theme
 * 
 * @param props - Component props
 * @returns React component displaying JSON content
 */
export const JsonView: React.FC<JsonViewProps> = ({ rawJson }) => {
	// Get theme context to determine if dark theme should be used
	const { mode, currentTheme } = useTheme();

	// Determine if we should use dark theme
	// Corporate is the only light theme in standalone mode
	// VSCode will handle its own theming automatically
	const isDarkTheme = mode === 'vscode' || currentTheme !== 'corporate';

	// Convert JSON to formatted string for download
	const jsonString = JSON.stringify(rawJson, null, 2);

	/**
	 * Handler for downloading JSON as a file
	 * Creates a blob from the JSON string and triggers a download
	 */
	const downloadJson = () => {
		const blob = new Blob([jsonString], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'dropper-results.json';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	return (
		<div className="tab-content">
			<div className="json-display-wrapper">
				{/* Download button for exporting JSON */}
				<button onClick={downloadJson} className="json-download-btn">
					<Download className="w-4 h-4" />
					Download JSON
				</button>

				{/* Interactive JSON viewer with syntax highlighting */}
				<div>
					<JsonViewer
						value={rawJson}
						theme={isDarkTheme ? "dark" : "light"}
						displayDataTypes={false}
						enableClipboard={true}
						defaultInspectDepth={2}
					/>
				</div>
			</div>
		</div>
	);
};
