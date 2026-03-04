// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

import { useCallback } from 'react';
import { Node } from '@xyflow/react';
import { useFlow } from '../../../FlowContext';

/**
 * Hook that provides a handler for running the data pipeline from a keyboard shortcut.
 * If any source nodes are currently selected, only those sources are executed;
 * otherwise all source nodes in the canvas are executed. This allows users to either
 * run the full pipeline or selectively trigger specific source branches.
 *
 * @returns A memoized callback that triggers pipeline execution for the relevant source nodes.
 */
export function useRunPipeline() {
	const { nodes, runPipeline } = useFlow();

	const runPipelineHandler = useCallback(() => {
		// Identify all source-type nodes (entry points that drive pipeline execution)
		const sourceNodes = nodes.filter(
			(node: Node) =>
				Array.isArray(node.data?.classType) && node.data.classType.includes('source')
		);

		// Narrow to only the sources the user has explicitly selected
		const selectedSourceNodes = sourceNodes.filter((node: Node) => node.selected);

		if (selectedSourceNodes.length) {
			// Run only the selected sources, allowing partial pipeline execution
			selectedSourceNodes.forEach((node: Node) => {
				runPipeline(node.id);
			});
		} else {
			// No sources selected: fall back to running all sources (full pipeline)
			sourceNodes.forEach((node: Node) => {
				runPipeline(node.id);
			});
		}
	}, [nodes, runPipeline]);

	return runPipelineHandler;
}
