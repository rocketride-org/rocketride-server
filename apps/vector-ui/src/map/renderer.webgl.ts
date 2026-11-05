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
// MAP - WEBGL1 POINT RENDERER
// =============================================================================
//
// One gl.POINTS draw for the whole sample: positions (x,y,z; z = 0 in 2D),
// RGBA bytes and a flags byte per point, uploaded only when the points change;
// a frame sets the view matrix and the point size and draws. Round sprites come
// from gl_PointCoord with a discard, so no texture is needed.
//
// Browser rules it follows (the canonical floor is Safari 13):
//   - WebGL1 only, GLSL ES 1.00 (no `#version 300 es`, no WebGL2 calls);
//   - point sizes clamped to ALIASED_POINT_SIZE_RANGE (some GPUs stop at 64 px);
//   - the canvas is never sized 0x0 (a hidden tab measures 0) and follows
//     devicePixelRatio;
//   - `webglcontextlost` is prevented (so the browser may restore it) and stops
//     drawing; `webglcontextrestored` rebuilds the program and buffers from the
//     last points and asks for a redraw.
//   - `preserveDrawingBuffer` stays false (faster), so the canvas may be cleared
//     once a frame is presented: `snapshot` (the map's PNG) draws the last frame
//     again and copies the canvas into the target in the same task, before the
//     browser can clear it.
//
// Flags: bit 1 outlined (1 px outline in --rr-text-primary), bit 2 hidden (a
// removed document's point: not drawn), bit 4 hollow (a ring in the point's
// colour), bit 8 emphasised (drawn larger, outlined), bit 16 dimmed.
//
// Dimming (a hovered cluster, a selection, a highlighted set: the rest fade):
// a dimmed point's colour is mixed toward the map's surface, keeping DIM of
// it, and stays OPAQUE (no blending, so nothing depends on draw order through
// alpha). The dimmed bits come from setDimmed and only the flags buffer is
// uploaded again. With any point dimmed a frame is two draws: the dimmed
// points first, then the rest over them (u_pass culls the other set in the
// vertex shader), so a faded point never covers a lit one. With none dimmed
// it is the one draw it always was.
// =============================================================================

/** Flag bits of a point. */
export const FLAG = { outlined: 1, hidden: 2, hollow: 4, emphasised: 8, dimmed: 16 } as const;

/** How much of its colour a dimmed point keeps (the rest is the surface). */
export const DIM = 0.25;

/** The u_pass values: every point, the dimmed ones only, the lit ones only. */
export const PASS = { all: 0, dimmed: 1, lit: 2 } as const;

/** Points ready for a renderer. */
export interface IPointData {
	count: number;
	/** x,y,z per point. */
	positions: Float32Array;
	/** RGBA bytes per point. */
	rgba: Uint8Array;
	/** One flags byte per point. */
	flags: Uint8Array;
}

/** What {@link packPoints} combines. */
export interface IPackInput {
	positions: Float32Array;
	dims: 2 | 3;
	rgba: Uint8Array;
	outlined: Uint8Array | null;
	hidden: Uint8Array | null;
	emphasised: Uint8Array | null;
	hollow: Uint8Array | null;
}

/** One frame's view. */
export interface IRenderFrame {
	/** From camera.viewMatrix. */
	matrix: Float32Array;
	/** Point diameter in CSS pixels. */
	pointSizePx: number;
	dpr: number;
}

/** A point renderer (WebGL1, or the Canvas2D fallback). */
export interface IPointRenderer {
	readonly kind: 'webgl' | 'canvas2d';
	/** True while the WebGL context is lost (nothing is drawn). */
	readonly lost: boolean;
	/** Device-pixel point sizes the GPU can draw. */
	readonly pointSizeRange: [number, number];
	resize(widthCss: number, heightCss: number, dpr: number): void;
	/** Replace the points; `outline` is the outline colour, 0-1 per channel. Dimmed bits set before are kept when the count matches. */
	setPoints(data: IPointData, outline: [number, number, number]): void;
	/**
	 * Dim points: 1 per dimmed point (null: none), mixed toward `surface` (0-1 per channel). Only the flags are
	 * uploaded again. Returns how many shown points are dimmed.
	 */
	setDimmed(mask: Uint8Array | null, surface: [number, number, number]): number;
	render(frame: IRenderFrame): void;
	/**
	 * Draw the last frame again and copy it into `target` (at the canvas's backing size, top left), in the
	 * same task. False when there is nothing to copy (no frame drawn yet, or the WebGL context is lost).
	 */
	snapshot(target: CanvasRenderingContext2D): boolean;
	destroy(): void;
}

