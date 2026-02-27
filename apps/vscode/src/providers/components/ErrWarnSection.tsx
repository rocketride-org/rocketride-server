// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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

import React from 'react';

/**
 * Enhanced Error Section Component for Structured Error Display
 * 
 * This component provides sophisticated parsing and display of structured error
 * and warning messages that follow a specific format pattern. It enhances the
 * basic LogSection by providing detailed breakdown of error components, making
 * it easier for developers to identify and debug issues.
 * 
 * Supported Error Format:
 * "ErrorType*`message`*filepath:linenumber"
 * 
 * Format Components:
 * - ErrorType: Category of error (Exception, TypeError, SyntaxError, etc.)
 * - message: Descriptive error message (wrapped in backticks)
 * - filepath: Full path to the file where error occurred
 * - linenumber: Line number where error occurred (optional)
 * 
 * Key Features:
 * - Structured error parsing with fallback for unstructured messages
 * - Visual separation of error type, message, and location information
 * - Filename extraction from full paths for cleaner display
 * - Line number parsing and display when available
 * - Tooltips for full file paths when truncated
 * - Type-based styling (error vs warning)
 * - Enhanced accessibility with semantic HTML structure
 * 
 * Advantages over basic LogSection:
 * - Better visual hierarchy with structured layout
 * - Easier error identification with type badges
 * - Quick file navigation with separated filename display
 * - Reduced visual clutter while preserving all information
 * - Consistent error presentation across different error sources
 * 
 * @component
 * @param props - Component properties
 * @param props.title - Section title (e.g., "Errors", "Warnings")
 * @param props.items - Array of structured error/warning strings
 * @param props.type - Error type for styling ('error' or 'warning')
 * @returns JSX.Element The rendered error section with enhanced formatting
 * 
 * @example
 * ```tsx
 * // Structured error messages
 * const errors = [
 *   "TypeError*`'NoneType' object has no attribute 'get'`*C:\\project\\src\\main.py:42",
 *   "FileNotFoundError*`config.json not found`*C:\\project\\config\\settings.py:15",
 *   "Simple error message without structure" // Fallback handling
 * ];
 * 
 * <ErrorSection title="Errors" items={errors} type="error" />
 * 
 * // Warning messages  
 * const warnings = [
 *   "DeprecationWarning*`Function will be removed in v2.0`*C:\\project\\utils\\legacy.py:128"
 * ];
 * 
 * <ErrorSection title="Warnings" items={warnings} type="warning" />
 * ```
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Component Props Interface
 * 
 * Defines the expected properties for the ErrorSection component.
 * Similar to LogSection but specifically for error/warning display.
 */
interface ErrWarnSectionProps {
	/** Section title displayed in header */
	title: string;

	/** Array of error/warning message strings (structured or unstructured) */
	items: string[];

	/** Type of messages for appropriate styling */
	type: 'error' | 'warning';

	/** Optional callback when user clicks "Mark as read" */
	onMarkAsRead?: () => void;
}

/**
 * Parsed Error Data Structure
 * 
 * Represents the structured components of a parsed error message.
 * Used internally to organize error information for display.
 */
interface ParsedErrWarn {
	/** Type/category of the error (e.g., "TypeError", "Exception") */
	errorType: string;

	/** Descriptive error message */
	message: string;

	/** Full file path where error occurred */
	filePath: string;

	/** Extracted filename from full path for display */
	fileName: string;

	/** Line number where error occurred (optional) */
	lineNumber?: number;

	/** Original raw error string for fallback */
	raw: string;
}

// ============================================================================
// MAIN COMPONENT IMPLEMENTATION
// ============================================================================

/**
 * ErrorSection Component Implementation
 * 
 * Provides enhanced error display with structured parsing and formatting.
 */
