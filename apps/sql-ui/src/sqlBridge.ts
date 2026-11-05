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
// SQL-UI — THE SHELL'S OP FACTORIES (the one module that imports them)
// =============================================================================
//
// The host builds each mount's channel (`DevToolProps.channel`) and is the
// only subscriber of the mount's peer. This app builds no channel: it asks the
// shell only for the op server (the controller, sqlController.ts) and the op
// client (each frame, sqlFrame.ts). Both are injected into the plain wiring
// functions, so tests run the same functions over the shell's real modules.
//
// The protocol itself (ops, state topics, events) is in ops.ts.
// =============================================================================

import { createToolOpClient, createToolOpServer } from 'shell';
import type { SqlFrameProtocol } from './sqlFrame';

/** The shell's real op server factory, for the controller's React mount. */
export const SQL_CONTROLLER_PROTOCOL = { createToolOpServer };

/** The shell's real op client factory, for each frame's React mount. */
export const SQL_FRAME_PROTOCOL: SqlFrameProtocol = { createToolOpClient };
