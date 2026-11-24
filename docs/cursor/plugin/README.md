# RocketRide for Cursor

Build, check and run RocketRide data and AI pipelines from the Cursor agent,
and read each run's logs and traces. The plugin connects Cursor to the hosted
RocketRide MCP server at `https://api.rocketride.ai/mcp`. It holds the server's
address and nothing else.

## What you need

- A RocketRide account. Cursor opens your browser to sign in the first time it
  connects.
- Compute in that account. Running a pipeline uses it.
- For a step that calls a model, such as OpenAI, that provider's API key saved
  as a variable in your RocketRide account. If your account includes
  RocketRide-hosted OpenAI models, an OpenAI step runs without a key, except in
  a pipeline deployed to a team.

## What the agent can do

| Task | Main tools |
| --- | --- |
| Find components and how to set them up | `list_components`, `describe_component`, `list_integrations` |
| Check a pipeline before it runs | `validate_pipeline` |
| Run a pipeline and read its result | `run_pipeline`, `send_data`, `terminate` |
| Follow a run | `monitor`, `list_running_pipelines` |
| Read past runs' logs and traces | `log_read`, `log_traces`, `log_trace` |
| Read files in your RocketRide store | `store_list`, `store_read` |
| Deploy a pipeline to a team and schedule it | `deploy_add`, `deploy_to_team`, `deploy_set_schedule` |

The [tool reference](https://docs.rocketride.ai/connect/mcp/http/tools) lists
every tool. Cursor asks you to approve each tool call unless you have allowed
it.

## Install

In Cursor, open **Customize** in the sidebar, find RocketRide in the
Marketplace and select **Install**. If it is not listed, use the install link:

[![Add RocketRide to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg#gh-light-mode-only)](https://cursor.com/install-mcp?name=rocketride&config=eyJ1cmwiOiJodHRwczovL2FwaS5yb2NrZXRyaWRlLmFpL21jcCJ9)
[![Add RocketRide to Cursor](https://cursor.com/deeplink/mcp-install-light.svg#gh-dark-mode-only)](https://cursor.com/install-mcp?name=rocketride&config=eyJ1cmwiOiJodHRwczovL2FwaS5yb2NrZXRyaWRlLmFpL21jcCJ9)

The link adds the same server without the plugin. Use one or the other.

## Sign in

No API key is needed. The first time Cursor connects to RocketRide, it opens
your browser so you can sign in. In the Cursor CLI, run `agent mcp list` to see
the server's name, then `agent mcp login <name>`.

## Use an API key instead

On a machine with no browser, add the server to `~/.cursor/mcp.json` with a
RocketRide API key instead of installing the plugin. Create the key in the
RocketRide web app, set it as `ROCKETRIDE_APIKEY` in your environment, and use:

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

## Cursor Enterprise

On a team that uses the
[MCP allowlist](https://cursor.com/docs/mcp#mcp-allowlist), an admin first adds
a URL entry for `https://api.rocketride.ai/mcp` under **Team Settings > MCP
Configuration**. Until then, members cannot use the server. A team admin can
also add the plugin to a team marketplace from its Marketplace page.

## Help

- Setup and tool docs: [docs.rocketride.ai](https://docs.rocketride.ai/connect/mcp/http/connect)
- Questions and bug reports: [GitHub issues](https://github.com/rocketride-org/rocketride-server/issues)
- Privacy policy: [rocketride.ai/privacy-policy](https://rocketride.ai/privacy-policy)

## License

MIT. See [LICENSE](LICENSE).
