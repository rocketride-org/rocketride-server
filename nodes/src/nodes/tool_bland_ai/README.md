---
title: Bland AI
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>Bland AI - RocketRide Documentation</title>
</head>

## What it does

Gives agents the ability to make and manage AI-powered phone calls via the Bland AI API. Useful for automating outbound calls — scheduling, surveys, follow-ups, or any task that requires a voice interaction.

## Tools

| Tool                 | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `bland.make_call`    | Initiate an outbound AI phone call                       |
| `bland.get_call`     | Retrieve call status, transcript, recording, and summary |
| `bland.analyze_call` | Run post-call AI analysis against a set of questions     |

### bland.make_call

| Parameter        | Required | Description                             |
| ---------------- | -------- | --------------------------------------- |
| `phone_number`   | yes      | E.164 format (e.g. `+15551234567`)      |
| `task`           | yes      | Instructions for the AI during the call |
| `first_sentence` | no       | Opening line spoken by the AI           |
| `voice`          | no       | Override the default voice              |
| `max_duration`   | no       | Override the default max call length    |
| `language`       | no       | Override the default language           |
| `record`         | no       | Override the default recording setting  |
| `webhook`        | no       | URL to receive call events              |

Returns a `call_id` for use with `get_call` and `analyze_call`.

### bland.get_call

| Parameter             | Required | Description                                    |
| --------------------- | -------- | ---------------------------------------------- |
| `call_id`             | yes      | ID returned by `make_call`                     |
| `wait_for_completion` | no       | Poll until the call finishes (up to 5 minutes) |

### bland.analyze_call

| Parameter   | Required | Description                                            |
| ----------- | -------- | ------------------------------------------------------ |
| `call_id`   | yes      | ID returned by `make_call`                             |
| `goal`      | no       | Context about the call's purpose                       |
| `questions` | no       | Array of `[question, expected_type]` pairs to evaluate |

## Configuration

| Field          | Description                                                               |
| -------------- | ------------------------------------------------------------------------- |
| API Key        | Bland AI API key (`org_xxx`)                                              |
| Tool Namespace | Prefix for tool names (default: `bland`)                                  |
| Voice          | Default AI voice: June, Josh, Nat, Paige, Derek, Florian (default: June)  |
| Max Duration   | Default max call length in minutes (default: 5)                           |
| Record         | Record calls by default (default: on)                                     |
| Language       | Default call language: `en`, `es`, `fr`, `de`, `zh`, `ja` (default: `en`) |

## Upstream docs

- [Bland AI documentation](https://docs.bland.ai)
