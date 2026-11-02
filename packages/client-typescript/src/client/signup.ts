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

import type { SignupProperties } from './types/signup.js';

const EXPOSURE_LIFETIME_MS = 30 * 60 * 1000;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,79}$/;
const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MESSAGE_REVISION_PATTERN = /^[a-f0-9]{16}$/;
const SIGNUP_PROPERTY_KEYS = ['schema_version', 'experiment', 'experiment_revision', 'variant_id', 'assignment_id', 'exposure_id', 'landing_message_revision', 'exposed_at', 'expires_at', 'consent_version'];

function hasExactKeys(properties: Record<string, unknown>): boolean {
	const keys = Object.keys(properties);
	if (keys.length !== SIGNUP_PROPERTY_KEYS.length) return false;
	return keys.every((key) => SIGNUP_PROPERTY_KEYS.includes(key));
}

function isSlug(value: unknown): value is string {
	return typeof value === 'string' && SLUG_PATTERN.test(value);
}

function isUuidV4(value: unknown): value is string {
	return typeof value === 'string' && UUID_V4_PATTERN.test(value);
}

function isLiveExposure(exposedAt: unknown, expiresAt: unknown, now: number): boolean {
	if (typeof exposedAt !== 'number') return false;
	if (!Number.isFinite(exposedAt)) return false;
	if (exposedAt > now) return false;
	if (expiresAt !== exposedAt + EXPOSURE_LIFETIME_MS) return false;
	return now < expiresAt;
}

/**
 * Validate transport context; the account service additionally checks its experiment/catalog.
 *
 * @param value - Untrusted signup properties to validate.
 * @param now - Current time in milliseconds since epoch, used for exposure expiry.
 * @returns A copy of the valid context, or null when its schema or exposure is invalid.
 */
export function normalizeSignupProperties(value: unknown, now = Date.now()): SignupProperties | null {
	try {
		if (!value) return null;
		if (typeof value !== 'object') return null;
		if (Array.isArray(value)) return null;
		const properties = value as Record<string, unknown>;
		if (!hasExactKeys(properties)) return null;
		if (properties.schema_version !== 1) return null;
		if (properties.consent_version !== 1) return null;
		if (!isSlug(properties.experiment)) return null;
		if (!isSlug(properties.experiment_revision)) return null;
		if (!isSlug(properties.variant_id)) return null;
		if (!isUuidV4(properties.assignment_id)) return null;
		if (!isUuidV4(properties.exposure_id)) return null;
		if (typeof properties.landing_message_revision !== 'string') return null;
		if (!MESSAGE_REVISION_PATTERN.test(properties.landing_message_revision)) return null;
		if (!isLiveExposure(properties.exposed_at, properties.expires_at, now)) return null;
		return { ...properties } as SignupProperties;
	} catch {
		// Unknown input can contain throwing getters or proxy traps.
		return null;
	}
}
