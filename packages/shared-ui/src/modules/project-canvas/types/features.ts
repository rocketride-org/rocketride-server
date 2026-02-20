// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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

/**
 * Feature-flag interface controlling which toolbar buttons and capabilities
 * are visible in the Flow Controls component.
 *
 * Host applications (VS Code extension, web app, Storybook) can selectively
 * enable or disable features by passing a partial `FlowFeatures` object.
 */
export interface FlowFeatures {
	// Node operations
	addNode?: boolean;
	addAnnotation?: boolean;

	// View controls
	fitView?: boolean;
	zoomIn?: boolean;
	zoomOut?: boolean;
	lock?: boolean;

	// Actions
	undo?: boolean;
	redo?: boolean;

	// Shortcuts and UI
	keyboardShortcuts?: boolean;
	logs?: boolean;

	// File operations
	save?: boolean;
	saveAs?: boolean;
	importExport?: boolean;

	// Additional options
	moreOptions?: boolean;
}

/**
 * Default features configuration with all capabilities enabled.
 * Used as a fallback when the host does not supply a custom `FlowFeatures` object.
 */
export const DEFAULT_FLOW_FEATURES: FlowFeatures = {
	addNode: true,
	addAnnotation: true,
	fitView: true,
	zoomIn: true,
	zoomOut: true,
	lock: true,
	undo: true,
	redo: true,
	keyboardShortcuts: true,
	logs: true,
	save: true,
	saveAs: true,
	importExport: true,
	moreOptions: true,
};
