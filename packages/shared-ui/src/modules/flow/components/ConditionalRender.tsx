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
 * ConditionalRender — Declarative conditional rendering helper.
 *
 * Replaces inline `{condition && <Component />}` and ternary patterns
 * with a readable JSX wrapper. Supports an optional fallback element
 * when the condition is false.
 *
 * @example
 * ```tsx
 * <ConditionalRender condition={hasLanes}>
 *     <NodeLanes ... />
 * </ConditionalRender>
 *
 * <ConditionalRender condition={isLoggedIn} fallback={<LoginPrompt />}>
 *     <Dashboard />
 * </ConditionalRender>
 * ```
 */

import { ReactElement, ReactNode } from 'react';

interface IConditionalRenderProps {
	/** When truthy, children are rendered; when falsy, fallback is rendered. */
	condition: unknown;
	/** Content to render when condition is truthy. */
	children: ReactNode;
	/** Content to render when condition is falsy. Defaults to null (render nothing). */
	fallback?: ReactNode;
}

export default function ConditionalRender({ condition, children, fallback = null }: IConditionalRenderProps): ReactElement | null {
	return (condition ? children : fallback) as ReactElement | null;
}
