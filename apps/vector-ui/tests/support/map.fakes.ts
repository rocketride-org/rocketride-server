// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MAP TEST SUPPORT: recording fakes of a WebGL1 context, a 2D context and a canvas
// =============================================================================

/** One recorded call. */
export interface ICall {
	name: string;
	args: unknown[];
}

/** A WebGL1 context that records every call; constants are distinct numbers. */
export interface IFakeGl {
	gl: WebGLRenderingContext;
	calls: ICall[];
	count(name: string): number;
	last(name: string): ICall | undefined;
}

/**
 * Build a fake WebGL1 context.
 *
 * @param pointRange - What ALIASED_POINT_SIZE_RANGE answers.
 * @returns The fake.
 */
export function fakeGl(pointRange: [number, number] = [1, 64]): IFakeGl {
	const calls: ICall[] = [];
	const constants = new Map<string, number>();
	let next = 0x9000;
	let objects = 0;
	const answers: Record<string, (...args: unknown[]) => unknown> = {
		createShader: () => ({ shader: ++objects }),
		createProgram: () => ({ program: ++objects }),
		createBuffer: () => ({ buffer: ++objects }),
		getShaderParameter: () => true,
		getProgramParameter: () => true,
		getShaderInfoLog: () => '',
		getProgramInfoLog: () => '',
		getAttribLocation: (_p, name) => ['a_position', 'a_colour', 'a_flags'].indexOf(name as string),
		getUniformLocation: (_p, name) => ({ uniform: name }),
		isContextLost: () => false,
		getExtension: () => null,
	};
	const gl = new Proxy({} as Record<string, unknown>, {
		get(_target, prop: string | symbol) {
			if (typeof prop !== 'string') return undefined;
			if (/^[A-Z][A-Z0-9_]*$/.test(prop)) {
				if (!constants.has(prop)) constants.set(prop, next++);
				return constants.get(prop);
			}
			if (prop === 'getParameter') {
				return (param: unknown) => {
					calls.push({ name: 'getParameter', args: [param] });
					return param === constants.get('ALIASED_POINT_SIZE_RANGE') ? new Float32Array(pointRange) : null;
				};
			}
			return (...args: unknown[]) => {
				calls.push({ name: prop, args });
				return answers[prop] ? answers[prop]!(...args) : undefined;
			};
		},
	}) as unknown as WebGLRenderingContext;
	return {
		gl,
		calls,
		count: (name) => calls.filter((c) => c.name === name).length,
		last: (name) => [...calls].reverse().find((c) => c.name === name),
	};
}

/** A 2D context that records path and draw calls. */
export interface IFake2d {
	ctx: CanvasRenderingContext2D;
	calls: ICall[];
	count(name: string): number;
	/** Values assigned to properties, in order. */
	sets: Array<[string, unknown]>;
}

/**
 * Build a fake 2D context.
 *
 * @returns The fake.
 */
export function fake2d(): IFake2d {
	const calls: ICall[] = [];
	const sets: Array<[string, unknown]> = [];
	const state: Record<string, unknown> = {};
	const ctx = new Proxy(state, {
		get(target, prop: string | symbol) {
			if (typeof prop !== 'string') return undefined;
			if (prop in target) return target[prop];
			return (...args: unknown[]) => {
				calls.push({ name: prop, args });
				return undefined;
			};
		},
		set(target, prop: string | symbol, value) {
			if (typeof prop === 'string') {
				target[prop] = value;
				sets.push([prop, value]);
			}
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
	return { ctx, calls, count: (name) => calls.filter((c) => c.name === name).length, sets };
}

/** A canvas element stand-in. */
export class FakeCanvas {
	width = 300;
	height = 150;
	style: Record<string, string> = {};
	listeners = new Map<string, Array<(event: unknown) => void>>();
	constructor(private readonly contexts: { webgl?: WebGLRenderingContext | null; '2d'?: CanvasRenderingContext2D | null }) {}
	getContext(kind: string): unknown {
		if (kind === 'webgl' || kind === 'experimental-webgl') return this.contexts.webgl ?? null;
		if (kind === '2d') return this.contexts['2d'] ?? null;
		return null;
	}
	addEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
	}
	dispatch(type: string): { prevented: boolean } {
		const event = { prevented: false, preventDefault() { this.prevented = true; } };
		for (const l of this.listeners.get(type) ?? []) l(event);
		return event;
	}
}
