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
// APPS TOOL — FRAME (routes the tool's documents to the host's frame bodies)
// =============================================================================
//
// The apps tool OWNS its document identities: `tool:apps/newapp` is the
// New App wizard, `tool:apps/<appId>` an App Builder screen. The builder
// and wizard INTERNALS are host adapters today (the appdevFrames seam);
// this frame contributes the routing, so no host carries `app:*`/`newapp`
// special cases in its document ladder.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import type { DevToolProps } from 'shell';
import { useToolHost } from '../core/ToolContext';

const emptyStyle: CSSProperties = {
	flex: 1,
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	color: 'var(--rr-text-secondary)',
	fontSize: 13,
	fontFamily: 'var(--rr-font-family)',
};

/** The apps tool's frame: one document per app, plus the wizard. */
export const AppsToolFrame: React.FC<DevToolProps> = ({ docKey }) => {
	const services = useToolHost();
	const frames = services.appdevFrames;
	if (!frames) return <div style={emptyStyle}>This host does not serve App Builder documents.</div>;
	if (docKey === 'newapp') {
		const NewApp = frames.newApp;
		return <NewApp />;
	}
	if (docKey) {
		const Builder = frames.builder;
		return <Builder appId={docKey} />;
	}
	return <div style={emptyStyle}>Open an app from the Apps sidebar.</div>;
};
