// Copyright (c) 2026 Aparavi Software AG Inc. MIT License.

import type { RJSFSchema } from '@rjsf/utils';

type Data = Record<string, unknown>;
export interface StoredArray {
	path: string[];
	sourcePath: string[];
}

function object(value: unknown): Data {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
}

function own(data: Data, key: string): unknown {
	return Object.hasOwn(data, key) ? data[key] : undefined;
}

/** Saved profile and schema names are data, including names such as __proto__. */
function setOwn(data: Data, key: string, value: unknown): void {
	Object.defineProperty(data, key, { value, enumerable: true, configurable: true, writable: true });
}

function secured(data: Data, key: string): boolean {
	const names = own(object(own(data, 'secureParameters')), 'secure');
	return Array.isArray(names) && names.includes(key);
}

/** Arrays stored in an opaque secureParameters blob must not become RJSF's default []. */
export function storedArrays(schema: RJSFSchema, data: Data, path: string[] = []): StoredArray[] {
	const result: StoredArray[] = [];
	const profileSchema = schema.properties?.profile;
	const profileDefault = typeof profileSchema === 'object' ? profileSchema.default : undefined;
	const profile = own(data, 'profile') ?? profileDefault ?? 'default';
	const inherited = typeof profile === 'string' ? object(own(data, profile)) : {};
	for (const [key, field] of Object.entries(schema.properties ?? {})) {
		if (typeof field !== 'object') continue;
		const fieldPath = [...path, key];
		if (field.type === 'array' && own(data, key) == null) {
			if (secured(data, key)) result.push({ path: fieldPath, sourcePath: path });
			else if (typeof profile === 'string' && own(inherited, key) == null && secured(inherited, key)) {
				result.push({ path: fieldPath, sourcePath: [...path, profile] });
			}
		} else if (field.type === 'object') {
			result.push(...storedArrays(field, object(own(data, key)), fieldPath));
		}
	}
	return result;
}

function at(data: Data, path: string[]): Data {
	return path.reduce((current, key) => object(own(current, key)), data);
}

function parent(data: Data, path: string[]): Data {
	let current = data;
	for (const key of path) {
		const child = { ...object(own(current, key)) };
		setOwn(current, key, child);
		current = child;
	}
	return current;
}

/** Remove generated defaults and retain the original encrypted containers byte for byte. */
export function preserveStoredArrays(changed: Data, original: Data, stored: StoredArray[]): Data {
	const result = { ...changed };
	for (const { path, sourcePath } of stored) {
		delete parent(result, path.slice(0, -1))[path[path.length - 1]];
		const source = at(original, sourcePath);
		const target = parent(result, sourcePath);
		setOwn(target, 'secureParameters', own(source, 'secureParameters'));
	}
	return result;
}

/** Backfill visible defaults without overriding arrays held in an encrypted profile. */
export function mergeFormDefaults(schema: RJSFSchema, defaults: Data, data: Data): Data {
	return preserveStoredArrays({ ...defaults, ...data }, data, storedArrays(schema, data));
}

/** An explicit replacement is an ordinary editable array and overrides the saved value. */
export function replaceStoredArray(data: Data, path: string[]): Data {
	const result = { ...data };
	setOwn(parent(result, path.slice(0, -1)), path[path.length - 1], []);
	return result;
}
