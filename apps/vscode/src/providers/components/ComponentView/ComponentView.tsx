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

import React, { useMemo } from 'react';
import { Pipeline, FlowData } from '../../../shared/types';
import { ComponentCard } from './ComponentCard';

/**
 * Component View Component
 * 
 * This is a comprehensive data analysis and visualization component that provides
 * insights into component usage patterns across all pipelines in the system.
 * It serves as a monitoring dashboard for understanding how components are being
 * utilized, which components are most popular, and which pipelines are using
 * specific components.
 * 
 * Core Functionality:
 * - Processes raw pipeline flow data to extract component usage statistics
 * - Calculates how many pipelines are currently using each component
 * - Maps components to their associated pipeline objects/files
 * - Renders individual ComponentCard components with computed data
 * - Handles various edge cases (missing data, empty components, etc.)
 * 
 * Data Processing Pipeline:
 * 1. Raw flowData.byPipe input → Component usage analysis → Rendered cards
 * 2. Filters and aggregates data from multiple pipeline sources
 * 3. Creates comprehensive usage statistics for each component
 * 
 * Use Cases:
 * - Component utilization monitoring and analytics
 * - Identifying unused or over-utilized components
 * - Understanding component dependencies across pipeline ecosystem
 * - Resource allocation and optimization planning
 * - Pipeline architecture analysis
 * 
 * @component
 * @param props - Component properties
 * @param props.pipelines - Array of pipelines for potential cross-referencing (currently unused)
 * @param props.flowData - Flow data containing byPipe pipeline information structure
 * @returns JSX.Element The rendered component view with usage statistics
 * 
 * @example
 * ```tsx
 * const flowData = {
 *   byPipe: {
 *     "pipeline-1": ["app.js", "webpack", "babel", "eslint"],
 *     "pipeline-2": ["worker.js", "webpack", "typescript"],
 *     "pipeline-3": ["admin.js", "babel", "eslint", "sass"]
 *   }
 * };
 * 
 * return <ComponentView pipelines={[]} flowData={flowData} />;
 * // This will render cards for: webpack (2 uses), babel (2 uses), eslint (2 uses), etc.
 * ```
 */
interface ComponentViewProps {
	/** 
	 * Array of pipeline objects for potential cross-referencing
	 * NOTE: Currently unused in the implementation - may be legacy or future feature
	 * Could be used for additional pipeline metadata or validation
	 */
	pipelines: Pipeline[];

	/** 
	 * Flow data containing the byPipe structure with pipeline information
	 * This is the primary data source for component analysis
	 * Can be null during loading states or when no data is available
	 */
	flowData: FlowData | null;
}

/**
 * ComponentView Component Implementation
 * 
 * This component performs complex data processing to transform raw pipeline data
 * into meaningful component usage statistics and renders them as individual cards.
 */
