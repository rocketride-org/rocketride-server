# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""The fixtures of the tool_redis tests, registered once for the folder.

Develop's test modules import each fixture by name (``from ._fixtures import
client as client``). A test that then takes ``client`` as an argument shadows
that import, which ruff 0.15 reports as F811 on every such test. Registering
them here keeps the modules free of the imports.
"""

from ._fixtures import client, fake_store, store, tool  # noqa: F401
