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
// colour), bit 8 emphasised (drawn larger, outlined).
// =============================================================================

/** Flag bits of a point. */
export const FLAG = { outlined: 1, hidden: 2, hollow: 4, emphasised: 8 } as const;

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
	/** Replace the points; `outline` is the outline colour, 0-1 per channel. */
	setPoints(data: IPointData, outline: [number, number, number]): void;
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
varying vec4 v_colour;
varying float v_flags;
varying float v_size;
float bit(float flags, float b) { return mod(floor(flags / b), 2.0); }
void main() {
	v_colour = a_colour;
	v_flags = a_flags;
	if (bit(a_flags, 2.0) > 0.5) {
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

/** The fragment shader: round sprite, optional outline ring, hollow ring. */
export const FRAGMENT_SHADER = `precision mediump float;
uniform vec3 u_outline;
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
	if (bit(v_flags, 4.0) > 0.5) {
		if (r < edge - 2.0 * u_dpr) discard;
		gl_FragColor = vec4(v_colour.rgb, 1.0);
		return;
	}
	if ((bit(v_flags, 1.0) > 0.5 || bit(v_flags, 8.0) > 0.5) && r > edge - u_dpr) {
		gl_FragColor = vec4(u_outline, 1.0);
		return;
	}
	gl_FragColor = vec4(v_colour.rgb, 1.0);
}
`;

/** The GL objects of one context generation. */
interface IGlState {
	program: WebGLProgram;
	position: WebGLBuffer;
	colour: WebGLBuffer;
	flags: WebGLBuffer;
	attrib: { position: number; colour: number; flags: number };
	uniform: { matrix: WebGLUniformLocation | null; size: WebGLUniformLocation | null; minSize: WebGLUniformLocation | null; maxSize: WebGLUniformLocation | null; outline: WebGLUniformLocation | null; dpr: WebGLUniformLocation | null };
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
	let lost = false;
	let dpr = 1;
	let lastFrame: IRenderFrame | null = null;

	/** Upload the current points. */
	function upload(): void {
		if (state === null || data === null) return;
		gl.bindBuffer(gl.ARRAY_BUFFER, state.position);
		gl.bufferData(gl.ARRAY_BUFFER, data.positions, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, state.colour);
		gl.bufferData(gl.ARRAY_BUFFER, data.rgba, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, state.flags);
		gl.bufferData(gl.ARRAY_BUFFER, data.flags, gl.STATIC_DRAW);
	}

	const onLost = (event: Event): void => {
		event.preventDefault();
		lost = true;
	};
	const onRestoredEvent = (): void => {
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
			if (!lost) upload();
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
			lastFrame = null;
		},
	};
}
