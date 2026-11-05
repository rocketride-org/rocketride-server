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
// MAP - CAMERA (pure maths: 2D pan/zoom and the optional 3D orbit)
// =============================================================================
//
// One matrix maps layout coordinates to clip space for each camera, column-major
// as WebGL wants it. The renderer draws with it and `projectToScreen` applies the
// same matrix on the CPU for picking, the lasso and the keyboard path, so what
// the pointer finds is exactly what was drawn.
//
// 2D: `scale` is CSS pixels per layout unit; world y points up (screen y down).
// 3D (the stretch view): a perspective camera orbiting `target`.
// =============================================================================

/** The 2D camera. */
export interface ICamera2D {
	mode: '2d';
	/** Layout coordinate at the viewport centre. */
	cx: number;
	cy: number;
	/** CSS pixels per layout unit. */
	scale: number;
}

/** The 3D orbit camera. */
export interface ICamera3D {
	mode: '3d';
	target: [number, number, number];
	/** Rotation about the vertical axis, radians. */
	yaw: number;
	/** Elevation, radians (clamped short of the poles). */
	pitch: number;
	/** Eye distance from the target. */
	distance: number;
	/** Vertical field of view, radians. */
	fov: number;
}

/** Either camera. */
export type MapCamera = ICamera2D | ICamera3D;

/** Viewport size in CSS pixels. */
export interface IViewport {
	width: number;
	height: number;
}

/** An axis-aligned extent in layout units. */
export interface IBounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

/** Zoom limits (pixels per layout unit). */
export interface IZoomLimits {
	min: number;
	max: number;
}

const PITCH_LIMIT = Math.PI / 2 - 0.01;

// =============================================================================
// 2D
// =============================================================================

/**
 * Layout coordinates to screen pixels.
 *
 * @param cam - The camera.
 * @param vp - The viewport.
 * @param x - Layout x.
 * @param y - Layout y.
 * @returns Screen x and y.
 */
export function worldToScreen(cam: ICamera2D, vp: IViewport, x: number, y: number): [number, number] {
	return [vp.width / 2 + (x - cam.cx) * cam.scale, vp.height / 2 - (y - cam.cy) * cam.scale];
}

/**
 * Screen pixels to layout coordinates.
 *
 * @param cam - The camera.
 * @param vp - The viewport.
 * @param sx - Screen x.
 * @param sy - Screen y.
 * @returns Layout x and y.
 */
export function screenToWorld(cam: ICamera2D, vp: IViewport, sx: number, sy: number): [number, number] {
	return [cam.cx + (sx - vp.width / 2) / cam.scale, cam.cy - (sy - vp.height / 2) / cam.scale];
}

/**
 * The extent of the visible, finite points.
 *
 * @param positions - Coordinates, `dims` per point.
 * @param dims - 2 or 3.
 * @param hidden - Optional mask of points to ignore.
 * @returns The bounds of x and y, or null when no point counts.
 */
