---
title: General Text Preprocessor
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>General Text Preprocessor - RocketRide Documentation</title>
</head>

## What it does

Splits text into chunks for downstream embedding or LLM processing. Uses LangChain text splitters — choose a splitter tuned for the content type (prose, markdown, LaTeX, code-adjacent text). No LLM required.

**Lanes:**

| Lane in | Lane out    | Description                              |
| ------- | ----------- | ---------------------------------------- |
| `text`  | `documents` | Split plain text into document chunks    |
| `table` | `documents` | Split table content into document chunks |

## Configuration

| Field         | Description                                            |
| ------------- | ------------------------------------------------------ |
| Text splitter | Splitting strategy (see profiles below)                |
| Split by      | `String length` or `Estimated tokens`                  |
| Size          | Maximum characters or tokens per chunk (default `512`) |

## Profiles

| Profile             | Splitter                         | Best for                                                               |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| Default _(default)_ | `RecursiveCharacterTextSplitter` | General-purpose prose                                                  |
| Recursive           | `RecursiveCharacterTextSplitter` | General-purpose with custom separators                                 |
| Character           | `CharacterTextSplitter`          | Simple splitting on a fixed separator                                  |
| Markdown            | `MarkdownTextSplitter`           | Structured Markdown documents                                          |
| LaTeX               | `LatexTextSplitter`              | Scientific/academic documents                                          |
| NLTK                | `NLTKTextSplitter`               | Sentence-based splitting                                               |
| Spacy               | `SpacyTextSplitter`              | NLP-based sentence splitting (English, German, French, Spanish models) |
| Custom              | `RecursiveCharacterTextSplitter` | User-defined splitter class                                            |
