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
// shell — the runtime module apps bind to ('shell' on the MF share scope)
// =============================================================================
//
// THIN BY DESIGN: the entire public surface is delegated to api.ts, the
// SINGLE curation point the contract freeze compiles. Anything exported
// here explicitly would compete with the star (an explicit export shadows
// a star-exported name) — that is exactly how the runtime module once
// served a different ConfirmDialog than the frozen contract promised.
// Do NOT add surface members here; add them to api.ts.

export * from './api';

// The ONE deliberate extra: the live shell-api version. It must NEVER
// enter the frozen surface (freezing the version number would make every
// freeze self-invalidating), so it lives outside api.ts by construction.
export { SHELL_API_VERSION } from './apiver';
