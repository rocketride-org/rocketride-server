# tool_skills

A RocketRide tool node that gives an agent custom skills: written instructions for one kind of task, in the `SKILL.md` format. Pick it when you want an agent to follow your own procedure, checklist or house style for a task without putting all of it in the agent's prompt.

## What it does

The node has no data lanes and binds to an agent's `tools` connection. It loads skills when the pipeline starts, from skills entered in the node and from a folder of skills in your RocketRide files. The agent sees each skill's name and description in the `load_skill` tool description, loads a skill's instructions only when the task matches it, and reads a skill's other files only when the instructions call for them. A skill therefore costs context only when the agent uses it, and one node can hold many skills. Use the Python, Daytona or Tenki tool nodes alongside it when a skill's scripts need to run: this node returns files as text and runs nothing.

## As a tool

Tools are namespaced by the node id, so an agent sees `tool_skills_1.load_skill`.

| Function | Description |
|---|---|
| `load_skill` | Return one skill's instructions and the list of files bundled with it. The tool description lists every loaded skill as `- name: description`. Required: `name` (one of the loaded skill names). Returns `{name, description, instructions, files}`. |
| `read_skill_file` | Return one file bundled with a folder skill as UTF-8 text. Required: `name` and `path`, a path from the skill's `files` list (example: `references/style.md`). Returns `{name, path, content}`. Offered only when at least one loaded skill has bundled files. |

`read_skill_file` reads only the files listed for the skill, so a path outside the skill folder, or `SKILL.md` itself, is refused. A file over 256 KB, or one that is not UTF-8 text (an image, for example), raises an error. When no skill loads, the node offers no tools at all and logs a warning.

## Configuration

Enter skills in the node for short instructions that belong to one pipeline. Use a skills folder for skills you share across pipelines, edit outside the canvas, or that bundle reference files. Both can be used together.

### Skills

Each row is one skill with three fields: Name, Description and Instructions. Paste a whole `SKILL.md`, frontmatter included, into Instructions and leave Name and Description empty to take them from the frontmatter. Fill in Name or Description to override the frontmatter value.

The name is converted to lowercase letters, numbers and hyphens (`Release Notes` becomes `release-notes`), up to 64 characters. The description is what the agent reads when it decides whether to load the skill, so say what the skill does and when to use it: "Write release notes from a list of merged pull requests. Use when asked for a changelog or release summary." Descriptions longer than 1,024 characters are cut. An empty row is ignored; a row that lacks a name, a description or instructions is skipped with a warning.

### Instructions

Markdown the agent follows after loading the skill. Write steps, rules and examples the way you would brief a colleague. Instructions entered in the node cannot bundle files; use a skills folder when the instructions refer to reference documents or templates.

### Skills folder

A folder in the RocketRide file store, the same store the File System node reads. The folder can hold one subfolder per skill, or be one skill itself:

```text
skills/
  release-notes/
    SKILL.md
    references/style.md
    templates/entry.md
  triage/
    SKILL.md
```

Each `SKILL.md` needs a `description` in its frontmatter; the name defaults to the subfolder name. Every other file in the skill folder, up to 200 files and five folder levels deep, becomes readable through `read_skill_file`. A subfolder without a `SKILL.md`, or with one that cannot be parsed, is skipped with a warning naming it. When a skill in the folder has the same name as a skill entered in the node, the node's skill is kept.

Development runs read the folder from your own files. Deployed runs read it from the deployment's files, so copy the folder there before you deploy a pipeline that uses one.

## Notes

### SKILL.md format

A `SKILL.md` starts with YAML frontmatter between `---` lines, then the instructions:

```markdown
---
name: release-notes
description: Write release notes from a list of merged pull requests. Use when asked for a changelog or release summary.
---

# Release notes

Group the changes by area. Follow references/style.md for wording.
```

Frontmatter keys other than `name` and `description` are ignored. A file without frontmatter is all instructions, which works for skills entered in the node when Name and Description are filled in.

### When skills change

Skills are read when the pipeline starts. Restart the pipeline after you change a skill in the folder.

## Upstream docs

- [Agent Skills specification](https://agentskills.io/specification)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `tool_skills.folder` | `string` | **Skills folder**<br/>Folder in your RocketRide files that holds skills: one subfolder per skill, each with a SKILL.md. Example: skills. Leave empty to use only the skills entered below. | `""` |
| `tool_skills.skillDescription` | `string` | **Description**<br/>What the skill does and when to use it. The agent reads this to decide whether to load the skill. Leave empty to use the description in the SKILL.md frontmatter. | `""` |
| `tool_skills.skillInstructions` | `string` | **Instructions**<br/>The skill's instructions in markdown, or a whole SKILL.md including its frontmatter. | `""` |
| `tool_skills.skillName` | `string` | **Name**<br/>Lowercase letters, numbers and hyphens, for example release-notes. Leave empty to use the name in the SKILL.md frontmatter. | `""` |
| `tool_skills.skills` | `array` | **Skills**<br/>Skills to give the agent. Paste a whole SKILL.md into Instructions, or fill in the name and description and write the instructions. |  |

## Dependencies

- `pyyaml`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_skills)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
