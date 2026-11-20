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
 * Whether the Agent surface ships in this build. Off until the agent has a
 * real backend: the transport in modules/agent/agent.ts is still a stub.
 *
 * Off hides every user-facing entry point: the builtin tool registration
 * (strip tab, Dev Tools row, pins), rocket-ui's rail container, the
 * empty-workspace Agent tab, and restored agent tabs. Saved sessions under
 * .agents/ are left on disk and reappear when this flips back on.
 *
 * Before flipping back on: any saved devToolPins list that lacks
 * builtin.agent (strips arranged while this was off, and lists the VS Code
 * host writes, which never include it) makes isEnabled() in
 * core/chrome/useToolStrip.tsx treat Agent as disabled. Add a one-time rule
 * there (missing builtin.agent = enabled) in the same change.
 */
export const AGENT_ENABLED = false;
