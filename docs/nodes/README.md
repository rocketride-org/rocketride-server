# RocketRide Node Development Guide

This guide covers creating custom nodes for the RocketRide Engine.

## Overview

Nodes are modular Python-based integrations that extend the engine's capabilities. They can be:

- **Endpoints** - Data sources and destinations
- **Filters** - Data transformers
- **Services** - Background services

## Node Structure

A node package follows this structure:

```
nodes/my_node/
├── __init__.py         # Package initialization
├── IEndpoint.py        # Endpoint implementation (optional)
├── IGlobal.py          # Global configuration (optional)
├── IInstance.py        # Instance implementation
├── services.json       # Service definitions
└── requirements.txt    # Python dependencies
```

## Creating a Basic Node

### 1. Create the Directory

```bash
mkdir packages/nodes/nodes/my_node
cd packages/nodes/nodes/my_node
```

### 2. Create `__init__.py`

```python
# =============================================================================
# RocketRide Engine - My Custom Node
# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
# =============================================================================

"""My custom node for RocketRide Engine."""

from .IInstance import IInstance

__all__ = ['IInstance']
```

### 3. Create `IGlobal.py` (Optional)

```python
# =============================================================================
# RocketRide Engine - My Custom Node - Global Configuration
# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
# =============================================================================

"""Global configuration for the node."""

import engLib


class IGlobal:
    """Global node configuration, shared across all instances."""

    def beginGlobal(self, config: dict):
        """Initialize global state.
        
        Args:
            config: Configuration from pipeline.
        """
        engLib.debug('My node: beginGlobal')
        self.api_key = config.get('apiKey')

    def endGlobal(self):
        """Clean up global state."""
        engLib.debug('My node: endGlobal')
```

### 4. Create `IInstance.py`

```python
# =============================================================================
# RocketRide Engine - My Custom Node - Instance Implementation
# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
# =============================================================================

"""Instance implementation for processing objects."""

import engLib


class IInstance:
    """Per-thread instance for processing objects."""

    def beginInstance(self):
        """Initialize the instance.
        
        Called when the instance is first created.
        """
        engLib.debug('My node: beginInstance')

    def renderObject(self, object):
        """Process an object.
        
        Args:
            object: The object to process.
        """
        try:
            # Begin framing
            self.instance.sendTagBeginObject()
            self.instance.sendTagBeginStream()

            # Process the object
            engLib.debug(f'Processing: {object.url}')

            # Add metadata
            self.instance.sendTagMetadata({
                'processed_by': 'my_node',
                'status': 'success'
            })

            # Send data
            data = f'Processed: {object.path}'
            self.instance.sendTagData(data.encode('utf-8'))

            # End framing
            self.instance.sendTagEndStream()
            self.instance.sendTagEndObject()

        except Exception as err:
            object.completionCode(f'Processing failed: {err}')

    def endInstance(self):
        """Clean up the instance.
        
        Called when the instance is no longer needed.
        """
        engLib.debug('My node: endInstance')
```

### 5. Create `services.json`

```json
{
  "services": [
    {
      "name": "my_node",
      "type": "filter",
      "description": "My custom processing node",
      "parameters": [
        {
          "name": "option1",
          "type": "string",
          "description": "An example option",
          "required": false,
          "default": "default_value"
        }
      ]
    }
  ]
}
```

### 6. Create `requirements.txt`

```
# Dependencies for my_node
requests>=2.28.0
```

## Node Types

### Endpoint Nodes

For data sources and destinations:

```python
class IEndpoint:
    """Endpoint for connecting to a data source."""

    def beginEndpoint(self, config: dict):
        """Initialize the endpoint."""
        self.connection = create_connection(config)

    def scan(self):
        """Scan for objects.
        
        Yields:
            Objects found in the data source.
        """
        for item in self.connection.list():
            yield self.createObject(item)

    def endEndpoint(self):
        """Clean up the endpoint."""
        self.connection.close()
```

### Filter Nodes

For data transformation:

```python
class IInstance:
    """Filter for transforming data."""

    def filterObject(self, object):
        """Transform an object.
        
        Args:
            object: The object to transform.
        """
        # Read input data
        data = self.instance.readData()
        
        # Transform
        transformed = self.transform(data)
        
        # Write output
        self.instance.sendTagData(transformed)
```

## Testing Nodes

Create tests in `tests/`:

```python
# tests/test_my_node.py

import pytest
from nodes.my_node import IInstance


def test_render_object():
    """Test object rendering."""
    instance = IInstance()
    instance.beginInstance()
    
    # Create mock object
    mock_object = MockObject(url='test://file.txt')
    
    # Process
    instance.renderObject(mock_object)
    
    # Verify
    assert mock_object.completed
```

Run tests:

```bash
cd packages/nodes
pytest tests/test_my_node.py
```

## Best Practices

1. **Error Handling** - Use `object.completionCode()` for non-fatal errors
2. **Logging** - Use `engLib.debug()` for debug output
3. **Resources** - Clean up in `endInstance()` and `endGlobal()`
4. **Thread Safety** - IInstance is per-thread, but IGlobal is shared
5. **Documentation** - Add docstrings to all methods

## See Also

- [Architecture Overview](../architecture/README.md)
- [API Reference](../api/README.md)
- [Example Nodes](../../packages/nodes/nodes/example/)

