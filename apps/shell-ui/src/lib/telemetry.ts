// Shell wrapper over the shared telemetry that lives in the `rocketride` client
// (packages/client-typescript/src/client/telemetry.ts). All transport + privacy
// logic lives in the shared module so the VS Code extension uses the exact same
// report(); the shell just supplies a browser-persisted distinct id and a
// localStorage-backed opt-out. What is / isn't collected is documented in
// apps/shell-ui/TELEMETRY.md — keep the two in sync.

import { telemetry, report } from 'rocketride'

export { report }
export { telemetryEvents as events } from 'rocketride'

const DISTINCT_ID_KEY = 'rr_telemetry_id'
const OPT_OUT_KEY = 'rr_telemetry_optout'

function browserDistinctId(): string {
  try {
    let id = localStorage.getItem(DISTINCT_ID_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(DISTINCT_ID_KEY, id)
    }
    return id
  } catch {
    return crypto.randomUUID()
  }
}

/** Opt the current browser out of all telemetry (persists locally). */
export function optOut(): void {
  try {
    localStorage.setItem(OPT_OUT_KEY, '1')
  } catch {
    /* ignore */
  }
}

/** Opt back in. */
export function optIn(): void {
  try {
    localStorage.removeItem(OPT_OUT_KEY)
  } catch {
    /* ignore */
  }
}

export function hasOptedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Initialise telemetry once, from the shell. No-op unless the public PostHog
 * project key is provided (unset for OSS/local builds → disabled). Honours the
 * per-browser opt-out.
 *
 * @param apiKey  PostHog public project key (`phc_…`), injected at build time.
 * @param apiHost first-party proxy; defaults to the CloudFront proxy.
 */
export function initTelemetry(apiKey: string | undefined, apiHost?: string): void {
  if (typeof window === 'undefined') return
  telemetry.configure({
    apiKey,
    apiHost,
    distinctId: browserDistinctId(),
    enabled: () => !hasOptedOut(),
  })
}

/** Attach app context so every event carries it (no need to pass the app each call). */
export function registerApp(ctx: {
  appId: string
  appName?: string
  surface?: string
  appVersion?: string
}): void {
  telemetry.register({
    app_id: ctx.appId,
    app_name: ctx.appName,
    surface: ctx.surface ?? 'home_ui',
    app_version: ctx.appVersion,
  })
}

/** Tie events to the signed-in user (id from our IdP). Keep person data minimal. */
export function identifyUser(userId: string, props?: { org_id?: string }): void {
  if (!userId) return
  telemetry.identify(userId)
  if (props?.org_id) telemetry.register({ org_id: props.org_id })
}
