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

/**
 * A recursive dictionary type representing a nested object where leaf values
 * are strings, numbers, or booleans. Used as the data source for template
 * placeholder resolution.
 */
type RecursiveDict = {
	[key: string]: string | number | boolean | RecursiveDict;
};

/**
 * Extracts text and placeholders from a given string.
 *
 * @param str - The input string containing placeholders in the form of ${...}.
 * @returns An array of strings, where plain text and placeholders are separate elements.
 */
function getFields(str: string): string[] {
	const fields: string[] = []; // Array to store extracted text and placeholders
	let pos = 0; // Current position in the string

	// Iterate through the string to find placeholders
	while (pos < str.length) {
		const start = str.indexOf('${', pos); // Locate the next placeholder
		if (start === -1) {
			fields.push(str.substring(pos)); // No more placeholders, add remaining text
			break;
		}

		// Add the text before the placeholder if there is any
		if (start > pos) {
			fields.push(str.substring(pos, start)); // Store plain text
		}

		// Find the matching closing '}' while handling nested placeholders
		let end = start + 2; // Skip '${'
		let braceCount = 1; // Track nesting level of placeholders

		while (end < str.length && braceCount > 0) {
			if (str[end] === '{') braceCount++; // Increment if nested '{' is found
			if (str[end] === '}') braceCount--; // Decrement when '}' is found
			end++;
		}

		// Extract and add the full placeholder
		if (braceCount === 0) {
			fields.push(str.substring(start, end)); // Store the placeholder
			pos = end; // Move past the placeholder
		} else {
			throw new Error('Unmatched ${ found in string'); // Error for unmatched placeholders
		}
	}

	return fields; // Return extracted fields
}

/**
 * Resolves placeholders in a string by replacing them with corresponding values from an object.
 *
 * @param obj - The object containing values for the placeholders.
 * @param str - The input string with placeholders.
 * @returns A new string with all placeholders replaced by their resolved values.
 */
export function resolveDynamicString(root: RecursiveDict, str: string): string {
	let obj: RecursiveDict | undefined = root; // Initialize the object to the root
	let result = ''; // Stores the final resolved string
	const fields: string[] = getFields(str); // Extract fields from the string

	function moveTo(key: string): void {
		if (!obj || obj[key] === undefined) obj = undefined;
		else obj = obj[key] as RecursiveDict;
	}

	// Process each field
	for (const field of fields) {
		obj = root; // Reset object to root for each field
		// If it's plain text, append it directly
		if (!field.startsWith('${')) {
			result += field;
			continue; // Move to next field
		}

		// Remove '${' and '}' to get the key path inside the placeholder
		const value = field.substring(2, field.length - 1);

		// We have a path and a default if it isnt valid
		const control = value.split('|');
		const path = getFields(control[0]); // Extract possible nested placeholders

		// Resolve nested placeholders by iterating through extracted paths
		for (let subfield of path) {
			let key: string;

			if (subfield === '.') continue; // Ignore standalone dots

			// If it's a direct key, clean up dots
			if (!subfield.startsWith('${')) {
				if (subfield.startsWith('.')) subfield = subfield.substring(1); // Remove leading dot
				if (subfield.endsWith('.')) subfield = subfield.substring(0, subfield.length - 1); // Remove trailing dot

				// This may be "remote.provider"
				const comps = subfield.split('.');
				for (const comp of comps) {
					moveTo(comp);
				}
			} else {
				// Resolve nested placeholders by retrieving values from the object
				key = subfield.substring(2, subfield.length - 1);

				// Move to the value specified by the key
				if (obj && obj[key] !== undefined) {
					moveTo(obj[key] as string);
				}
			}
		}

		// Do we have a valid mapping
		if (obj) {
			// Yes, add it
			result += obj;
		} else {
			// Nope, if there was a default specified, add it
			if (control.length > 1) {
				result += control[1];
			}
		}
	}

	// Return the fully resolved string
	return result;
}