/**
 * Combine positions, colours and masks into renderer data.
 *
 * @param input - Columns.
 * @returns x,y,z positions, RGBA and flags.
 */
export function packPoints(input: IPackInput): IPointData {
	const count = Math.floor(input.positions.length / input.dims);
	const positions = new Float32Array(count * 3);
	const flags = new Uint8Array(count);
	for (let i = 0; i < count; i += 1) {
		positions[3 * i] = input.positions[i * input.dims] as number;
		positions[3 * i + 1] = input.positions[i * input.dims + 1] as number;
		positions[3 * i + 2] = input.dims === 3 ? (input.positions[i * 3 + 2] as number) : 0;
		let f = 0;
		if (input.outlined && input.outlined[i]) f |= FLAG.outlined;
		if (input.hidden && input.hidden[i]) f |= FLAG.hidden;
		if (input.hollow && input.hollow[i]) f |= FLAG.hollow;
		if (input.emphasised && input.emphasised[i]) f |= FLAG.emphasised;
		flags[i] = f;
	}
	const rgba = input.rgba.length >= count * 4 ? input.rgba.subarray(0, count * 4) : new Uint8Array(count * 4);
	return { count, positions, rgba, flags };
}

/**
 * A points' flags with the dimmed bit set from a mask (hidden points are never counted).
 *
 * @param base - The flags from packPoints (no dimmed bit).
 * @param mask - 1 per dimmed point, or null; a mask of another length dims nothing.
 * @returns The merged flags and how many shown points are dimmed.
 */
export function dimFlags(base: Uint8Array, mask: Uint8Array | null): { flags: Uint8Array; dimmed: number } {
	if (mask === null || mask.length !== base.length) return { flags: base, dimmed: 0 };
	const flags = new Uint8Array(base.length);
	let dimmed = 0;
	for (let i = 0; i < base.length; i += 1) {
		const f = (base[i] as number) & ~FLAG.dimmed;
		if (mask[i] && (f & FLAG.hidden) === 0) {
			flags[i] = f | FLAG.dimmed;
			dimmed += 1;
		} else flags[i] = f;
	}
	return { flags, dimmed };
}

/**
 * Size a canvas's backing store for its CSS size and devicePixelRatio, never 0x0.
 *
 * @param canvas - The canvas.
 * @param widthCss - CSS width.
 * @param heightCss - CSS height.
 * @param dpr - devicePixelRatio.
 */
export function sizeCanvas(canvas: HTMLCanvasElement, widthCss: number, heightCss: number, dpr: number): void {
	const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	const w = Math.max(1, Math.round(Math.max(0, widthCss) * ratio));
	const h = Math.max(1, Math.round(Math.max(0, heightCss) * ratio));
	if (canvas.width !== w) canvas.width = w;
	if (canvas.height !== h) canvas.height = h;
	canvas.style.width = `${Math.max(0, widthCss)}px`;
	canvas.style.height = `${Math.max(0, heightCss)}px`;
}

/** The vertex shader (GLSL ES 1.00). */
export const VERTEX_SHADER = `precision mediump float;
attribute vec3 a_position;
attribute vec4 a_colour;
attribute float a_flags;
uniform mat4 u_matrix;
uniform float u_size;
uniform float u_minSize;
uniform float u_maxSize;
uniform float u_pass;
varying vec4 v_colour;
varying float v_flags;
varying float v_size;
float bit(float flags, float b) { return mod(floor(flags / b), 2.0); }
void main() {
	v_colour = a_colour;
	v_flags = a_flags;
	float dimmed = bit(a_flags, 16.0);
	bool culled = (u_pass > 0.5 && u_pass < 1.5 && dimmed < 0.5) || (u_pass > 1.5 && dimmed > 0.5);
	if (bit(a_flags, 2.0) > 0.5 || culled) {
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
		gl_PointSize = 0.0;
		v_size = 0.0;
		return;
	}
	gl_Position = u_matrix * vec4(a_position, 1.0);
	float size = clamp(u_size * (bit(a_flags, 8.0) > 0.5 ? 1.6 : 1.0), u_minSize, u_maxSize);
	gl_PointSize = size;
	v_size = size;
}
`;

