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

// =============================================================================
// SANITIZED HTML → REACT — shared rich-text rendering helper
// =============================================================================
//
// Multi-consumer (canvas node headers, the service-config form's
// description fields): sanitize untrusted HTML and parse it to React, with
// anchors forced to open externally under safe rel attributes.
// =============================================================================

import { ReactNode } from 'react';
import DOMPurify from 'dompurify';
import parse, { DOMNode, Element as DOMElement, domToReact, HTMLReactParserOptions } from 'html-react-parser';

/**
 * Sanitizes a string that may contain HTML and parses it to React nodes.
 * Plain strings pass through untouched; anchors always open in a new tab
 * with `rel="noopener noreferrer"`.
 *
 * @param text - The possibly-HTML text.
 * @returns The original string, or parsed React nodes.
 */
export const sanitizeAndParseHtmlToReact = (text?: string): string | ReactNode => {
	if (!text) return text;

	let result: string | ReactNode = text;

	// Only run the expensive sanitize+parse path when the string actually contains HTML tags
	if (/<\/?[a-z][\s\S]*>/i.test(result as string)) {
		// Sanitize HTML to prevent XSS while preserving target/rel for external links
		const sanitized = DOMPurify.sanitize(result as string, {
			ADD_ATTR: ['target', 'rel'],
		});

		// Replace <a> tags so they always open in a new tab with safe rel attributes
		const options: HTMLReactParserOptions = {
			replace: (domNode: DOMNode) => {
				const el = domNode as DOMElement;
				if (el.name === 'a' && el.attribs?.href) {
					const { href, ...rest } = el.attribs;
					return (
						<a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
							{el.children ? parse(domToReact(el.children as DOMNode[]) as string) : null}
						</a>
					);
				}
				// Non-anchor nodes are left untouched by returning undefined.
				return undefined;
			},
		};

		result = parse(sanitized, options);
	}

	return result;
};
