# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""services.json contract for ``requiresHardware`` (no server needed).

Heavy groups must say where they can run: every test group of a ``gpu`` node,
and every group listing a profile with ``memory_gb``. See
docs/development/nodes/testing.md.
"""

from pathlib import Path

import pytest

from ai.common.utils.hardware import parse_hardware_requirement

from .framework.discovery import _parse_service_json

NODES_DIR = Path(__file__).resolve().parent.parent / 'src' / 'nodes'


def _groups():
    for service_file in sorted(NODES_DIR.glob('*/service*.json')):
        data = _parse_service_json(str(service_file))
        if not data or data.get('node') != 'python':
            continue
        for key in ('test', 'fulltest'):
            raw = data.get(key)
            groups = raw if isinstance(raw, list) else [raw] if raw else []
            for index, group in enumerate(groups, start=1):
                if isinstance(group, dict):
                    test_id = f'{service_file.parent.name}:{service_file.stem}:{key}{index}'
                    yield pytest.param(data, group, id=test_id)


GROUPS = list(_groups())


@pytest.mark.parametrize('data,group', GROUPS)
def test_requires_hardware_parses(data, group):
    if 'requiresHardware' in group:
        parse_hardware_requirement(group['requiresHardware'])


@pytest.mark.parametrize('data,group', GROUPS)
def test_heavy_groups_declare_hardware(data, group):
    profiles = (data.get('preconfig') or {}).get('profiles') or {}
    sized = {
        name: profiles[name]['memory_gb']
        for name in group.get('profiles') or []
        if isinstance(profiles.get(name), dict) and profiles[name].get('memory_gb')
    }
    if 'gpu' in (data.get('capabilities') or []) or sized:
        assert 'requiresHardware' in group, (
            'declare requiresHardware for this group: an object naming where it can run, '
            'or false when it needs no special hardware'
        )

    requirement = parse_hardware_requirement(group.get('requiresHardware'))
    for name, memory_gb in sized.items():
        assert requirement is not None, f'profile {name} declares memory_gb, so requiresHardware cannot be false'
        cuda = requirement.devices.get('cuda')
        if cuda is not None:
            assert cuda.vram_gb is not None and cuda.vram_gb >= memory_gb, (
                f'profile {name}: cuda.vramGb must be at least its memory_gb ({memory_gb})'
            )
        for device in ('mps', 'cpu'):
            spec = requirement.devices.get(device)
            if spec is not None:
                assert spec.ram_gb is not None and spec.ram_gb >= memory_gb, (
                    f'profile {name}: {device}.ramGb must be at least its memory_gb ({memory_gb})'
                )
