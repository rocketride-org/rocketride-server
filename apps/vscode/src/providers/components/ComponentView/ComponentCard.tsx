// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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
 * Individual Component Card Component
 * 
 * This component renders a detailed card view for a specific pipeline component,
 * showing its usage statistics and which pipeline objects are currently utilizing it.
 * It serves as a monitoring and analytics tool for understanding component utilization
 * across the entire pipeline ecosystem.
 * 
 * Primary Functions:
 * - Display component name with clear visual identification
 * - Show active usage count with status-based color coding
 * - List all pipeline objects (files) currently using this component
 * - Provide empty state handling when component is not in use
 * - Maintain visual consistency with other card components
 * 
 * Use Cases:
 * - Component utilization monitoring
 * - Identifying unused or heavily used components
 * - Understanding component dependencies across pipelines
 * - Resource allocation and optimization insights
 * 
 * @component
 * @param props - Component properties
 * @param props.componentName - Name/identifier of the component to display
 * @param props.count - Number of active instances currently using this component
 * @param props.objectNames - Array of pipeline object names (typically filenames) using this component
 * @returns JSX.Element The rendered component card with usage information
 * 
 * @example
 * ```tsx
 * // Component actively used by multiple pipelines
 * <ComponentCard 
 *   componentName="webpack-builder"
 *   count={3}
 *   objectNames={["app.js", "worker.js", "admin.js"]}
 * />
 * 
 * // Component not currently in use
 * <ComponentCard 
 *   componentName="legacy-processor"
 *   count={0}
 *   objectNames={[]}
 * />
 * ```
 */
interface ComponentCardProps {
	/** 
	 * The unique name/identifier of the component
	 * This is typically a string that identifies the component type or function
	 */
	componentName: string;

	/** 
	 * Number of active instances currently using this component
	 * Used for both display and determining visual styling (active/inactive)
	 */
	count: number;

	/** 
	 * Array of pipeline object names currently using this component
	 * These are typically filenames or object identifiers that help users
	 * understand which specific pipelines are utilizing this component
	 */
	objectNames: string[];
}

/**
 * ComponentCard Component Implementation
 * 
 * This functional component provides a comprehensive view of component usage
 * with clear visual indicators and detailed usage information.
 */
export const ComponentCard: React.FC<ComponentCardProps> = ({
	componentName,
	count,
	objectNames
}) => {
	// ============================================================================
	// STYLING LOGIC
	// ============================================================================

	/**
	 * Dynamic CSS Class Determination
	 * 
	 * Determines the appropriate CSS class for the count badge based on
	 * whether the component is currently active (being used) or inactive.
	 * 
	 * Logic:
	 * - count > 0: Component is actively being used → 'active' class
	 * - count = 0: Component is not being used → 'inactive' class
	 * 
	 * This provides visual feedback about component status and helps users
	 * quickly identify which components are in use vs. potentially unused.
	 */
	const countClass = count > 0 ? 'active' : 'inactive';

	// ============================================================================
	// RENDER LOGIC
	// ============================================================================

	return (
		<section className="pipeline">
			{/* 
             * Note: Reuses "pipeline" class for visual consistency with PipelineCard
             * This maintains uniform spacing, borders, and overall card appearance
             * across different card types in the interface
             */}

			{/* ================================================================ */}
			{/* HEADER SECTION */}
			{/* ================================================================ */}

			{/*
             * Component Header
             * 
             * Displays the component identification and activity status.
             * Uses the same visual pattern as PipelineCard for consistency.
             * 
             * Structure:
             * - "Component" label for clear identification
             * - Component name in a styled badge (pipeline-id class)
             * - Active count with status-based styling
             */}
			<header className="pipeline-header">
				Component <span className="pipeline-id">{componentName}</span>
				<span className={`component-count ${countClass}`}>
					{count} active
				</span>
			</header>

			{/* ================================================================ */}
			{/* USAGE DETAILS SECTION */}
			{/* ================================================================ */}

			{/*
			* Component Usage Information
			*
			* This section shows which specific pipeline objects are currently
			* using this component. It provides granular visibility into
			* component dependencies and usage patterns.
			*/}
			<div className="stages">
				{/* 
                 * Note: Reuses "stages" class from pipeline styling for consistency
                 * This maintains uniform spacing and layout with pipeline stage displays
                 */}

				{objectNames.length > 0 ? (
					/**
					 * Active Usage Display
					 * 
					 * When the component is being used, display each object name
					 * that's currently utilizing this component.
					 * 
					 * Implementation Details:
					 * - Each object name is rendered as a "stage running" element
					 * - Uses composite key for React reconciliation safety
					 * - "running" class provides visual consistency with active stages
					 * - Maps over all object names to show complete usage picture
					 */
					objectNames.map((objectName, index) => (
						<span
							key={`${objectName}-${index}`}  // Composite key for uniqueness
							className="stage running"        // Visual styling consistent with active pipeline stages
						>
							{objectName}
						</span>
					))
				) : (
					/**
					 * Empty State Display
					 * 
					 * When no objects are using this component, show a clear
					 * message indicating the component is not currently active.
					 * 
					 * This helps users:
					 * - Understand why the count is 0
					 * - Identify potentially unused components
					 * - Distinguish between loading states and truly empty states
					 */
					<div className="empty-stages">
						Not currently active in any pipeline
					</div>
				)}
			</div>
		</section>
	);
};
