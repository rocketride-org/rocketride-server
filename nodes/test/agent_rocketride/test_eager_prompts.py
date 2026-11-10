# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The planning prompt that sends every tool's full schema stays byte for byte the same.

fixtures/eager_prompts.json holds the prompt of each scenario in eager_scenarios.py,
recorded once on the code before the tool catalog budget existed. Regenerate it only
for an intended change to that prompt:

    RR_REGEN_EAGER_FIXTURES=1 ./builder nodes:test --pytest-pattern="regenerate_eager_fixtures" --pytest-parallel=off
"""

import difflib
import hashlib
import json
import os
from pathlib import Path

import pytest
from eager_scenarios import SCENARIOS, render

_FIXTURE = Path(__file__).resolve().parent / 'fixtures' / 'eager_prompts.json'
_REGEN = os.environ.get('RR_REGEN_EAGER_FIXTURES') == '1'


@pytest.mark.skipif(not _REGEN, reason='writes the fixtures; set RR_REGEN_EAGER_FIXTURES=1')
def test_regenerate_eager_fixtures(wave):
    """Write every scenario's prompt, in one process, to the fixture file."""
    out = {}
    for name in SCENARIOS:
        prompt = render(wave, name)
        out[name] = {'sha256': hashlib.sha256(prompt.encode('utf-8')).hexdigest(), 'prompt': prompt}
    _FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    _FIXTURE.write_text(json.dumps(out, ensure_ascii=True, indent=1) + '\n', encoding='utf-8')


@pytest.mark.skipif(_REGEN, reason='the fixtures are being regenerated')
@pytest.mark.parametrize('name', SCENARIOS)
def test_eager_prompt_is_byte_identical(wave, name):
    """The prompt equals the recorded one; on a difference the failure shows a diff."""
    expected = json.loads(_FIXTURE.read_text(encoding='utf-8'))[name]['prompt']
    actual = render(wave, name)
    if actual != expected:
        diff = '\n'.join(
            difflib.unified_diff(expected.splitlines(), actual.splitlines(), 'recorded', 'now', lineterm='')
        )
        pytest.fail(f'the {name} prompt changed:\n{diff}')
