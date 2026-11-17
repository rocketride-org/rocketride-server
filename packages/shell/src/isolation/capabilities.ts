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

// PR2a-1 red-before stub: every export throws until the implementation lands.

export interface CapabilityRow {
	cap: string;
	op: string;
	command?: string;
	subcommand?: string;
	args: Record<string, string>;
	top?: string[];
}

export interface CapabilityTable {
	v: number;
	rows: CapabilityRow[];
}

/** Validates a table; an unknown type name throws. */
export function loadTable(_json: unknown): CapabilityTable {
	throw new Error('not implemented: loadTable');
}

/** The row for `(op, command?, subcommand?)`, or undefined. */
export function rowFor(_op: string, _command?: string, _subcommand?: string): CapabilityRow | undefined {
	throw new Error('not implemented: rowFor');
}
