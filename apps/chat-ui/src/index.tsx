/**
 * MIT License
 *
 * Copyright (c) 2026 RocketRide, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Application Entry Point
 *
 * This is the main entry point for the RocketRide Chat application.
 * It initializes the React application and mounts it to the DOM.
 * 
 * Setup Process:
 * 1. Import React and ReactDOM
 * 2. Import root App component
 * 3. Import global styles
 * 4. Find root DOM element
 * 5. Create React root
 * 6. Render App in StrictMode
 * 
 * React StrictMode:
 * - Enables additional development checks
 * - Highlights potential problems
 * - Activates additional warnings
 * - Does not affect production builds
 * - May cause components to render twice in development
 * 
 * Error Handling:
 * - Throws if root element not found
 * - Prevents silent failure on missing DOM node
 * - Provides clear error message for debugging
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

/**
 * Get root DOM element
 * 
 * The root element is defined in index.html as:
 * <div id="dropper-root"></div>
 * 
 * This element serves as the mount point for the entire React application.
 */
const container = document.getElementById('chat-root');

/**
 * Validate root element exists
 * 
 * If the root element is not found, throw a descriptive error.
 * This prevents cryptic errors later in the initialization process.
 */
if (!container) {
	throw new Error('Root element not found');
}

/**
 * Create React root
 * 
 * Uses the new React 18+ createRoot API for concurrent features.
 * This replaces the legacy ReactDOM.render API.
 * 
 * Benefits of createRoot:
 * - Enables concurrent rendering
 * - Automatic batching of updates
 * - Transitions and suspense support
 * - Better error handling
 */
const root = createRoot(container);

/**
 * Render application
 * 
 * Wraps App in React.StrictMode for development-time checks.
 * StrictMode helps identify:
 * - Unsafe lifecycle methods
 * - Legacy string ref API usage
 * - Unexpected side effects
 * - Deprecated APIs
 * 
 * Note: StrictMode only runs in development and has no impact
 * on production builds.
 */
root.render(
	<React.StrictMode>
		<App />
	</React.StrictMode>
);

