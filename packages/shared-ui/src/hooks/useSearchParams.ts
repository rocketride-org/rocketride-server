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

import { useCallback, useEffect, useState } from 'react';

/**
 * Custom hook that replicates react-router-dom's useSearchParams functionality
 * without importing react-router-dom. Uses native URLSearchParams and History API.
 *
 * @returns A tuple containing [searchParams, setSearchParams]
 * - searchParams: URLSearchParams object with current search parameters
 * - setSearchParams: Function to update search parameters
 */
export function useSearchParams(): [
	URLSearchParams,
	(
		params:
			| Record<string, string | null>
			| URLSearchParams
			| ((prev: URLSearchParams) => URLSearchParams)
	) => void,
] {
	// Initialize from the current URL on mount (lazy initializer runs once)
	const [searchParams, setSearchParamsState] = useState<URLSearchParams>(() => {
		return new URLSearchParams(window.location.search);
	});

	// Sync state when the user navigates with browser back/forward buttons,
	// which change the URL without our setter being called.
	useEffect(() => {
		const handlePopState = () => {
			setSearchParamsState(new URLSearchParams(window.location.search));
		};

		window.addEventListener('popstate', handlePopState);
		return () => window.removeEventListener('popstate', handlePopState);
	}, []);

	const setSearchParams = useCallback(
		(
			params:
				| Record<string, string | null>
				| URLSearchParams
				| ((prev: URLSearchParams) => URLSearchParams)
		) => {
			let newSearchParams: URLSearchParams;

			// Support three call signatures to match react-router-dom's API surface
			if (typeof params === 'function') {
				// Functional updater: receives current params and returns new ones
				newSearchParams = params(searchParams);
			} else if (params instanceof URLSearchParams) {
				// Direct replacement with a URLSearchParams instance
				newSearchParams = new URLSearchParams(params);
			} else {
				// Object form: merge into existing params; null values delete the key
				newSearchParams = new URLSearchParams(searchParams);

				Object.entries(params).forEach(([key, value]) => {
					if (value === null || value === undefined) {
						newSearchParams.delete(key);
					} else {
						newSearchParams.set(key, value);
					}
				});
			}

			// Push the new query string into the URL bar without a full page navigation
			const newUrl = new URL(window.location.href);
			newUrl.search = newSearchParams.toString();

			// replaceState (not pushState) to avoid polluting the history stack with every param change
			window.history.replaceState(null, '', newUrl.toString());

			setSearchParamsState(newSearchParams);
		},
		[searchParams]
	);

	return [searchParams, setSearchParams];
}
