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

import { useState } from 'react';
import { IQueryBuilderData } from './types';

/**
 * Custom React hook that manages query builder state, including the list of query rows
 * and their validation status. Provides a controlled `onChange` handler that automatically
 * validates the data on every change. The query is considered valid when it has at least
 * one row and every row has a non-empty value.
 *
 * @param initalQueryData - Optional initial array of query row data to pre-populate the builder.
 * @returns An object containing:
 *   - `queryData` - The current array of query row data.
 *   - `setQueryData` - State setter for directly replacing query data.
 *   - `onChange` - Change handler that validates and updates query data.
 *   - `isValid` - Boolean indicating whether all query rows have non-empty values.
 */
export function useQueryBuilder(initalQueryData: IQueryBuilderData[] = []) {
	const [queryData, setQueryData] = useState<IQueryBuilderData[]>(initalQueryData);
	const [isValid, setIsValid] = useState<boolean>(false);

	/**
	 * Validates the query data by checking that at least one row exists and every row
	 * has a non-empty, defined, non-null value.
	 *
	 * @param data - The array of query rows to validate.
	 * @returns True if the query data is valid, false otherwise.
	 */
	const validate = (data: IQueryBuilderData[]) => {
		// An empty query (no rows) is considered invalid
		if (!data.length) {
			return false;
		}

		// Every row must have a populated value; any empty, undefined, or null
		// value makes the entire query invalid
		for (const d of data) {
			if (d.value === '' || d.value === undefined || d.value === null) {
				return false;
			}
		}

		return true;
	};

	/**
	 * Handles query data changes by re-validating and updating both the data and
	 * validation state. Should be passed as the `onChange` prop to the QueryBuilder component.
	 *
	 * @param data - The updated array of query row data.
	 */
	const onChange = (data: IQueryBuilderData[]) => {
		// Re-validate before updating state so isValid is always in sync with queryData
		setIsValid(validate(data));
		setQueryData(data);
	};

	return {
		queryData,
		setQueryData,
		onChange,
		isValid,
	};
}
