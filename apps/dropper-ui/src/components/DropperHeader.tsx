/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

import React from 'react';
import { Upload, Settings, Trash2, Palette } from 'lucide-react';
import { useTheme, ThemeName } from '../hooks/useTheme';

/**
 * Props for the DropperHeader component
 */
interface DropperHeaderProps {
	/** Whether there are uploaded files in the system */
	hasFiles: boolean;
	/** Callback function to clear all uploaded files and reset state */
	onClearAll: () => void;
	/** Whether the RocketRide client is connected and ready */
	isConnected: boolean;
}

/**
 * DropperHeader - Header component for the RocketRide Dropper application
 * 
 * Displays the application branding, connection status, and action buttons.
 * The header remains fixed at the top of the application and provides
 * quick access to key actions.
 * 
 * Features:
 * - Application branding with upload icon avatar
 * - Real-time connection status indicator
 * - Theme selector (standalone mode only)
 * - Clear all button (trash icon) - disabled when no files present
 * - Settings button (placeholder for future functionality)
 * 
 * Visual Structure:
 * - Left side: Avatar icon + title + connection status
 * - Right side: Theme selector (if standalone) + action buttons (clear all, settings)
 * 
 * Theme Behavior:
 * - Standalone mode: Shows theme selector with available themes
 * - VSCode mode: Hides theme selector, uses VSCode's theme automatically
 * 
 * @component
 * @example
 * ```tsx
 * <DropperHeader
 *   hasFiles={true}
 *   onClearAll={() => console.log('Clear all clicked')}
 *   isConnected={true}
 * />
 * ```
 * 
 * @param props - Component props
 * @param props.hasFiles - Whether there are uploaded files
 * @param props.onClearAll - Callback to clear all files
 * @param props.isConnected - Whether connected to RocketRide
 */
export const DropperHeader: React.FC<DropperHeaderProps> = ({
	hasFiles,
	onClearAll,
	isConnected
}) => {
	// Get theme context for theme selection and mode detection
	const { mode, currentTheme, setTheme, availableThemes } = useTheme();

	return (
		<div className="dropper-header">
			<div className="header-content">
				{/* Left section: Branding and status */}
				<div className="header-info">
					{/* Avatar with upload icon */}
					<div className="dropper-avatar">
						<Upload className="w-4 h-4" />
					</div>

					{/* Application title and connection status */}
					<div className="header-text">
						<h1>RocketRide Dropper</h1>
						<p>
							{isConnected ? 'Connected' : 'Connecting...'}
						</p>
					</div>
				</div>

				{/* Right section: Theme selector and action buttons */}
				<div className="header-actions">
					{/* Theme selector - only show in standalone mode */}
					{mode === 'standalone' && (
						<div className="theme-selector">
							<Palette className="w-4 h-4 theme-selector-icon" />
							<select
								value={currentTheme}
								onChange={(e) => setTheme(e.target.value as ThemeName)}
								className="theme-select"
								title="Select theme"
								aria-label="Select application theme"
							>
								{availableThemes.map(theme => (
									<option key={theme} value={theme}>
										{theme.charAt(0).toUpperCase() + theme.slice(1)}
									</option>
								))}
							</select>
						</div>
					)}

					{/* Clear all files button */}
					<button
						onClick={onClearAll}
						className="header-btn"
						title="Clear all files"
						type="button"
						disabled={!hasFiles}
						aria-label="Clear all files"
					>
						<Trash2 className="w-5 h-5" />
					</button>

					{/* Settings button (placeholder for future functionality) */}
					<button
						className="header-btn"
						title="Settings"
						type="button"
						aria-label="Settings"
					>
						<Settings className="w-5 h-5" />
					</button>
				</div>
			</div>
		</div>
	);
};
