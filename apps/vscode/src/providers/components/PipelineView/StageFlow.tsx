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
 * Stage Flow Component
 * 
 * This component creates a visual representation of pipeline stages in sequential order,
 * showing the flow of execution from one stage to the next with visual indicators.
 * 
 * Visual Design Pattern:
 * [Stage 1] → [Stage 2] → [Stage 3] → [Stage 4 (Running)]
 * 
 * Key Features:
 * - Displays stages in execution order from left to right
 * - Adds flow arrows (→) between consecutive stages
 * - Highlights the last stage as "currently running"
 * - Handles empty stage scenarios gracefully
 * - Provides clear visual progression indicators
 * 
 * Design Philosophy:
 * - The last stage is assumed to be the currently executing stage
 * - Earlier stages are considered completed
 * - Flow arrows indicate the progression direction
 * - Consistent styling with badge-style stage indicators
 * 
 * @component
 * @param props - Component properties
 * @param props.stages - Array of stage names in execution order
 * @returns JSX.Element The rendered stage flow visualization
 * 
 * @example
 * ```tsx
 * // Basic usage with multiple stages
 * <StageFlow stages={['build', 'test', 'deploy']} />
 * // Renders: [build] → [test] → [deploy (running)]
 * 
 * // Single stage
 * <StageFlow stages={['compile']} />
 * // Renders: [compile (running)]
 * 
 * // Empty stages
 * <StageFlow stages={[]} />
 * // Renders: "No active stages" message
 * ```
 */
interface StageFlowProps {
    /** 
     * Array of stage names to display in sequential order
     * Each string represents a stage name that will be displayed as a badge
     * The order in the array determines the visual flow order
     */
    stages: string[];
}

/**
 * StageFlow Component Implementation
 * 
 * This functional component renders a horizontal flow of pipeline stages
 * with visual connectors and status indicators.
 */
export const StageFlow: React.FC<StageFlowProps> = ({ stages }) => {
    // ============================================================================
    // INPUT VALIDATION & EDGE CASES
    // ============================================================================
    
    /**
     * Handle Empty Stages
     * 
     * When no stages are provided, we show a clear message rather than
     * rendering nothing. This helps users understand the current state.
     * 
     * Why this matters:
     * - Prevents confusion when pipelines have no stages
     * - Provides clear feedback about the component state
     * - Maintains consistent user experience across empty states
     */
    if (stages.length === 0) {
        return (
            <div className="empty-stages">
                No active stages
            </div>
        );
    }

    // ============================================================================
    // MAIN RENDER LOGIC
    // ============================================================================

    /**
     * Render Stage Flow with Visual Connectors
     * 
     * Implementation Details:
     * 
     * 1. Each stage is rendered as a <span> with appropriate CSS classes
     * 2. Flow arrows (→) are inserted between stages (but not after the last one)
     * 3. The last stage gets special "running" styling to indicate current activity
     * 4. React.Fragment is used to group stage + arrow without extra DOM nodes
     * 
     * CSS Class Logic:
     * - All stages get the base "stage" class
     * - The last stage (index === stages.length - 1) gets additional "running" class
     * - Flow arrows get the "flow-arrow" class for consistent styling
     * 
     * Key Implementation Notes:
     * - Using index as React key is acceptable here since stages array is stable
     * - Fragment pattern prevents unnecessary wrapper elements
     * - Conditional arrow rendering prevents trailing arrow after last stage
     */
    return (
        <>
            {stages.map((stage, index) => {
                // Calculate if this is the last (currently running) stage
                const isLastStage = index === stages.length - 1;
                
                // Determine CSS classes for this stage
                const stageClasses = `stage ${isLastStage ? 'running' : ''}`;
                
                return (
                    <React.Fragment key={index}>
                        {/* 
                         * Stage Badge
                         * Each stage is rendered as a styled span element.
                         * The last stage gets special "running" styling to indicate
                         * it's the currently executing stage.
                         */}
                        <span className={stageClasses}>
                            {stage}
                        </span>
                        
                        {/* 
                         * Flow Arrow
                         * Arrows are rendered between stages to show progression.
                         * We don't render an arrow after the last stage since
                         * there's no next stage to point to.
                         * 
                         * Unicode Character: → (U+2192, RIGHT ARROW)
                         */}
                        {!isLastStage && (
                            <span className="flow-arrow">→</span>
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
};