export const ComponentView: React.FC<ComponentViewProps> = ({ pipelines: _pipelines, flowData }) => {
	// ============================================================================
	// DATA PROCESSING & MEMOIZATION
	// ============================================================================

	/**
	 * Component Usage Data Processing (Memoized)
	 * 
	 * This is the core business logic that transforms raw flowData.byPipe into
	 * component usage statistics. It's memoized for performance since this
	 * computation can be expensive with large datasets.
	 * 
	 * INPUT DATA STRUCTURE (flowData.byPipe):
	 * {
	 *   "pipeline-id-1": ["filename1.js", "component1", "component2", "component3"],
	 *   "pipeline-id-2": ["filename2.js", "component1", "component4"],
	 *   "pipeline-id-3": ["filename3.js", "component2", "component5"]
	 * }
	 * 
	 * PROCESSING LOGIC:
	 * 1. Each array represents a pipeline's stages
	 * 2. First element (index 0) is the filename/object identifier
	 * 3. Remaining elements (index 1+) are component names
	 * 4. Count how many pipelines use each component
	 * 5. Track which specific objects/files use each component
	 * 
	 * OUTPUT DATA STRUCTURE:
	 * {
	 *   "component1": { count: 2, objectNames: ["filename1.js", "filename2.js"] },
	 *   "component2": { count: 2, objectNames: ["filename1.js", "filename3.js"] },
	 *   "component3": { count: 1, objectNames: ["filename1.js"] },
	 *   ...
	 * }
	 * 
	 * PERFORMANCE CONSIDERATIONS:
	 * - Memoized to prevent unnecessary recalculations
	 * - Only recalculates when flowData changes
	 * - Efficient O(n*m) complexity where n=pipelines, m=average components per pipeline
	 */
	const componentData = useMemo(() => {
		// ====================================================================
		// INPUT VALIDATION
		// ====================================================================

		/**
		 * Early Return for Missing Data
		 * 
		 * If flowData or its byPipe property is missing, return empty object.
		 * This prevents errors and allows the component to handle loading states.
		 */
		if (!flowData || !flowData.byPipe) {
			return {};
		}

		// ====================================================================
		// DATA PROCESSING INITIALIZATION
		// ====================================================================

		/**
		 * Initialize Component Statistics Accumulator
		 * 
		 * This object will accumulate statistics for each component across
		 * all pipelines. Each component entry contains:
		 * - count: Number of pipelines using this component
		 * - objectNames: Array of object/file names using this component
		 */
		const data: Record<string, { count: number; objectNames: string[] }> = {};

		// ====================================================================
		// MAIN PROCESSING LOOP
		// ====================================================================

		/**
		 * Process Each Pipeline in byPipe Data
		 * 
		 * Iterates through all pipelines and extracts component usage information.
		 * Uses Object.entries to get both pipeline ID and pipeline data.
		 */
		Object.entries(flowData.byPipe).forEach(([_pipelineId, pipeline]) => {
			/**
			 * Extract Pipeline Components
			 * 
			 * CRITICAL ASSUMPTION: The data structure follows this pattern:
			 * - pipeline[0] = filename/object identifier
			 * - pipeline[1...n] = component names
			 * 
			 * This assumption is based on the current data format but could
			 * be fragile if the data structure changes.
			 */
			const filename = pipeline[0];           // First element is the object/file identifier
			const components = pipeline.slice(1);   // Remaining elements are component names

			/**
			 * Process Each Component in Current Pipeline
			 * 
			 * For each component found in this pipeline, update the global
			 * component statistics by incrementing usage count and adding
			 * the current filename to the list of objects using this component.
			 */
			components.forEach(component => {
				/**
				 * Initialize Component Entry if Not Exists
				 * 
				 * First time we encounter a component, create its entry
				 * in the statistics object with zero count and empty object list.
				 */
				if (!data[component]) {
					data[component] = {
						count: 0,
						objectNames: []
					};
				}

				/**
				 * Update Component Statistics
				 * 
				 * Increment the usage count and add the current filename
				 * to the list of objects using this component.
				 */
				data[component].count += 1;                          // Increment usage counter
				data[component].objectNames.push(filename);          // Add filename to usage list
			});
		});

		// Return the complete component statistics
		return data;
	}, [flowData]); // Dependency array: recalculate when flowData changes

	// ============================================================================
	// ERROR HANDLING & EDGE CASES
	// ============================================================================

	/**
	 * Handle Missing Flow Data
	 * 
	 * When flowData or byPipe is missing, show appropriate error message.
	 * This could happen during:
	 * - Initial component mount before data loads
	 * - Network errors preventing data fetch
	 * - Backend issues returning null/undefined data
	 */
	if (!flowData || !flowData.byPipe) {
		return (
			<div className="no-data">
				No component data available
			</div>
		);
	}

	/**
	 * Extract All Component Names
	 * 
	 * Get the list of all components found in the processed data.
	 * This will be used to determine if we have components to display
	 * and to iterate over them for rendering.
	 */
	const allComponents = Object.keys(componentData);

	/**
	 * Handle Empty Components Case
	 * 
	 * If no components were found in the data processing, show appropriate
	 * message. This could happen when:
	 * - All pipelines have only filenames but no components
	 * - Data structure doesn't match expected format
	 * - All components were filtered out for some reason
	 */
	if (allComponents.length === 0) {
		return (
			<div className="no-data">
				No components defined
			</div>
		);
	}

	// ============================================================================
	// MAIN RENDER LOGIC
	// ============================================================================

	/**
	 * Render Component Cards
	 * 
	 * For each component found in the processed data, render a ComponentCard
	 * with the computed statistics (count and object names).
	 * 
	 * Implementation Details:
	 * - Use component name as React key for efficient reconciliation
	 * - Pass all computed data (name, count, objectNames) to each card
	 * - Let ComponentCard handle its own rendering and styling logic
	 * - Use React Fragment to avoid unnecessary DOM wrapper
	 */
	return (
		<>
			{allComponents.map((componentName) => (
				<ComponentCard
					key={componentName}                                    // Unique key for React
					componentName={componentName}                          // Component identifier
					count={componentData[componentName].count}             // Usage count
					objectNames={componentData[componentName].objectNames} // Objects using this component
				/>
			))}
		</>
	);
};