export function boundsOf(positions: ArrayLike<number>, dims: 2 | 3, hidden?: ArrayLike<number> | null): IBounds | null {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	const n = Math.floor(positions.length / dims);
	for (let i = 0; i < n; i += 1) {
		if (hidden != null && (hidden[i] as number) !== 0) continue;
		const x = positions[i * dims] as number;
		const y = positions[i * dims + 1] as number;
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return minX === Infinity ? null : { minX, maxX, minY, maxY };
}

/**
 * The camera that shows `bounds` whole, centred, inside `padding` pixels.
 *
 * @param bounds - What to show.
 * @param vp - The viewport.
 * @param padding - Margin in pixels.
 * @returns The camera.
 */
export function fitCamera(bounds: IBounds, vp: IViewport, padding = 24): ICamera2D {
	const w = bounds.maxX - bounds.minX;
	const h = bounds.maxY - bounds.minY;
	const availW = Math.max(1, vp.width - 2 * padding);
	const availH = Math.max(1, vp.height - 2 * padding);
	const candidates: number[] = [];
	if (w > 0) candidates.push(availW / w);
	if (h > 0) candidates.push(availH / h);
	const scale = candidates.length > 0 ? Math.min(...candidates) : 1;
	return { mode: '2d', cx: (bounds.minX + bounds.maxX) / 2, cy: (bounds.minY + bounds.maxY) / 2, scale };
}

/**
 * Zoom about a screen point: the layout point under it stays under it.
 *
 * @param cam - The camera.
 * @param vp - The viewport.
 * @param sx - Screen x of the fixed point.
 * @param sy - Screen y of the fixed point.
 * @param factor - Scale multiplier (>1 zooms in).
 * @param limits - Allowed scale range.
 * @returns The new camera.
 */
export function zoomAt(cam: ICamera2D, vp: IViewport, sx: number, sy: number, factor: number, limits: IZoomLimits = { min: 1e-6, max: 1e6 }): ICamera2D {
	const scale = Math.min(limits.max, Math.max(limits.min, cam.scale * factor));
	const [wx, wy] = screenToWorld(cam, vp, sx, sy);
	return { mode: '2d', cx: wx - (sx - vp.width / 2) / scale, cy: wy + (sy - vp.height / 2) / scale, scale };
}

/**
 * Move the scene with the pointer.
 *
 * @param cam - The camera.
 * @param dx - Pointer movement, pixels right.
 * @param dy - Pointer movement, pixels down.
 * @returns The new camera.
 */
export function panBy(cam: ICamera2D, dx: number, dy: number): ICamera2D {
	return { mode: '2d', cx: cam.cx - dx / cam.scale, cy: cam.cy + dy / cam.scale, scale: cam.scale };
}

// =============================================================================
// 3D
// =============================================================================

/**
 * Turn the orbit camera.
 *
 * @param cam - The camera.
 * @param dYaw - Radians about the vertical axis.
 * @param dPitch - Radians of elevation.
 * @returns The new camera (pitch clamped short of the poles).
 */
export function orbitCamera(cam: ICamera3D, dYaw: number, dPitch: number): ICamera3D {
	return { ...cam, yaw: cam.yaw + dYaw, pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, cam.pitch + dPitch)) };
}

/**
 * Move the eye towards (factor < 1) or away from the target.
 *
 * @param cam - The camera.
 * @param factor - Distance multiplier.
 * @returns The new camera.
 */
export function dollyCamera(cam: ICamera3D, factor: number): ICamera3D {
	return { ...cam, distance: Math.max(1e-3, cam.distance * factor) };
}

/**
 * The orbit camera that shows a 3D point cloud whole.
 *
 * @param positions - x,y,z per point.
 * @param hidden - Optional mask.
 * @returns The camera, looking at the cloud's centre from the front.
 */
export function fitCamera3D(positions: ArrayLike<number>, hidden?: ArrayLike<number> | null): ICamera3D {
	const n = Math.floor(positions.length / 3);
	const centre: [number, number, number] = [0, 0, 0];
	let count = 0;
	for (let i = 0; i < n; i += 1) {
		if (hidden != null && (hidden[i] as number) !== 0) continue;
		for (let c = 0; c < 3; c += 1) centre[c] = (centre[c] as number) + (positions[3 * i + c] as number);
		count += 1;
	}
	if (count > 0) for (let c = 0; c < 3; c += 1) centre[c] = (centre[c] as number) / count;
	let radius = 0;
	for (let i = 0; i < n; i += 1) {
		if (hidden != null && (hidden[i] as number) !== 0) continue;
		const dx = (positions[3 * i] as number) - centre[0];
		const dy = (positions[3 * i + 1] as number) - centre[1];
		const dz = (positions[3 * i + 2] as number) - centre[2];
		radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
	}
	const fov = Math.PI / 4;
	return { mode: '3d', target: centre, yaw: 0, pitch: 0, distance: Math.max(1, (radius || 1) / Math.sin(fov / 2)) * 1.05, fov };
}

/** a * b for column-major 4x4 matrices. */
function multiply(a: Float32Array, b: Float32Array): Float32Array {
	const out = new Float32Array(16);
	for (let c = 0; c < 4; c += 1) {
		for (let r = 0; r < 4; r += 1) {
			let s = 0;
			for (let k = 0; k < 4; k += 1) s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
			out[c * 4 + r] = s;
		}
	}
	return out;
}

/** The eye position of an orbit camera. */
function eyeOf(cam: ICamera3D): [number, number, number] {
	const cp = Math.cos(cam.pitch);
	return [cam.target[0] + cam.distance * cp * Math.sin(cam.yaw), cam.target[1] + cam.distance * Math.sin(cam.pitch), cam.target[2] + cam.distance * cp * Math.cos(cam.yaw)];
}

