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
// APPDEV FRAMES — this host's bodies for the apps tool's documents
// =============================================================================
//
// The apps TOOL owns the document identities (tool:apps/newapp,
// tool:apps/<appId>); this module supplies the host-adapted internals
// behind them (the ToolContext `appdevFrames` seam): the in-page App
// Builder adapter and the scaffold-backed New App wizard.
// =============================================================================

import React from 'react';
import type { BuiltinToolServices } from 'shared/tools/core';
import AppBuilderProvider from '../AppBuilderProvider';
import NewAppProvider from '../../pages/NewAppProvider';

/** The App Builder screen for one app (the tool passes the docKey). */
const Builder: React.FC<{ appId: string }> = ({ appId }) => <AppBuilderProvider uri={`app:${appId}`} />;

/** This host's appdevFrames seam value (module-stable identity). */
export const appdevFrames: NonNullable<BuiltinToolServices['appdevFrames']> = {
	builder: Builder,
	newApp: NewAppProvider,
};