export const ErrWarnSection: React.FC<ErrWarnSectionProps> = ({ title, items, type, onMarkAsRead }) => {

	// ========================================================================
	// ERROR PARSING LOGIC
	// ========================================================================

	/**
	 * Structured Error Parser
	 * 
	 * Parses error strings that follow the structured format:
	 * "ErrorType*`message`*filepath:linenumber"
	 * 
	 * Parsing Strategy:
	 * 1. Split by asterisk (*) to separate main components
	 * 2. Extract error type from first component
	 * 3. Extract message from second component (remove backticks)
	 * 4. Parse file path and line number from third component
	 * 5. Extract clean filename from full path
	 * 6. Handle fallback for non-structured messages
	 * 
	 * Error Handling:
	 * - Graceful degradation for malformed structured messages
	 * - Fallback parsing for completely unstructured messages
	 * - Safe parsing of line numbers with validation
	 * - Proper handling of various path separators (Windows/Unix)
	 * 
	 * @param item - Raw error string to parse
	 * @returns ParsedError Structured error object with all components
	 */
	const parseErrorItem = (item: string): ParsedErrWarn => {
		// ====================================================================
		// STRUCTURED FORMAT PARSING
		// ====================================================================

		/**
		 * Split Error String by Asterisk Delimiter
		 * 
		 * The structured format uses asterisk (*) as delimiter between
		 * error type, message, and file location components.
		 */
		const parts = item.split('*');

		/**
		 * Process Structured Format
		 * 
		 * If we have at least 3 parts, attempt to parse as structured format.
		 * This handles the expected "ErrorType*`message`*filepath:linenumber" pattern.
		 */
		if (parts.length >= 3) {
			// Extract and clean error type (first component)
			const errorType = parts[0].trim();

			// Extract and clean message (second component, remove backticks)
			const message = parts[1].replace(/^`|`$/g, '').trim();

			// Extract file info (third component, may contain line number)
			const fileInfo = parts[2].trim();

			// ================================================================
			// FILE PATH AND LINE NUMBER EXTRACTION
			// ================================================================

			/**
			 * Parse File Path and Line Number
			 * 
			 * The file info component may be in format:
			 * - "filepath:linenumber" (with line number)
			 * - "filepath" (without line number)
			 * 
			 * Strategy:
			 * 1. Find last colon in string (line number separator)
			 * 2. Try to parse number after colon
			 * 3. If successful, split path and line number
			 * 4. If unsuccessful, treat entire string as path
			 */
			const colonIndex = fileInfo.lastIndexOf(':');
			let filePath = fileInfo;
			let lineNumber: number | undefined;

			// Attempt to extract line number if colon found
			if (colonIndex > 0) {
				const lineStr = fileInfo.substring(colonIndex + 1);
				const parsedLine = parseInt(lineStr, 10);

				// Validate parsed line number
				if (!isNaN(parsedLine)) {
					filePath = fileInfo.substring(0, colonIndex);
					lineNumber = parsedLine;
				}
			}

			// ================================================================
			// FILENAME EXTRACTION
			// ================================================================

			/**
			 * Extract Clean Filename from Full Path
			 * 
			 * For display purposes, show just the filename rather than
			 * the full path, while preserving full path for tooltips.
			 * 
			 * Handles both Windows (\) and Unix (/) path separators.
			 */
			const fileName = filePath.split(/[/\\]/).pop() || filePath;

			// Return structured error object
			return {
				errorType,
				message,
				filePath,
				fileName,
				lineNumber,
				raw: item
			};
		}

		// ====================================================================
		// FALLBACK FOR UNSTRUCTURED MESSAGES
		// ====================================================================

		/**
		 * Fallback Parsing for Non-Structured Items
		 * 
		 * When error string doesn't match structured format,
		 * create a basic error object with sensible defaults.
		 * This ensures component doesn't break with mixed message types.
		 */
		return {
			errorType: type.charAt(0).toUpperCase() + type.slice(1), // "Error" or "Warning"
			message: item,
			filePath: '',
			fileName: '',
			lineNumber: undefined,
			raw: item
		};
	};

	// ========================================================================
	// ERROR RENDERING LOGIC
	// ========================================================================

	/**
	 * Enhanced Error Item Renderer
	 * 
	 * Renders a parsed error item with enhanced formatting that provides
	 * clear visual hierarchy and easy-to-scan information layout.
	 * 
	 * Visual Structure:
	 * - Error Header: Type badge + message
	 * - Error Location: Filename + line number + full path tooltip
	 * 
	 * Design Principles:
	 * - Most important info (type, message) prominently displayed
	 * - File location info secondary but easily accessible
	 * - Clean visual separation between components
	 * - Consistent styling with other error displays
	 * 
	 * @param parsed - Structured error data from parseErrorItem
	 * @param index - Array index for React key
	 * @returns JSX.Element Rendered error item with enhanced formatting
	 */
	const renderErrorItem = (parsed: ParsedErrWarn, index: number) => {
		const { errorType, message, fileName, filePath, lineNumber } = parsed;

		return (
			<div key={index} className={`log-entry ${type}-entry error-item`}>

				{/* ============================================================ */}
				{/* ERROR HEADER SECTION */}
				{/* ============================================================ */}

				{/*
                 * Error Header with Type Badge and Message
                 * 
                 * Primary error information displayed prominently:
                 * - Error type in a styled badge for quick categorization
                 * - Error message with appropriate spacing and styling
                 * 
                 * Visual Design:
                 * - Error type badge stands out for quick scanning
                 * - Message flows naturally after type identification
                 * - Consistent spacing and alignment
                 */}
				<div className="error-header">
					<span className="error-type-badge">{errorType}</span>
					{message && <span className="error-message">{message}</span>}
				</div>

				{/* ============================================================ */}
				{/* ERROR LOCATION SECTION */}
				{/* ============================================================ */}

				{/*
                 * File Location Information
                 * 
                 * Secondary information about where the error occurred:
                 * - Clean filename display for quick identification
                 * - Line number when available
                 * - Full path in tooltip for complete context
                 * - Conditional rendering based on available information
                 * 
                 * Layout Strategy:
                 * - Primary: filename + line number (most useful for developers)
                 * - Secondary: full path in tooltip (complete context when needed)
                 * - Graceful handling when path info is missing
                 */}
				{filePath && (
					<div className="error-location">
						<span className="file-info">
							<span className="file-name">{fileName}</span>
							{lineNumber && <span className="line-number">:{lineNumber}</span>}
						</span>
						{/* Show full path only if different from filename (avoid redundancy) */}
						{filePath !== fileName && (
							<div className="full-path" title={filePath}>{filePath}</div>
						)}
					</div>
				)}
			</div>
		);
	};

	// ========================================================================
	// MAIN RENDER LOGIC
	// ========================================================================

	return (
		<section className="status-section">

			{/* ================================================================ */}
			{/* SECTION HEADER */}
			{/* ================================================================ */}

			{/*
             * Enhanced Section Header
             * 
             * Displays section title with item count using a styled badge
             * that matches the visual design of component counts elsewhere
             * in the interface.
             * 
             * Visual Elements:
             * - Clear section title
             * - Count badge with "active" styling for consistency
             * - Proper spacing and alignment
             */}
			<header className="section-header">
				{title}
				<span className="component-count active">{items.length}</span>
				{onMarkAsRead && (
					<button type="button" className="mark-as-read-btn" onClick={onMarkAsRead}>
						Mark as read
					</button>
				)}
			</header>

			{/* ================================================================ */}
			{/* SECTION CONTENT */}
			{/* ================================================================ */}

			{/*
             * Scrollable Error List Container
             * 
             * Contains the list of parsed and formatted error items.
             * Uses log-section class for consistent scrolling behavior
             * and spacing with other log displays.
             */}
			<div className="section-content log-section">
				{items.map((item, index) => {
					const parsed = parseErrorItem(item);
					return renderErrorItem(parsed, index);
				})}
			</div>
		</section>
	);
};
