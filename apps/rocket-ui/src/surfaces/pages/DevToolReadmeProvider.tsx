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
// DEV-TOOL README — the tool details page (`toolreadme:<appId>` document)
// =============================================================================
//
// This host's adapter for the shared ToolDetailsView: catalog facts off the
// server app manifest, pins off the workspace prefs, remove also discards
// the tool's open documents.
// =============================================================================

import React from 'react';
import type { CSSProperties } from 'react';
import { parseToolDocUri, useShellConnection } from 'shell';
import { ToolDetailsView } from 'shared/tools/core/chrome/ToolDetailsView';
import { useDevToolPins } from '../devtools/devToolPins';
import { getDocs } from '../../docs';

const missingStyle: CSSProperties = {
	padding: 40,
	textAlign: 'center',
	color: 'var(--rr-text-secondary)',
	fontSize: 13,
	fontFamily: 'var(--rr-font-family)',
};

/**
 * The dev-tool details page for one catalog entry.
 *
 * @param props.appId - The tool's app id (from the `toolreadme:` URI).
 */
const DevToolReadmeProvider: React.FC<{ appId: string }> = ({ appId }) => {
	const { isConnected } = useShellConnection();
	const { catalog, pins, pin, unpin } = useDevToolPins();

	// null = the catalog fetch has not resolved — loading, not missing.
	if (catalog === null) {
		return <div style={missingStyle}>Loading…</div>;
	}
	const tool = catalog.find((a) => a.id === appId);
	if (!tool) {
		return <div style={missingStyle}>This dev tool is not published on the connected server.</div>;
	}

	/** Unpin and close the tool's open frames — a removed tool keeps no
	    surface, per-document tabs included. */
	const handleRemove = (): void => {
		unpin(appId);
		const docs = getDocs();
		if (!docs) return;
		for (const uri of Object.keys(docs.getState().documents)) {
			if (parseToolDocUri(uri)?.appId === appId) docs.discardDocument(uri);
		}
	};

	return (
		<ToolDetailsView
			tool={{
				id: tool.id,
				name: tool.name,
				...(tool.publisher !== undefined ? { publisher: tool.publisher } : {}),
				...(tool.version !== undefined ? { version: tool.version } : {}),
				...(tool.description !== undefined ? { description: tool.description } : {}),
				...(tool.icon !== undefined ? { iconUrl: tool.icon } : {}),
				...(tool.readme !== undefined ? { readme: tool.readme } : {}),
			}}
			installed={pins.includes(appId)}
			connected={isConnected}
			onInstall={() => pin(appId)}
			onRemove={handleRemove}
		/>
	);
};

export default DevToolReadmeProvider;
