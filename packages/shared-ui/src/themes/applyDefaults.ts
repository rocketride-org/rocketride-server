/**
 * Side-effect module — applies the light theme tokens to :root on first import.
 *
 * In VSCode webviews, rocketride-vscode.css provides --rr-* tokens via CSS
 * mapped to --vscode-* variables. Applying inline styles here would override
 * those, so we skip when running inside a VSCode webview.
 *
 * In the web app (rocket-ui), this provides sensible light defaults that
 * host-applied themes (via applyTheme/fetchAndApplyTheme) will override.
 */

import { applyTheme } from './applyTheme';
import { isInVSCode } from './vscode';
import lightTokens from './light.json';

if (!isInVSCode()) {
	applyTheme(lightTokens);
}
