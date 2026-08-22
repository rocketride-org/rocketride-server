# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Configuration contract tests for the Perplexity node."""

import json
import re
from pathlib import Path


_SERVICES_PATH = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'llm_perplexity' / 'services.json'


def _load_services() -> dict:
    content = _SERVICES_PATH.read_text(encoding='utf-8')
    output = []
    in_string = False
    escaped = False
    index = 0

    while index < len(content):
        char = content[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
        elif char == '/' and index + 1 < len(content) and content[index + 1] == '/':
            while index < len(content) and content[index] != '\n':
                index += 1
            continue
        output.append(char)
        index += 1

    content = re.sub(r',(\s*[}\]])', r'\1', ''.join(output))
    return json.loads(content)


def test_profile_selector_default_matches_preconfig_default():
    services = _load_services()

    assert services['fields']['perplexity.profile']['default'] == services['preconfig']['default']


def test_default_profile_is_declared_and_selectable():
    services = _load_services()
    default = services['preconfig']['default']
    selector_values = {option['value'] for option in services['fields']['perplexity.profile']['conditional']}

    assert default in services['preconfig']['profiles']
    assert default in selector_values


def test_node_test_configuration_exercises_the_default_profile():
    services = _load_services()

    assert services['test']['profiles'] == [services['preconfig']['default']]
