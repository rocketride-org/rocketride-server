# rocketride-init / typescript-init

Bootstrap the current directory as a RocketRide workspace:

```bash
pnpm install http://localhost:5565/client/typescript-init
pnpm exec typescript-init
```

No arguments needed — the shim reads the server from its own install URL
in package.json (an explicit `typescript-init <server-url>` overrides).

It downloads the **server's own** client package into
`.rocketride/client/rocketride.tgz`, installs it as a content-hashed
`file:` dependency, and hands off to that client's `rocketride init` for
sign-in and workspace provisioning. Re-run `typescript-init` any time to
refresh — the client you get always matches the server you point at.

Requires node 18+ and pnpm.
