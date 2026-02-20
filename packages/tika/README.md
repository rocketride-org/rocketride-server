# @rocketride/tika

RocketRide Java/Tika - Apache Tika integration for document parsing.

## Overview

This package provides Apache Tika integration for parsing and extracting content from various document formats:

- PDF documents
- Microsoft Office files (Word, Excel, PowerPoint)
- OpenDocument formats
- Email files (EML, MSG)
- Images with OCR
- And many more...

## Requirements

- Java 11 or later
- Apache Tika 2.x

## Integration

The Java/Tika module is integrated with the engine library and is automatically loaded when Java support is enabled.

## Configuration

Set the Java home:

```bash
export JAVA_HOME=/path/to/java
```

Configure Tika options in your pipeline:

```json
{
  "filters": [
    {
      "type": "parse",
      "options": {
        "extractMetadata": true,
        "extractText": true,
        "ocrEnabled": true
      }
    }
  ]
}
```

## Directory Structure

```
packages/tika/
├── lib/               # JAR files
│   └── tika/          # Tika libraries
├── src/               # Java source (if any)
└── README.md          # This file
```

## License

MIT License - see [LICENSE](../../LICENSE)

### Third-Party Licenses

Apache Tika is licensed under the Apache License 2.0.
See `lib/tika/opensource.txt` for full license information.

