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

// =============================================================================
// CAPABILITY DENIED — the one error an isolated app sees for a refused op
// =============================================================================
//
// A leaf module with no imports, so `connection/errorWire.ts` can register it
// in `ERROR_CLASSES` without a cycle. The root builds the wire form itself
// (`denial.ts`); the guest rebuilds this class from it.
// =============================================================================

/** Why the gate refused (Appendix A, plus `quota`). */
export type DenyCode = 'capability' | 'ownership' | 'schema' | 'rate' | 'too_large' | 'namespace' | 'unknown_op' | 'credential' | 'quota';

/** Fields a denial may carry. Nothing else crosses to the app. */
export interface ICapabilityDeniedFields {
	code: DenyCode;
	op: string;
	command?: string;
	subcommand?: string;
	capability?: string;
}

/** A refused operation. */
export class CapabilityDeniedError extends Error {
	readonly code: DenyCode;
	readonly op: string;
	readonly command?: string;
	readonly subcommand?: string;
	readonly capability?: string;

	constructor(message: string, fields: ICapabilityDeniedFields) {
		super(message);
		this.name = 'CapabilityDeniedError';
		this.code = fields.code;
		this.op = fields.op;
		if (fields.command !== undefined) this.command = fields.command;
		if (fields.subcommand !== undefined) this.subcommand = fields.subcommand;
		if (fields.capability !== undefined) this.capability = fields.capability;
	}
}
