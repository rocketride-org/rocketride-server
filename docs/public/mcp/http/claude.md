---
title: Set Up Claude
sidebar_label: Claude
sidebar_position: 1.5
description: Add RocketRide to claude.ai, Claude Desktop and Claude Code, turn it on for a Team or Enterprise organization, and fix sign-in problems.
---

# Set Up Claude

RocketRide connects to claude.ai, Claude Desktop and Claude Code through one
URL:

```text
https://api.rocketride.ai/mcp
```

Each person signs in with their own RocketRide account the first time Claude
connects. The sign-in page also lets you create an account.

On a Team or Enterprise plan, an owner starts with the next section, and
members go to [Connect as a member](#connect-as-a-member). On your own plan, go
to [Add RocketRide for yourself](#add-rocketride-for-yourself). In a terminal,
go to [Claude Code](#claude-code).

## Add RocketRide to an organization

On Team and Enterprise plans, an Owner or Primary Owner adds RocketRide once
for the whole organization. On Enterprise, anyone whose custom role includes
**Manage access to Libraries** can too. Owners can also make tools that change
things need approval, or block them. See
[What Claude asks before it runs a tool](#what-claude-asks-before-it-runs-a-tool).

1. Open **Organization settings > Connectors**.
2. Click **Browse connectors** at the bottom of the page. If RocketRide is
   listed, select it, click **Add to your team**, and skip to
   [Connect as a member](#connect-as-a-member).
3. If it is not listed, close the directory, then click **Add** and **Custom >
   Web**. Name it `RocketRide` and enter the URL above. If the dialog shows
   **Continue**, click it.
4. Under **Authentication**, choose **Sign in now** or **Sign in when needed**.
   Either works. Do not choose **No sign-in**.
5. Under **OAuth client**, choose **Register automatically**. Claude marks
   **Use Claude's published identity** as recommended, but RocketRide's sign-in
   uses **Register automatically**. If the dialog shows everything on one
   screen, **OAuth client** is under **Advanced**.
6. Leave **Request headers** empty, if the dialog has it, and click **Add**.

### Connect as a member

Adding RocketRide to the organization does not give anyone access. Each member
connects their own account:

1. Open **Customize > Connectors** and find RocketRide. A custom connector has
   a **Custom** label.
2. Click **Connect** and sign in to RocketRide in the browser window.

## Add RocketRide for yourself

On Free, Pro, Max and Ultra plans:

1. Open **Customize > Connectors**.
2. Click **+** next to **Connectors** to browse the directory. If RocketRide is
   listed, select it, click **Connect** or **Install**, and skip to step 6.
3. If it is not listed, close the directory. Back in **Customize >
   Connectors**, click **+ Add** and choose **Add custom connector**. If the
   menu shows **Custom** instead, choose **Custom > Web**. Name it
   `RocketRide`, enter the URL above, and click **Continue** if the dialog
   shows it.
4. Under **Authentication**, choose a sign-in option, not **No sign-in**.
5. Under **OAuth client**, choose **Register automatically**, not the
   recommended **Use Claude's published identity**. On a one-screen dialog,
   **OAuth client** is under **Advanced**. Leave **Request headers** empty, if
   the dialog has it, and click **Add**.
6. Sign in to RocketRide in the browser window that opens. If no window opens,
   click **Connect** next to RocketRide.

A Free plan allows one custom connector. Anthropic's guides have the current
menus:
[adding a connector by URL](https://claude.com/docs/connectors/custom/add-unlisted),
[custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
and [the connectors directory](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities).

## Check that it works

In a chat, open the **+** menu, then **Connectors**, and turn RocketRide on.
If RocketRide is not in that list, connect it in **Customize > Connectors**.
Then ask "Which RocketRide components can I use?" Claude should call
`list_components` and list them.

## Claude Code

If you added RocketRide in claude.ai and Claude Code is signed in with the same
claude.ai account, it is already there. Run `/mcp` and look for RocketRide in
the claude.ai list. In an organization, use that one, so your owner's tool
settings apply.

Otherwise, add it in Claude Code:

```bash
claude mcp add --transport http rocketride --scope user \
  https://api.rocketride.ai/mcp
```

Then run `/mcp`, pick `rocketride`, and finish the sign-in in your browser.
From a shell, `claude mcp login rocketride` does the same. With
`--scope user`, RocketRide works in every project. If you also have the
claude.ai connector, Claude Code uses the server you added here and hides the
connector.

To check, ask "Which RocketRide components can I use?"

Under tool search, Claude Code loads `list_components`, `describe_component`,
`validate_pipeline` and `run_pipeline` at the start, as the server asks, and
the other tools when it needs them.

## What Claude asks before it runs a tool

Every RocketRide tool tells Claude whether it only reads or also makes changes:

- **Read-only tools** look things up: components, run status, logs and
  traces, deployments, and files in your RocketRide store. Examples are
  `list_components`, `monitor`, `log_traces` and `store_read`.
- **Write tools** start, feed or stop runs, save templates, and change
  deployments and schedules. Examples are `run_pipeline`, `terminate`,
  `save_template` and `deploy_add`.

Claude asks for your approval before it runs a tool that makes changes, unless
you or an owner chose to always allow it. It may also ask before a read-only
tool.

**Owners** set this per tool for the whole organization. In **Organization
settings > Connectors**, select RocketRide, open its **Tools** tab, and pick
**Always allow**, **Needs approval** or **Blocked**. If the **Tools** tab is
empty, connect RocketRide to your own account first in **Customize >
Connectors**.

**On your own plan**, the approval prompt offers **Allow always**. Use it only
for tools you are happy to run without asking.

The [annotations table](/connect/mcp/http/tools#annotations) lists every tool
and why it is marked the way it is.

## Fix sign-in problems

**Claude shows an authentication error the first time.** That is expected.
The server answers `401` until you sign in. Click **Connect** and finish the
sign-in in the browser window.

**Claude says it has no RocketRide tools.** RocketRide is off in this chat.
Open the **+** menu, then **Connectors**, and turn RocketRide on.

**The sign-in window closed or showed an error.** Click **Connect** again. If
it still fails, remove RocketRide and add it again, then sign in. In an
organization, an owner removes and adds it in **Organization settings >
Connectors**.

**RocketRide tools stopped working after a while.** Your sign-in may have
expired. In **Customize > Connectors**, disconnect RocketRide and connect it
again.

**A member cannot find RocketRide.** An owner has to add it to the organization
first. See [Add RocketRide to an organization](#add-rocketride-to-an-organization),
then [Connect as a member](#connect-as-a-member).
If RocketRide is in the connectors directory, a member can also click
**Request** on its page, if the organization allows requests.

**Claude cannot reach a self-hosted engine.** claude.ai and Claude Desktop
connect from Anthropic's servers, not from your computer. Your engine's URL
must be reachable from the internet over HTTPS on port 443
([Anthropic's network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)).
Claude Code connects from your own machine, so it can use a local engine. See
[Self-hosting](/connect/mcp/http/self-hosting).

Still stuck? Ask in [Discord](https://discord.gg/PMXrtenMsY).

## Widgets and files

In claude.ai and Claude Desktop, `list_running_pipelines` can show as a table
of running pipelines, and `log_traces` and `log_trace` as a trace viewer.
Claude Code shows the same results as text. See
[Resources & Widgets](/connect/mcp/http/resources-and-widgets#widgets).

To send files to a run, ask Claude to start it with `run_dropper_pipe`. The
result has a link to an upload page. Open it in your browser and drop the
files there.

## Limits

- **Time.** Claude waits up to 240 seconds for one tool call on claude.ai and
  Claude Desktop, so for a long run, ask Claude to start the run and then check
  on it with `monitor`. In Claude Code, `MCP_TOOL_TIMEOUT` sets this wait.
  RocketRide's own time budgets are under
  [How every tool behaves](/connect/mcp/http/tools#how-every-tool-behaves).
- **Size.** Claude accepts about 150,000 characters in one tool result, and
  Claude Code 25,000 tokens unless you raise `MAX_MCP_OUTPUT_TOKENS`, so ask
  for one trace or one page of a log rather than a whole run.

These limits are Anthropic's
([limits for connectors](https://claude.com/docs/connectors/building#design-within-the-size-and-timeout-limits)).
