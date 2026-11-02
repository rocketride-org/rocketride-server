/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** Optional analytics context only; never used for authorization or account identity. */
export type SignupProperties = {
	schema_version: 1;
	experiment: string;
	experiment_revision: string;
	variant_id: string;
	assignment_id: string;
	exposure_id: string;
	landing_message_revision: string;
	exposed_at: number;
	expires_at: number;
	consent_version: 1;
};

/** PKCE exchange credentials with optional, consent-aware signup analytics context. */
export type PkceCredential = {
	code: string;
	verifier: string;
	redirectUri: string;
	/** Evaluated immediately before auth is sent; null or a thrown error omits attribution. */
	signupProperties?: SignupProperties | (() => SignupProperties | null);
};
