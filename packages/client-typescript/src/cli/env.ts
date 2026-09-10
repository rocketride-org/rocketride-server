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

/**
 * Workspace `.env` handling — provided by the client-common source
 * library (compiled in like `shared/`); this module keeps the CLI's
 * import paths stable.
 */

export { ENV_DEV_URI, ENV_DEV_APIKEY, ENV_DEPLOY_URI, ENV_DEPLOY_APIKEY, NO_DEPLOY_TARGET_MESSAGE, loadDotEnv, writeDotEnv, parseEnvLine } from '../../../client-common/typescript/src/env';

/**
 * Resolve the deploy-target connection pair for lifecycle verbs.
 *
 * The deploy pair is deliberate configuration: when it is absent the
 * caller gets a hard stop — the development connection is never a
 * deploy fallback.
 *
 * @param overrides - Optional --uri/--apikey flag values that win over env.
 * @returns The resolved pair, or null when no deploy target is configured.
 */
export function resolveDeployPair(overrides: { uri?: string; apikey?: string } = {}): { uri: string; apikey: string } | null {
	const uri = overrides.uri || process.env.ROCKETRIDE_DEPLOY_URI || '';
	if (!uri) {
		return null;
	}
	return { uri, apikey: overrides.apikey || process.env.ROCKETRIDE_DEPLOY_APIKEY || '' };
}