/** The fragment shader: round sprite, optional outline ring, hollow ring; a dimmed point mixed toward the surface, opaque. */
export const FRAGMENT_SHADER = `precision mediump float;
uniform vec3 u_outline;
uniform vec3 u_surface;
uniform float u_dim;
uniform float u_dpr;
varying vec4 v_colour;
varying float v_flags;
varying float v_size;
float bit(float flags, float b) { return mod(floor(flags / b), 2.0); }
void main() {
	vec2 c = gl_PointCoord - vec2(0.5);
	float edge = v_size * 0.5;
	float r = length(c) * v_size;
	if (r > edge) discard;
	vec3 rgb = v_colour.rgb;
	if (bit(v_flags, 4.0) > 0.5) {
		if (r < edge - 2.0 * u_dpr) discard;
	} else if ((bit(v_flags, 1.0) > 0.5 || bit(v_flags, 8.0) > 0.5) && r > edge - u_dpr) {
		rgb = u_outline;
	}
	if (bit(v_flags, 16.0) > 0.5) rgb = mix(u_surface, rgb, u_dim);
	gl_FragColor = vec4(rgb, 1.0);
}
`;

/** The GL objects of one context generation. */
interface IGlState {
	program: WebGLProgram;
	position: WebGLBuffer;
	colour: WebGLBuffer;
	flags: WebGLBuffer;
	attrib: { position: number; colour: number; flags: number };
	uniform: { matrix: WebGLUniformLocation | null; size: WebGLUniformLocation | null; minSize: WebGLUniformLocation | null; maxSize: WebGLUniformLocation | null; outline: WebGLUniformLocation | null; dpr: WebGLUniformLocation | null; surface: WebGLUniformLocation | null; dim: WebGLUniformLocation | null; pass: WebGLUniformLocation | null };
}

/**
 * Compile and link the program and create the buffers.
 *
 * @param gl - The context.
 * @returns The state, or null when compiling failed.
 */
function initGl(gl: WebGLRenderingContext): IGlState | null {
	const compile = (type: number, source: string): WebGLShader | null => {
		const shader = gl.createShader(type);
		if (!shader) return null;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
	};
	const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
	const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
	const program = gl.createProgram();
	if (!vs || !fs || !program) return null;
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
	const position = gl.createBuffer();
	const colour = gl.createBuffer();
	const flags = gl.createBuffer();
	if (!position || !colour || !flags) return null;
	return {
		program,
		position,
		colour,
		flags,
		attrib: { position: gl.getAttribLocation(program, 'a_position'), colour: gl.getAttribLocation(program, 'a_colour'), flags: gl.getAttribLocation(program, 'a_flags') },
		uniform: {
			matrix: gl.getUniformLocation(program, 'u_matrix'),
			size: gl.getUniformLocation(program, 'u_size'),
			minSize: gl.getUniformLocation(program, 'u_minSize'),
			maxSize: gl.getUniformLocation(program, 'u_maxSize'),
			outline: gl.getUniformLocation(program, 'u_outline'),
			dpr: gl.getUniformLocation(program, 'u_dpr'),
			surface: gl.getUniformLocation(program, 'u_surface'),
			dim: gl.getUniformLocation(program, 'u_dim'),
			pass: gl.getUniformLocation(program, 'u_pass'),
		},
	};
}

/**
 * Create the WebGL1 renderer on a canvas.
 *
 * @param canvas - The canvas (exclusively this renderer's).
 * @param onRestored - Called after a lost context was restored and rebuilt (redraw then).
 * @returns The renderer, or null when WebGL1 is not available (use the Canvas2D one).
 */
