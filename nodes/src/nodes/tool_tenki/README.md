# tool_tenki

A RocketRide tool node that gives an agent a disposable Linux virtual machine on
[Tenki Cloud](https://tenki.cloud) to run commands and code in, edit files, and work in a git
repository.

## What it does

Gives the pipeline one Tenki Sandbox microVM, created on the agent's first tool call and shared by
every call after it, so files and installed packages carry over. Pick it over `tool_python` when
the work needs a real operating system, and over `tool_daytona` when the machine should keep its
state for the whole session. The node puts no credentials inside the VM.

## Example pipelines

**Write a script and run it in a sandbox**

`chat → agent_rocketride (+ tool_tenki) → response_answers`

<div align="center">

![The tool_tenki node wired to the RocketRide Wave agent on the canvas, alongside an Anthropic LLM and internal memory](example.png)

[![Download example.pipe](https://img.shields.io/badge/example.pipe-Download-41b6e6?style=for-the-badge)](example.pipe)

</div>

## As a tool

An agent calls these as `<node id>.<function>`, for example `tool_tenki_1.run_command`.
**Tool groups** chooses the published groups; empty publishes all three.

| Group | Function | What it does |
|---|---|---|
| `execution` | `run_command` | Run a shell command. |
| `execution` | `run_code` | Run a `python` or `javascript` snippet. |
| `filesystem` | `write_file` | Write a UTF-8 text file. |
| `filesystem` | `edit_file` | Replace one exact, unique piece of text. |
| `filesystem` | `read_file` | Read a text file of up to 4,000,000 bytes. |
| `filesystem` | `list_files` | List a directory. |
| `filesystem` | `make_directory` | Create a directory and its parents. |
| `filesystem` | `delete_path` | Delete a file or directory. |
| `git` | `git_clone` | Clone a public repository, or a private one under the prefix. |
| `git` | `git_checkout` | Check out a branch, tag or commit. |
| `git` | `git_diff` | Show a diff. |
| `git` | `git_log` | Show commit history. |

Results flag `timed_out`, `truncated`, and any session change: `created`, `resumed`, `replaced`
(earlier files gone) or `ended`.

## Configuration

Only **API Key** is required; the generated Schema table lists every field and default. Three
fields need judgement.

### Allowed outbound domains

Restricts outbound traffic to the listed hostnames, on any port; empty leaves it open. List only
what the work needs, such as `pypi.org` and `files.pythonhosted.org` for pip: every listed host can
receive data. Entries are hostnames with at most one leading `*.`; anything else stops the
pipeline at startup.

### Secret policies

Names of [Tenki request policies](https://tenki.cloud/docs/secrets/request-policies) to attach.
Sandbox code puts a placeholder such as `secrets://GITHUB_TOKEN` in an HTTPS request, and Tenki
substitutes the value outside the VM, only where a policy allows. Policies require **Allowed
outbound domains** and a key with Secrets access. Tell the agent which placeholders it may use.
A policy cannot protect the value from an allowed destination, which receives it and can return it
([Tenki: troubleshooting](https://tenki.cloud/docs/sandbox/secrets#troubleshooting)).

### Private repositories: URL prefix / Private repositories: Tenki secret

Name a Tenki secret holding the HTTP Basic credential: the base64 of the whole string
`x-access-token:<token>`, where `<token>` is a read-only GitHub token. Narrow the prefix to what
its policy covers, such as `https://github.com/acme/`. The policy needs `GET` and `POST` rules for
that path and the `Authorization` header. `git_clone` then sends the placeholder for URLs under
the prefix only. Keep the token read-only: a push matches the `POST` rule. `git_clone` refuses
URLs carrying credentials, a query string or a fragment, because git stores the URL in
`.git/config`.

## Authentication

Create a Tenki workspace API key (`tk_...`) in the Tenki dashboard
([Tenki: API keys](https://tenki.cloud/docs/account/api-keys)), and set it as **API Key** or as
`${ROCKETRIDE_TENKI_APIKEY}`. It never enters the VM. Secret policies also need **Allow Secrets
access**, chosen when the key is created
([Tenki: access permissions](https://tenki.cloud/docs/secrets/manage-secrets#access-permissions)).
That access can change every secret and policy in the workspace, so give the node its own key.

## Notes

### Limits

> **Note:** these limits apply to every pipeline.
>
> - Every caller of a pipeline shares one VM; run one pipeline per user or trust boundary.
> - Output beyond 8 MiB is dropped and the command is stopped.
> - A process under `sudo` or with a cleared environment escapes that stop and runs until
>   **Execution Timeout**.
> - A session paused and resumed from outside the node can leave it unreachable until the pipeline
>   restarts.
> - Secret injection needs an image with Tenki's managed HTTPS trust.
> - IPv4 ranges in **Allowed outbound domains** are refused.
> - **Tool groups** are not a security boundary.

## Upstream docs

- [Tenki Sandbox: sessions](https://tenki.cloud/docs/sandbox/sessions)
- [Tenki Sandbox: secrets](https://tenki.cloud/docs/sandbox/secrets)
- [Tenki: pricing](https://tenki.cloud/docs/pricing)
- [Tenki: changelog](https://tenki.cloud/docs/changelog)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
