# LlamaParse Node

## Overview

This node uses LlamaParse to extract text and structured data from various document formats including PDFs, images, and other document types.

## Features

- **Document Parsing**: Extracts text content from PDFs, images, and other document formats
- **Structured Output**: Returns parsed content in markdown format
- **Thread Safety**: Uses locks to ensure thread-safe parsing operations
- **Error Handling**: Graceful error handling with fallback to empty text
- **Tag-based Processing**: Uses the RocketRide tag system for document processing
- **Multiple Input Types**: Supports both tag-based document streams and document objects

## Pipeline Integration

- **Lanes**: `tags` (OMET, SBGN, SDAT, SEND) and `documents` -> `text`
- **Class type**: Parser (invoke). Use in pipelines that need document-to-text extraction via LlamaParse.

## Configuration

The node supports the following configuration options:

### Required configuration

- `api_key` (string, optional): Your LlamaParse API key. If not provided, some features may be limited.

### Optional configuration

- `parse_mode` (string, default: "cost_effective"): The parsing mode to use for document processing:
  - **cost_effective** (3 cred./page): Best for text-heavy documents without diagrams and images
  - **agentic** (10 cred./page): Best for documents with diagrams and images, may struggle with complex layouts
  - **agentic_plus** (90 cred./page): Highest parsing setting for complex layouts, multi-page tables, diagrams, and images
  - **parse_page_with_llm** (Legacy): Legacy LLM-based parsing mode
  - **parse_page_with_lvm** (Legacy): Legacy LVM-based parsing mode with additional configuration options

- `lvm_model` (string, optional): The LVM model to use when parse_mode is set to "parse_page_with_lvm", "agentic", or "agentic_plus". Options include "anthropic-sonnet-4.0", "anthropic-sonnet-3.5", "gpt-4o", "gpt-4o-mini".
- `use_system_prompt_append` (boolean, default: false): Whether to add custom instructions to the system prompt.
- `system_prompt_append` (string, optional): Additional instructions to append to the system prompt when use_system_prompt_append is enabled.
- `spreadsheet_extract_sub_tables` (boolean, default: false): Extract sub-tables from spreadsheets for better table parsing.

### Example configuration

```json
{
  "api_key": "your-llamaparse-api-key-here",
  "parse_mode": "agentic",
  "use_system_prompt_append": false,
  "spreadsheet_extract_sub_tables": false
}
```

### Parse mode selection guide

- **Use cost_effective** for:
  - Text-heavy documents (reports, articles, books)
  - Documents without diagrams, charts, or images
  - Budget-conscious processing

- **Use agentic** for:
  - Documents with diagrams, charts, or images
  - Mixed content documents
  - When you need better visual understanding

- **Use agentic_plus** for:
  - Complex layouts and multi-page tables
  - Documents with intricate diagrams
  - When maximum accuracy is required
  - Complex technical documents

## Usage

The node processes documents through two main methods:

1. **Tag-based Processing**: Uses `writeTag` method to handle document tags (OMET, SBGN, SDAT, SEND)
2. **Document Object Processing**: Uses `writeDocuments` method to handle document objects

### Tag processing flow

The node follows the standard RocketRide tag processing pattern:

- **OMET**: Metadata tag -- stores document metadata
- **SBGN**: Begin tag -- resets document data buffer
- **SDAT**: Data tag -- accumulates document data chunks
- **SEND**: End tag -- signals document completion
- **close()**: Processes the complete document using LlamaParse

### Supported document types

- PDF documents
- Image files (PNG, JPEG, etc.)
- Other document formats supported by LlamaParse

### Output

The node outputs parsed text content to the text lane and can also output structured document objects to the documents lane.

## Error Handling

- If parsing fails, the node returns an empty string and logs the error
- Temporary files are automatically cleaned up after processing
- Thread-safe operations prevent concurrent access issues
- Proper object failure handling with completion codes

## Dependencies

- `llama-parse`: Core parsing library
- `llama-index`: Document processing framework
- `llama-index-readers-file`: File reading capabilities
- `llama-index-core`: Core functionality
