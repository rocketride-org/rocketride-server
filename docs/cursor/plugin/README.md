# RocketRide for Cursor

Build, check and run RocketRide data and AI pipelines, and read each run's logs
and traces. A pipeline chains components such as file parsing, OCR, text
chunking, summarization and model calls. The plugin connects Cursor to the
hosted RocketRide MCP server at `https://api.rocketride.ai/mcp`. The plugin
holds only that address. It has no skills, rules or code.

## What you need

- A RocketRide account. If you have none, you can create one when Cursor asks
  you to sign in.
- Compute in that account to run a pipeline. A new account may have none at
  first.
- An API key for each model provider a pipeline calls, such as OpenAI, saved in
  your RocketRide account under **Settings > Environment Variables**. The agent
  can't save keys.
- Some accounts include RocketRide-hosted OpenAI models, which need no key. A
  pipeline deployed to a team can't use them and still needs a provider key.

## What the agent can do

| Task | Main tools |
| --- | --- |
| Build a pipeline from the components you can use | `list_components`, `describe_component`, `list_integrations` |
| Check a pipeline before it runs | `validate_pipeline` |
| Run a pipeline, send it input or stop it | `run_pipeline`, `send_data`, `terminate` |
| Follow a run | `monitor`, `list_running_pipelines` |
| Read past runs' logs and traces | `log_read`, `log_traces`, `log_trace` |
| Read files in your RocketRide file store | `store_list`, `store_read` |
| Deploy a pipeline to a team and schedule it | `deploy_add`, `deploy_to_team`, `deploy_set_schedule` |

The [tool reference](https://docs.rocketride.ai/connect/mcp/http/tools) lists
every tool. By default, Cursor asks you to approve each tool call. Some calls
use compute or change things:

- Running a pipeline uses your account's compute, and its steps send data to
  the services they call, such as a model provider.
- Checking a single component's settings, not a whole pipeline, calls that
  component's provider. A model provider may charge for that call.
- The deploy tools change which pipeline version a team runs and on what
  schedule. Scheduled runs start on their own and use compute too.

## Install

In Cursor, open **Customize** in the sidebar, find RocketRide in the
Marketplace and select **Install**. If it is not listed, use the install link:

[![Add RocketRide to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=rocketride&config=eyJ1cmwiOiJodHRwczovL2FwaS5yb2NrZXRyaWRlLmFpL21jcCJ9)

The link adds the same server without the plugin. Use one or the other.

## Sign in

You need no RocketRide API key. The first time Cursor connects to RocketRide,
it asks you to sign in through your browser.

## Cursor CLI

Run `agent mcp list`. If it shows the RocketRide server, run
`agent mcp login <name>` with the name it shows. If not, add RocketRide to
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "rocketride": {
      "url": "https://api.rocketride.ai/mcp"
    }
  }
}
```

Then run `agent mcp login rocketride`. The Cursor app and CLI both read this
file. If the plugin is also installed, keep only one of the two on. Turn the
other off in **Customize** or with `agent mcp disable <name>`.

## No browser

On a machine with no browser, use an account API key instead of signing in.
Create one in the RocketRide web app under **Settings > Account > API Keys**.
The key starts with `rr_`. Set it as `ROCKETRIDE_APIKEY` in your environment and
add a header to the server's entry in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "rocketride": {
      "url": "https://api.rocketride.ai/mcp",
      "headers": {
        "Authorization": "Bearer ${env:ROCKETRIDE_APIKEY}"
      }
    }
  }
}
```

Never put the key itself in a file you commit.

## Teams and Enterprise

If your team is on an Enterprise plan and uses the
[MCP allowlist](https://cursor.com/docs/mcp#mcp-allowlist), an admin may need to
add a URL entry for `https://api.rocketride.ai/mcp` under **Team Settings > MCP
Configuration**. Without it, Cursor can block the server for members.

On a Teams or Enterprise plan, a team admin can add the plugin to a team
marketplace from the plugin's page in the Cursor Marketplace, with **Add to
Cursor > Add to Team**.

## Help

- Setup docs: [Connect a client](https://docs.rocketride.ai/connect/mcp/http/connect)
- Questions and bug reports: [GitHub issues](https://github.com/rocketride-org/rocketride-server/issues)
- Privacy policy: [rocketride.ai/privacy-policy](https://rocketride.ai/privacy-policy)

## License

MIT. See [LICENSE](LICENSE).
