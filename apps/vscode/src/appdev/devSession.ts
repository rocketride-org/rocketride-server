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

/**
 * The extension host's dev-session identity — one random nonce per host
 * lifetime, minted at module load.
 *
 * The dev overlay holds one registration PER EDITOR SESSION (several
 * editors may dev-serve the same app concurrently); this nonce is how a
 * preview finds the right one. It rides every register_dev call (the
 * server stamps it onto this host's overlay entries) and every preview
 * URL this host launches (`?rrsession=`), so a preview opened FROM this
 * editor resolves THIS editor's dev server rather than whichever editor
 * registered last.
 */

import { randomUUID } from 'crypto';

/** This extension host's dev-session nonce (stable for the host's lifetime). */
export const DEV_SESSION_NONCE = randomUUID();