// =============================================================================
// MATRIX AND PROJECTION
// =============================================================================

/**
 * A short text that changes whenever the camera moves (`data-camera` on the
 * map, which the performance lane compares before and after a pan to prove
 * the gesture reached the camera). Six significant digits per number.
 *
 * @param cam - Either camera, or null when there is none yet.
 * @returns e.g. '2d:0.125,-2,37.5'; '' for none.
 */
export function cameraSignature(cam: MapCamera | null): string {
	if (cam === null) return '';
	const f = (v: number): string => String(Number(v.toPrecision(6)));
	if (cam.mode === '2d') return `2d:${f(cam.cx)},${f(cam.cy)},${f(cam.scale)}`;
	return `3d:${cam.target.map(f).join(',')},${f(cam.yaw)},${f(cam.pitch)},${f(cam.distance)}`;
}

/**
 * The column-major matrix from layout coordinates to clip space.
 *
 * @param cam - Either camera.
 * @param vp - The viewport.
 * @returns 16 floats.
 */
export function viewMatrix(cam: MapCamera, vp: IViewport): Float32Array {
	const w = Math.max(1, vp.width);
	const h = Math.max(1, vp.height);
	if (cam.mode === '2d') {
		const sx = (2 * cam.scale) / w;
		const sy = (2 * cam.scale) / h;
		return new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, -cam.cx * sx, -cam.cy * sy, 0, 1]);
	}
	const eye = eyeOf(cam);
	let zx = eye[0] - cam.target[0];
	let zy = eye[1] - cam.target[1];
	let zz = eye[2] - cam.target[2];
	const zl = Math.hypot(zx, zy, zz) || 1;
	zx /= zl;
	zy /= zl;
	zz /= zl;
	// x = up × z with up = (0, 1, 0).
	let xx = zz;
	let xy = 0;
	let xz = -zx;
	const xl = Math.hypot(xx, xy, xz) || 1;
	xx /= xl;
	xy /= xl;
	xz /= xl;
	const yx = zy * xz - zz * xy;
	const yy = zz * xx - zx * xz;
	const yz = zx * xy - zy * xx;
	const view = new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * eye[0] + xy * eye[1] + xz * eye[2]), -(yx * eye[0] + yy * eye[1] + yz * eye[2]), -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1]);
	const near = Math.max(1e-3, cam.distance * 0.01);
	const far = cam.distance * 100 + 1000;
	const f = 1 / Math.tan(cam.fov / 2);
	const projection = new Float32Array([f / (w / h), 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
	return multiply(projection, view);
}

/**
 * Project every point to screen pixels with a view matrix (what the renderer draws).
 *
 * @param positions - Coordinates, `dims` per point (z = 0 for 2D).
 * @param dims - 2 or 3.
 * @param matrix - From {@link viewMatrix}.
 * @param vp - The viewport.
 * @param out - Optional output (2n floats); NaN for a point behind the eye.
 * @param depth - Optional output (n floats): normalised depth, smaller is nearer.
 * @returns Screen x,y interleaved.
 */
export function projectToScreen(positions: ArrayLike<number>, dims: 2 | 3, matrix: Float32Array, vp: IViewport, out?: Float32Array, depth?: Float32Array): Float32Array {
	const n = Math.floor(positions.length / dims);
	const xy = out && out.length >= n * 2 ? out : new Float32Array(n * 2);
	const m = matrix;
	for (let i = 0; i < n; i += 1) {
		const x = positions[i * dims] as number;
		const y = positions[i * dims + 1] as number;
		const z = dims === 3 ? (positions[i * dims + 2] as number) : 0;
		const cx = (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
		const cy = (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
		const cz = (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number);
		const cw = (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number);
		if (!(cw > 1e-9) || !Number.isFinite(cx) || !Number.isFinite(cy)) {
			xy[2 * i] = Number.NaN;
			xy[2 * i + 1] = Number.NaN;
			if (depth) depth[i] = Number.POSITIVE_INFINITY;
			continue;
		}
		xy[2 * i] = ((cx / cw + 1) / 2) * vp.width;
		xy[2 * i + 1] = ((1 - cy / cw) / 2) * vp.height;
		if (depth) depth[i] = cz / cw;
	}
	return xy;
}
