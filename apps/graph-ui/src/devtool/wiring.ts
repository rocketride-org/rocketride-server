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
// GRAPH-UI - DEV-TOOL WIRING (the ONE module that takes the protocol factories from 'shell')
// =============================================================================
//
// The sidebar peer keeps one live subscriber, so a channel or controller built
// anywhere else (a render, a view) would silently take the op server's calls.
// The shell's createToolChannel, createToolOpServer and createToolController
// are therefore imported HERE only (a source-reading test pins it with the
// base's findToolFactoryImports), and handed to the plain controller and frame
// functions, which never import them themselves.
// =============================================================================

import { createToolChannel, createToolController, createToolOpServer } from 'shell';

/** The protocol factories the sidebar controller is built with. */
export const CONTROLLER_PROTOCOL = { createToolChannel, createToolOpServer };

/** The protocol factories a frame is built with. */
export const FRAME_PROTOCOL = { createToolChannel, createToolController };

