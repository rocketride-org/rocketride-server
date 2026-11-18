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
// GRANTS — the kinds of action a user can always allow
// =============================================================================

/**
 * This file has no imports, so settings code in any realm, the VS Code
 * extension host included, can read the grants without pulling in the agent.
 * host.ts re-exports both.
 */

/**
 * The routine kinds a card can offer "Always allow" for, as data, so code that reads or compares every
 * grant loops over this list and a new kind needs no edit there. Publishing, submitting and removing
 * a deployment are never among them.
 */
export const GRANTS = ['schedules', 'deploymentToggles', 'appUse', 'fileDeletes', 'appDeploys', 'runStops', 'runRestarts', 'profilingStarts', 'profilingStops', 'templateSaves', 'templateDeletes', 'logSaves', 'sqlQueries'] as const;

/** One of GRANTS. */
export type Grant = (typeof GRANTS)[number];
