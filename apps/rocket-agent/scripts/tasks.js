// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.
// =============================================================================

// Registers apps/rocket-agent with the builder's module registry so its
// co-located docs/ tree (Task 5.2d's opencode-version-bumps.md and future
// service docs) is picked up by `docs:gather` instead of failing the build
// as an unmounted docs/ tree (packages/docs/scripts/lib/gather.js). Mounted
// under the public-docs `canvas-agent` spine slot (packages/docs/scripts/lib/spine.js),
// alongside the product page at packages/docs/content-static/canvas-agent.md —
// this service currently has no other build actions registered here.
module.exports = {
	name: 'rocket-agent',
	description: 'Hosted OpenCode coding-agent session service backing the Canvas Agent',
	docs: [{ source: 'docs', mount: 'canvas-agent' }],
};
