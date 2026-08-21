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

/**
 * Registry seam between the browser-safe client core and the Node-only
 * app packer. The packer module (`rocketride/app-pack`) registers itself
 * here when it loads; `deploy.addApp()`/`deploy.verifyApp()` use the
 * registered module when present and fall back to a runtime dynamic
 * import otherwise.
 *
 * Why both paths exist: plain Node consumers (CI scripts) never import
 * the packer themselves, so the dynamic self-import serves them — while
 * BUNDLED hosts (the VS Code extension) cannot resolve a runtime package
 * specifier from inside their bundle, so they arm the registry with one
 * side-effect import (`import 'rocketride/app-pack'`) that their bundler
 * carries statically.
 */

/** The packer surface deploy needs — structurally typed to avoid a static
    dependency on the Node-only module. */
export type AppPackModule = typeof import('../app-pack');

/**
 * Global key the registration is anchored under. Module-level state is NOT
 * enough: a bundled host that ends up with two copies of this module would
 * arm one copy and read the other, leaving getRegisteredAppPack() empty and
 * sending deploy down the dynamic-import path that cannot resolve inside a
 * bundle. Same idiom as the shell's ConnectionManager singleton. Reflect
 * accepts symbol keys without an unsafe cast of globalThis.
 */
const REGISTRY_KEY = Symbol.for('rocketride.appPack');

/** Called by the app-pack module itself at load time. */
export function registerAppPack(module: AppPackModule): void {
	Reflect.set(globalThis, REGISTRY_KEY, module);
}

/** The registered packer, or undefined when no host has loaded it. */
export function getRegisteredAppPack(): AppPackModule | undefined {
	return Reflect.get(globalThis, REGISTRY_KEY);
}
