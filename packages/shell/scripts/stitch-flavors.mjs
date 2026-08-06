// MIT License
//
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

/**
 * Flavor stitcher — merges the DEV-React shell build into the production
 * output tree behind ONE index.html with an inline flavor picker.
 *
 * Why one html: OAuth2 redirect URIs are registered exactly, and production
 * assets are CDN-served — neither tolerates a second path or server-side
 * query logic. The picker chooses the asset set client-side:
 *
 *   - `?rrdev=1` on the URL selects the dev flavor AND persists the choice in
 *     sessionStorage ('rr:dev') so the OAuth round trip — whose redirect URI
 *     is the bare origin — comes back to the same flavor.
 *   - Everyone else gets the production assets; dev assets are dormant
 *     objects in the bucket that production visitors never fetch.
 *
 * Steps: copy shell-dev's hashed assets into shell (hash-named — no
 * collisions), extract each flavor's script/css tags from its emitted html,
 * write the combined index.html with the picker + asset manifest.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_ROOT = process.env.ROCKETRIDE_BUILD_ROOT ?? path.resolve(__dirname, '../../../build');
const PROD_DIR = path.join(BUILD_ROOT, 'shell');
const DEV_DIR = path.join(BUILD_ROOT, 'shell-dev');

/**
 * Extracts the entry asset URLs from an rsbuild-emitted index.html.
 *
 * @param {string} html - The html text.
 * @returns {{ js: string[], css: string[] }} Asset URLs in document order.
 */
function extractAssets(html) {
	const js = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g)].map((m) => m[1]);
	// Attribute order varies (rsbuild emits href before rel) — match the tag,
	// then pull href out of it.
	const css = [...html.matchAll(/<link\b[^>]*>/g)]
		.map((m) => m[0])
		.filter((tag) => /\brel="stylesheet"/.test(tag))
		.map((tag) => /\bhref="([^"]+)"/.exec(tag)?.[1])
		.filter(Boolean);
	return { js, css };
}

/**
 * Strips the entry script/stylesheet tags from the html (the picker re-adds
 * the chosen flavor's set at runtime). Preload/prefetch hints stay — they
 * reference production assets and are harmless for the dev flavor.
 *
 * @param {string} html - The html text.
 * @returns {string} Html without entry asset tags.
 */
function stripAssetTags(html) {
	return html
		.replace(/<script\b[^>]*\bsrc="[^"]+"[^>]*>\s*<\/script>/g, '')
		.replace(/<link\b[^>]*>/g, (tag) => (/\brel="stylesheet"/.test(tag) ? '' : tag));
}

/**
 * Recursively copies a directory, merging into the destination.
 *
 * @param {string} from - Source directory.
 * @param {string} to - Destination directory.
 */
function copyDir(from, to) {
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) copyDir(src, dst);
		else fs.copyFileSync(src, dst);
	}
}

// ── Load both flavors' html ──────────────────────────────────────────────
const prodHtmlPath = path.join(PROD_DIR, 'index.html');
const devHtmlPath = path.join(DEV_DIR, 'index.html');
if (!fs.existsSync(prodHtmlPath)) throw new Error(`stitch-flavors: missing ${prodHtmlPath} — run the production build first`);
if (!fs.existsSync(devHtmlPath)) throw new Error(`stitch-flavors: missing ${devHtmlPath} — run the RR_SHELL_FLAVOR=dev build first`);
const prodHtml = fs.readFileSync(prodHtmlPath, 'utf8');
const devHtml = fs.readFileSync(devHtmlPath, 'utf8');
// Stitching is destructive (tags are stripped) — a second pass over an
// already-stitched html would emit an empty manifest. Rebuild instead.
if (prodHtml.includes('RR_FLAVORS')) throw new Error('stitch-flavors: index.html is already stitched — rerun the production build first');

// ── Merge the dev flavor's hashed assets into the production tree ────────
const devStatic = path.join(DEV_DIR, 'static');
if (fs.existsSync(devStatic)) copyDir(devStatic, path.join(PROD_DIR, 'static'));

// ── Build the manifest + picker ──────────────────────────────────────────
const manifest = { prod: extractAssets(prodHtml), dev: extractAssets(devHtml) };
if (manifest.prod.js.length === 0) throw new Error('stitch-flavors: no entry scripts found in the production html');
if (manifest.dev.js.length === 0) throw new Error('stitch-flavors: no entry scripts found in the dev html');
// The shell always has entry CSS — zero means the extractor regressed
// against rsbuild's emitted tag shape (an unstyled shell, found the hard way).
if (manifest.prod.css.length === 0) throw new Error('stitch-flavors: no stylesheets found in the production html — extractor vs rsbuild tag-shape mismatch');

// The picker runs inline at the END of body (#root exists by then). Dynamic
// scripts are async by default — async=false preserves execution order.
// Beside the flavor choice it persists the dev-locked app id ('rr:devAppId'):
// the OAuth redirect strips the query string, and previewLockedAppId falls
// back to this session copy.
const picker = `<script>(function(){
var RR_FLAVORS=${JSON.stringify(manifest)};
var dev=false;
try{
	var p=new URLSearchParams(location.search);
	if(p.get('rrdev')==='1'){
		try{sessionStorage.setItem('rr:dev','1');}catch(e){}
		var a=p.get('appId')||p.get('appid');
		if(a){try{sessionStorage.setItem('rr:devAppId',a);}catch(e){}}
	}
	dev=p.get('rrdev')==='1';
	if(!dev){try{dev=sessionStorage.getItem('rr:dev')==='1';}catch(e){}}
}catch(e){}
var f=RR_FLAVORS[dev?'dev':'prod'];
f.css.forEach(function(href){var l=document.createElement('link');l.rel='stylesheet';l.href=href;document.head.appendChild(l);});
f.js.forEach(function(src){var s=document.createElement('script');s.src=src;s.async=false;document.body.appendChild(s);});
})();</script>`;

const stripped = stripAssetTags(prodHtml);
if (!stripped.includes('</body>')) throw new Error('stitch-flavors: production html has no </body>');
const combined = stripped.replace('</body>', `${picker}\n</body>`);
fs.writeFileSync(prodHtmlPath, combined, 'utf8');

console.log(`stitch-flavors: merged dev flavor (${manifest.dev.js.length} js, ${manifest.dev.css.length} css) behind the picker in ${prodHtmlPath}`);
