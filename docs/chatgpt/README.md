# docs/chatgpt/

The RocketRide app for ChatGPT, as the package OpenAI takes for its plugin
directory. OpenAI accepts an app as a ZIP of one plugin folder, uploaded in
its developer portal. This folder is that plugin. It points ChatGPT at the
hosted RocketRide server, `https://api.rocketride.ai/mcp`, and holds the
listing text, the icons and the review test cases.

It is separate from `docs/agents/`, the Claude Code and Codex plugin. Every
file there goes to coding-agent users, and this package has its own text and
no skills. The docs site does not render this folder.

## Files

| File | What it holds |
|---|---|
| `plugin.json` | Name, version and package description. Under `extensions.com.openai`: the listing (`interface`), five positive and three negative review test cases (`review`), and the release notes (`publication`). |
| `mcp.json` | The one MCP server, by URL. It has no headers and no auth settings. The server answers a request without a token with 401 and its sign-in metadata, and the portal reads that. |
| `assets/` | 512 by 512 pixels. `icon.png` is the logo, the mark on a navy tile. `composer-icon.png` is the composer icon, the mark with a navy body on a transparent background. `icon-dark.png` is the logo and composer icon for dark themes, the mark with a white body on a transparent background. The SVG files are their source, drawn from `packages/shell/src/components/RocketRideMark.tsx`. The mark stays inside 90% of the half-width, so a round crop does not cut it. |
| `README.md` | This file. It is not part of the ZIP. |

`tests/test_chatgpt_package.py` checks the package against OpenAI's limits for
a public listing: field lengths, the category, HTTPS links, exactly one
server, no secrets or reviewer fields, square icons of at least 48 pixels,
five positive and three negative test cases that name registered tools, and
a short list of words the listing must not use. CI runs it in `docs:test`.

## Build the ZIP

From the repository root:

```bash
python3 -m zipfile -c rocketride-chatgpt-1.0.0.zip docs/chatgpt/plugin.json docs/chatgpt/mcp.json docs/chatgpt/assets
```

This puts `plugin.json`, `mcp.json` and `assets/` at the root of the ZIP and
leaves this README out. Use the `version` from `plugin.json` in the file name.
List the contents with `python3 -m zipfile -l <file>`. Do not commit the ZIP.

## Entered in the portal, never committed

- The reviewer login: a test account with sample data, its sign-in steps and
  any workspace details. Reviewers can't use MFA, email codes or magic links.
- A client secret, if the portal's connect step asks for one.
- The domain verification token. The portal shows it, and the engine serves it
  at `/.well-known/openai-apps-challenge` from
  `MCP_OPENAI_APPS_CHALLENGE_TOKEN` (see
  [OpenAI domain verification](../public/mcp/http/self-hosting.md#openai-domain-verification)).
- The demo recording link and the policy answers. The recording link can also
  go in `review.demo_recording_url` in `plugin.json`.

## Before each upload

1. Check that the hosted server lists every tool the test cases name, and run
   each case on the reviewer account. The cases use tools the hosted server
   has had longest. Cases 1, 2, 4 and 5 need an OpenAI key saved in the
   reviewer account, and case 3 needs one deployment with a schedule. Each
   case's description says what it needs.
2. Open the four links in `interface` (website, support, privacy policy and
   terms). Each must load without a login and name RocketRide as the
   publisher. The support link must show a way to contact RocketRide.
3. Raise `version` and update `publication.release_notes`. Any change to the
   listing text, icons or test cases needs a new ZIP.
4. Run the check: `python3 -m pytest tests/test_chatgpt_package.py`.
5. Build the ZIP and upload it.
