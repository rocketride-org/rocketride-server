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
import ReactDOM from 'react-dom';

// ============================================================================
// GLOBAL REACT SETUP
// ============================================================================

/**
 * Global React Availability
 * 
 * Makes React and ReactDOM available globally for development contexts
 * and debugging. This ensures compatibility with various development
 * environments and testing scenarios.
 */
(window as unknown as Record<string, unknown>).React = React;
(window as unknown as Record<string, unknown>).ReactDOM = ReactDOM;

// ============================================================================
// UNIVERSAL COMPONENT MOUNTING UTILITY
// ============================================================================

/**
 * Universal component mounting utility for VS Code webviews
 * 
 * Provides a standardized way to mount React components in VS Code webview
 * environments with proper error handling, DOM ready detection, and
 * TypeScript support for props.
 * 
 * Features:
 * - Type-safe props support with generics
 * - DOM ready state detection and handling
 * - Comprehensive error handling and logging
 * - Consistent mounting behavior across components
 * - Development-friendly debugging output
 * 
 * @param component - React component class or function component to mount
 * @param componentName - Human-readable name for logging and debugging
 * @param props - Optional props object to pass to the component
 * 
 * @template T - TypeScript generic for component props type inference
 * 
 * @example
 * ```typescript
 * // Mount component without props
 * mountComponent(SidebarStatus, 'SidebarStatus');
 * 
 * // Mount component with props
 * interface MyProps {
 *   title: string;
 *   count: number;
 * }
 * 
 * mountComponent<MyProps>(
 *   MyComponent,
 *   'MyComponent', 
 *   { title: 'Hello', count: 42 }
 * );
 * ```
 */
export function mountComponent<T = {}>(
	component: React.ComponentType<T>,
	componentName: string = 'Component',
	props?: T
) {
	/**
	 * Internal Mount Function
	 * 
	 * Handles the actual component mounting process with proper error
	 * handling and logging. This function is called once the DOM is ready.
	 * 
	 * Process:
	 * 1. Locate the root DOM element
	 * 2. Render component using React 17 API
	 * 3. Render component with props (if provided)
	 * 4. Log success or handle errors gracefully
	 */
	function mount() {
		const rootElement = document.getElementById('root');

		if (rootElement) {
			try {
				// Use React 17 API for rendering
				ReactDOM.render(React.createElement(component as React.ComponentType<Record<string, unknown>>, props), rootElement);
			} catch (error) {
				console.error(`Error mounting ${componentName}:`, error);
			}
		} else {
			console.error(`Root element not found - ${componentName} cannot be mounted`);
		}
	}

	// ========================================================================
	// DOM READY STATE HANDLING
	// ========================================================================

	/**
	 * Smart DOM Ready Detection
	 * 
	 * Handles different DOM ready states to ensure reliable component mounting:
	 * - If DOM is still loading: Wait for DOMContentLoaded event
	 * - If DOM is ready: Mount immediately with small delay for initialization
	 * 
	 * The small timeout ensures that any VS Code webview initialization
	 * has completed before attempting to mount the component.
	 */
	if (document.readyState === 'loading') {
		// DOM is still loading - wait for DOMContentLoaded
		document.addEventListener('DOMContentLoaded', mount);
	} else {
		// DOM is already ready - mount with small delay for initialization
		setTimeout(mount, 100);
	}
}