export function createWebglRenderer(canvas: HTMLCanvasElement, onRestored: () => void): IPointRenderer | null {
	const attributes: WebGLContextAttributes = { alpha: true, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false, depth: false };
	const context = (canvas.getContext('webgl', attributes) ?? canvas.getContext('experimental-webgl', attributes)) as WebGLRenderingContext | null;
	if (!context) return null;
	const gl: WebGLRenderingContext = context;
	let state = initGl(gl);
	if (state === null) return null;
	const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as ArrayLike<number> | null;
	const pointSizeRange: [number, number] = range && range.length >= 2 ? [Number(range[0]) || 1, Number(range[1]) || 64] : [1, 64];
	let data: IPointData | null = null;
	let outline: [number, number, number] = [0, 0, 0];
	let surface: [number, number, number] = [1, 1, 1];
	// The dimmed mask is kept apart from the points, so new points keep it and a restored context gets it back.
	let mask: Uint8Array | null = null;
	let flags: Uint8Array = new Uint8Array(0);
	let dimmed = 0;
	let lost = false;
	let dpr = 1;
	let lastFrame: IRenderFrame | null = null;

	/** Merge the dimmed bits into the points' flags. */
	function merge(): void {
		const merged = data === null ? { flags: new Uint8Array(0), dimmed: 0 } : dimFlags(data.flags, mask);
		flags = merged.flags;
		dimmed = merged.dimmed;
	}

	/** Upload the flags (the only buffer dimming changes). */
	function uploadFlags(): void {
		if (state === null || data === null) return;
		gl.bindBuffer(gl.ARRAY_BUFFER, state.flags);
		gl.bufferData(gl.ARRAY_BUFFER, flags, gl.STATIC_DRAW);
	}

	/** Upload the current points. */
	function upload(): void {
		if (state === null || data === null) return;
		gl.bindBuffer(gl.ARRAY_BUFFER, state.position);
		gl.bufferData(gl.ARRAY_BUFFER, data.positions, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, state.colour);
		gl.bufferData(gl.ARRAY_BUFFER, data.rgba, gl.STATIC_DRAW);
		uploadFlags();
	}

	const onLost = (event: Event): void => {
		event.preventDefault();
		lost = true;
	};
	const onRestoredEvent = (): void => {
		// A new program: every uniform location (u_surface, u_dim and u_pass too) is read again, and the frame sets their values.
		state = initGl(gl);
		lost = state === null;
		upload();
		if (!lost) onRestored();
	};
	canvas.addEventListener('webglcontextlost', onLost as EventListener);
	canvas.addEventListener('webglcontextrestored', onRestoredEvent as EventListener);

	return {
		kind: 'webgl',
		get lost() {
			return lost;
		},
		pointSizeRange,
		resize(widthCss: number, heightCss: number, ratio: number): void {
			dpr = ratio;
			sizeCanvas(canvas, widthCss, heightCss, ratio);
		},
		setPoints(next: IPointData, outlineRgb: [number, number, number]): void {
			data = next;
			outline = outlineRgb;
			merge();
			if (!lost) upload();
		},
		setDimmed(next: Uint8Array | null, surfaceRgb: [number, number, number]): number {
			mask = next;
			surface = surfaceRgb;
			merge();
			if (!lost) uploadFlags();
			return dimmed;
		},
		render(frame: IRenderFrame): void {
			if (lost || state === null) return;
			lastFrame = frame;
			const s = state;
			gl.viewport(0, 0, canvas.width, canvas.height);
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
			if (data === null || data.count === 0) return;
			gl.useProgram(s.program);
			gl.bindBuffer(gl.ARRAY_BUFFER, s.position);
			gl.enableVertexAttribArray(s.attrib.position);
			gl.vertexAttribPointer(s.attrib.position, 3, gl.FLOAT, false, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, s.colour);
			gl.enableVertexAttribArray(s.attrib.colour);
			gl.vertexAttribPointer(s.attrib.colour, 4, gl.UNSIGNED_BYTE, true, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, s.flags);
			gl.enableVertexAttribArray(s.attrib.flags);
			gl.vertexAttribPointer(s.attrib.flags, 1, gl.UNSIGNED_BYTE, false, 0, 0);
			gl.uniformMatrix4fv(s.uniform.matrix, false, frame.matrix);
			gl.uniform1f(s.uniform.size, frame.pointSizePx * (frame.dpr || dpr));
			gl.uniform1f(s.uniform.minSize, pointSizeRange[0]);
			gl.uniform1f(s.uniform.maxSize, pointSizeRange[1]);
			gl.uniform3f(s.uniform.outline, outline[0], outline[1], outline[2]);
			gl.uniform1f(s.uniform.dpr, frame.dpr || dpr);
			gl.uniform3f(s.uniform.surface, surface[0], surface[1], surface[2]);
			gl.uniform1f(s.uniform.dim, DIM);
			if (dimmed === 0) {
				gl.uniform1f(s.uniform.pass, PASS.all);
				gl.drawArrays(gl.POINTS, 0, data.count);
				return;
			}
			// The faded points first, then the lit ones over them.
			gl.uniform1f(s.uniform.pass, PASS.dimmed);
			gl.drawArrays(gl.POINTS, 0, data.count);
			gl.uniform1f(s.uniform.pass, PASS.lit);
			gl.drawArrays(gl.POINTS, 0, data.count);
		},
		snapshot(target: CanvasRenderingContext2D): boolean {
			if (lost || state === null || lastFrame === null) return false;
			this.render(lastFrame);
			target.drawImage(canvas, 0, 0);
			return true;
		},
		destroy(): void {
			canvas.removeEventListener('webglcontextlost', onLost as EventListener);
			canvas.removeEventListener('webglcontextrestored', onRestoredEvent as EventListener);
			if (state !== null && !lost) {
				gl.deleteBuffer(state.position);
				gl.deleteBuffer(state.colour);
				gl.deleteBuffer(state.flags);
				gl.deleteProgram(state.program);
			}
			state = null;
			data = null;
			mask = null;
			flags = new Uint8Array(0);
			dimmed = 0;
			lastFrame = null;
		},
	};
}
