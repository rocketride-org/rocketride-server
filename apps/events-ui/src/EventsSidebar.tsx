// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EVENTS-UI — SIDEBAR (frame-only)
// =============================================================================
//
// The Event Monitor has no sidebar navigation of its own — its run controls
// live in the Capture card. But registering this component in the descriptor's
// `components.Sidebar` slot makes the shell draw its Header (brand mark) and
// Footer (user card / settings) frame around an EMPTY content area, keeping the
// platform chrome present. Returning null leaves the middle slot empty.
// =============================================================================

import type React from 'react';
import type { ShellSidebarProps } from 'shell';

/**
 * Frame-only sidebar for the Event Monitor.
 *
 * Renders no content of its own; its presence in the descriptor is what makes
 * the shell render the branded Header/Footer sidebar frame with an empty middle.
 *
 * @param _props - Injected shell sidebar props (collapse state); unused.
 * @returns null (no sidebar content).
 */
const EventsSidebar: React.FC<ShellSidebarProps> = (_props) => null;

export default EventsSidebar;
