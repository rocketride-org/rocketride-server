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
// TOOLS — the builtin intro-page CATALOG (host-safe aggregate)
// =============================================================================
//
// Each tool SHIPS its own introduction content (tools/<tool>/intro.ts);
// this aggregate exists for the hosts' generic viewers (including the VS
// Code extension host, which cannot execute the JSX registry). No page
// content lives here.
// =============================================================================

import { INTRO_TITLE as AGENT_TITLE, INTRO_HTML as AGENT_HTML } from './agent/intro';
import { INTRO_TITLE as APPS_TITLE, INTRO_HTML as APPS_HTML } from './appdev/intro';
import { INTRO_TITLE as NODES_TITLE, INTRO_HTML as NODES_HTML } from './nodes/intro';
import { INTRO_TITLE as PIPES_TITLE, INTRO_HTML as PIPES_HTML } from './pipelines/intro';

/** The sidebar modes / builtin tools that carry an introduction page. */
export type IntroMode = 'agent' | 'apps' | 'nodes' | 'pipelines';

/** One introduction page. */
export interface IntroPage {
	/** Tab / panel title. */
	title: string;
	/** The complete standalone HTML document. */
	html: string;
}

/** The introduction pages, keyed by sidebar mode / tool id. */
export const INTRO_PAGES: Record<IntroMode, IntroPage> = {
	agent: { title: AGENT_TITLE, html: AGENT_HTML },
	apps: { title: APPS_TITLE, html: APPS_HTML },
	nodes: { title: NODES_TITLE, html: NODES_HTML },
	pipelines: { title: PIPES_TITLE, html: PIPES_HTML },
};
