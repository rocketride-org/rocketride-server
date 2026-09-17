# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Gating of the dynamic node tests: environment, native libraries, hardware.

Pure functions over discovered configs and a hardware snapshot, so the
controller and every xdist worker reach identical decisions (xdist appends the
``xdist_group`` name to test ids, so those must match across workers).
"""

import time
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Set, Tuple
from urllib.parse import urlparse

from ai.common.utils.hardware import (
    DEVICE_CLASSES,
    CudaMemory,
    HardwareSnapshot,
    check_hardware,
    parse_hardware_requirement,
    probe_cuda_memory,
    probe_hardware,
)

from .discovery import NodeTestConfig

ENV_DEVICE = 'ROCKETRIDE_TEST_DEVICE'
ENV_VRAM_GB = 'ROCKETRIDE_TEST_VRAM_GB'
ENV_RAM_GB = 'ROCKETRIDE_TEST_RAM_GB'
ENV_STRICT = 'ROCKETRIDE_TEST_HARDWARE_STRICT'
ENV_LANES = 'ROCKETRIDE_TEST_HW_LANES'

# Skip reasons are prefixed with their category, e.g. "[hardware] caption:qwen3-vl-4b: ...".
CATEGORIES = ('hardware', 'remote', 'env', 'libs', 'marker')

# Test file -> services.json key its parameters come from.
FILE_KEYS = {'test_dynamic.py': 'test', 'test_dynamic_full.py': 'fulltest'}

PREFLIGHT_WAIT_S = 60.0

# Key under which the controller hands its snapshot to xdist workers.
WORKER_KEY = 'rocketride_hardware'

_LOOPBACK = {'', 'localhost', '127.0.0.1', '::1', '0.0.0.0'}


@dataclass
class ParamSpec:
    """One (config, profile) test parameter and how it is gated.

    Attributes:
        config: The test group.
        profile: Profile name, or None for a group without profiles.
        id: pytest parameter id.
        test_key: services.json key the group came from (``test`` / ``fulltest``).
        skip: Category-prefixed skip reason, if skipped.
        fail: Category-prefixed reason the test fails at setup, if it does.
        fail_strict: Whether ``fail`` comes from strict mode (else an invalid declaration).
        heavy: Whether the group declares ``requiresHardware`` (it then runs in a lane).
        device: Machine class the requirement was met on.
        need_gb: Memory the test consumes on that class.
        timeout: Longest timeout declared for the group or the machine class.
    """

    config: NodeTestConfig
    profile: Optional[str]
    id: str
    test_key: str
    skip: Optional[str] = None
    fail: Optional[str] = None
    fail_strict: bool = False
    heavy: bool = False
    device: Optional[str] = None
    need_gb: Optional[float] = None
    timeout: Optional[int] = None

    @property
    def key(self) -> str:
        """Session-unique key: the id alone repeats across ``test`` and ``fulltest``."""
        return f'{self.test_key}/{self.id}'

    @property
    def runnable(self) -> bool:
        """Whether the test is neither skipped nor failed up front."""
        return self.skip is None and self.fail is None


@dataclass
class Plan:
    """Session-wide gating decisions.

    Attributes:
        snapshot: Hardware the decisions were made against.
        strict: Whether hardware misses fail instead of skip.
        specs: Every gated parameter, for both test keys.
        lanes: Heavy spec key -> lane index.
        lane_count: Number of lanes in use.
    """

    snapshot: HardwareSnapshot
    strict: bool
    specs: List[ParamSpec]
    lanes: Dict[str, int] = field(default_factory=dict)
    lane_count: int = 1

    def for_key(self, test_key: str) -> List[ParamSpec]:
        """Specs of one test key.

        Args:
            test_key: ``test`` or ``fulltest``.

        Returns:
            The specs, in discovery order.
        """
        return [s for s in self.specs if s.test_key == test_key]

    def runnable_heavy_keys(self) -> Set[str]:
        """Keys of the heavy specs that will actually run.

        Returns:
            Set of :attr:`ParamSpec.key` values.
        """
        return {s.key for s in self.specs if s.heavy and s.runnable}


def truthy(value: Optional[str]) -> bool:
    """Interpret an environment flag.

    Args:
        value: Raw variable value, or None.

    Returns:
        True for 1/true/yes/on (any case).
    """
    return (value or '').strip().lower() in ('1', 'true', 'yes', 'on')


def resolve_snapshot(environ: Mapping[str, str], uri: str) -> HardwareSnapshot:
    """Work out the hardware the test server runs on.

    Args:
        environ: Environment to read the overrides from.
        uri: Test server URI (``ROCKETRIDE_URI``).

    Returns:
        The env override when ``ROCKETRIDE_TEST_DEVICE`` is set; an unknown
        snapshot when the server is not on this machine; else a local probe.

    Raises:
        ValueError: The env override is malformed.
    """
    device = environ.get(ENV_DEVICE, '').strip().lower()
    if device:
        if device not in DEVICE_CLASSES:
            raise ValueError(f'{ENV_DEVICE}={device!r}: expected one of {", ".join(DEVICE_CLASSES)}')
        vram = _env_gb(environ, ENV_VRAM_GB)
        ram = _env_gb(environ, ENV_RAM_GB)
        return HardwareSnapshot(
            device=device,
            name='from environment',
            vram_total_gb=vram if device == 'cuda' else None,
            vram_free_gb=vram if device == 'cuda' else None,
            ram_total_gb=ram,
            ram_available_gb=ram,
            source='env',
        )
    host = (urlparse(uri).hostname or '').lower()
    if host not in _LOOPBACK:
        return HardwareSnapshot(
            device=None,
            source='unknown',
            note=f'test server {host} is remote; describe it with {ENV_DEVICE}, {ENV_VRAM_GB}, {ENV_RAM_GB}',
        )
    return probe_hardware()


def _env_gb(environ: Mapping[str, str], name: str) -> Optional[float]:
    """Read an optional positive GB value from the environment.

    Args:
        environ: Environment mapping.
        name: Variable name.

    Returns:
        The value, or None when unset.

    Raises:
        ValueError: The value is not a positive number.
    """
    raw = environ.get(name, '').strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if value <= 0:
        raise ValueError(f'{name}={raw!r}: expected a positive number of GB')
    return value


def build_specs(
    configs: Iterable[NodeTestConfig],
    test_key: str,
    snapshot: HardwareSnapshot,
    strict: bool,
    skip_nodes: Optional[Set[str]] = None,
    include_skip: Optional[Set[str]] = None,
) -> List[ParamSpec]:
    """Gate every (config, profile) pair.

    Checks run in order and the first failing one decides: environment
    variables, native libraries, then hardware. An invalid ``requiresHardware``
    always fails; an unmet one skips, or fails in strict mode.

    Args:
        configs: Discovered test groups.
        test_key: ``test`` or ``fulltest``.
        snapshot: Hardware to check against.
        strict: Whether hardware misses fail instead of skip.
        skip_nodes: Nodes excluded from the run.
        include_skip: Excluded nodes opted back in.

    Returns:
        One spec per parameter; ``debug`` and excluded nodes produce none.
    """
    specs = []
    for config in configs:
        # Release engines don't register "debug" nodes; running one only errors.
        if 'debug' in config.capabilities:
            continue
        if skip_nodes and config.node_name in skip_nodes and config.node_name not in (include_skip or ()):
            continue

        requirement = invalid = None
        try:
            requirement = parse_hardware_requirement(config.requires_hardware)
        except ValueError as exc:
            invalid = f'invalid requiresHardware in {config.service_file}: {exc}'

        skip = fail = None
        fail_strict = False
        check = None
        missing_env = config.get_missing_env_vars()
        missing_libs = [] if missing_env else config.get_missing_shared_libs()
        if invalid:
            # Before the skips: a malformed declaration is a repo bug, not a property of this machine.
            fail = ('hardware', invalid)
        elif missing_env:
            skip = ('env', f'required environment variable(s) not set: {", ".join(missing_env)}')
        elif missing_libs:
            plural = 'y' if len(missing_libs) == 1 else 'ies'
            skip = (
                'libs',
                f'required shared librar{plural} not available: {", ".join(missing_libs)}. Install the '
                f"providing system package (e.g. 'apt-get install -y libgles2' provides libGLESv2.so.2).",
            )
        elif requirement is not None:
            check = check_hardware(requirement, snapshot)
            if not check.ok:
                category = 'remote' if snapshot.device is None else 'hardware'
                if strict:
                    fail = (category, check.reason)
                    fail_strict = True
                else:
                    skip = (category, check.reason)

        met = check if check and check.ok else None
        timeout = max(config.timeout or 0, (met.timeout if met else None) or 0) or None
        for profile in config.profiles or [None]:
            test_id = config.get_test_id() if profile is None else f'{config.get_test_id()}:{profile}'
            label = config.node_name if profile is None else f'{config.node_name}:{profile}'
            specs.append(
                ParamSpec(
                    config=config,
                    profile=profile,
                    id=test_id,
                    test_key=test_key,
                    skip=f'[{skip[0]}] {label}: {skip[1]}' if skip else None,
                    fail=f'[{fail[0]}] {label}: {fail[1]}' if fail else None,
                    fail_strict=fail_strict,
                    heavy=requirement is not None or invalid is not None,
                    device=met.device if met else None,
                    need_gb=met.need_gb if met else None,
                    timeout=timeout,
                )
            )
    return specs


def lane_budget_gb(snapshot: HardwareSnapshot) -> Optional[float]:
    """Memory heavy tests may use at once.

    Args:
        snapshot: Hardware at session start.

    Returns:
        Free VRAM on cuda or available RAM elsewhere, minus a reserve; None when unknown.
    """
    if snapshot.device == 'cuda':
        if snapshot.vram_free_gb is None or snapshot.vram_total_gb is None:
            return None
        return snapshot.vram_free_gb - max(0.5, 0.05 * snapshot.vram_total_gb)
    if snapshot.device in ('mps', 'cpu'):
        if snapshot.ram_available_gb is None or snapshot.ram_total_gb is None:
            return None
        return snapshot.ram_available_gb - max(4.0, 0.1 * snapshot.ram_total_gb)
    return None


def parse_lanes(value: Optional[str]) -> str:
    """Validate ``ROCKETRIDE_TEST_HW_LANES``.

    Args:
        value: Raw variable value; unset means 1.

    Returns:
        ``'auto'`` or a positive integer as a string.

    Raises:
        ValueError: Any other value.
    """
    raw = (value or '1').strip().lower()
    if raw == 'auto':
        return raw
    if raw.isdigit() and int(raw) > 0:
        return raw
    raise ValueError(f"{ENV_LANES}={value!r}: expected 'auto' or a positive integer")


def lane_count(needs: List[Optional[float]], budget: Optional[float], workers: int, setting: str) -> int:
    """Decide how many heavy tests may run at once.

    Tests are dealt round-robin in descending need (see :func:`assign_lanes`), so
    each lane starts with its largest test and the peak is the sum of the ``k``
    largest needs; ``auto`` picks the largest ``k`` whose peak fits the budget.

    Args:
        needs: Memory need of each runnable heavy test (None when undeclared).
        budget: Memory available to them (see :func:`lane_budget_gb`).
        workers: xdist worker count.
        setting: ``'auto'`` or a fixed count (see :func:`parse_lanes`).

    Returns:
        Lane count, at least 1 and at most ``workers``.
    """
    if workers <= 1 or not needs:
        return 1
    if setting != 'auto':
        return max(1, min(int(setting), workers, len(needs)))
    if budget is None or any(n is None for n in needs):
        return 1
    used = 0.0
    k = 0
    for need in sorted(needs, reverse=True):
        if used + need > budget:
            break
        used += need
        k += 1
    return max(1, min(k, workers))


def assign_lanes(
    specs: List[ParamSpec], snapshot: HardwareSnapshot, workers: int, setting: str
) -> Tuple[Dict[str, int], int]:
    """Deal heavy tests into lanes.

    Args:
        specs: All gated specs.
        snapshot: Hardware at session start.
        workers: xdist worker count.
        setting: ``'auto'`` or a fixed count.

    Returns:
        ``(lanes, count)``: heavy spec key -> lane index (skipped heavy specs get
        lane 0 so their group name stays stable), and the lane count.
    """
    runnable = sorted((s for s in specs if s.heavy and s.runnable), key=lambda s: (-(s.need_gb or 0.0), s.key))
    k = lane_count([s.need_gb for s in runnable], lane_budget_gb(snapshot), workers, setting)
    lanes = {s.key: 0 for s in specs if s.heavy}
    lanes.update({s.key: i % k for i, s in enumerate(runnable)})
    return lanes, k


def wait_for_free_vram(
    need_gb: float,
    timeout_s: float = PREFLIGHT_WAIT_S,
    poll_s: float = 2.0,
    probe: Callable[[], Optional[CudaMemory]] = probe_cuda_memory,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> Tuple[bool, Optional[CudaMemory]]:
    """Wait until ``need_gb`` is free on cuda:0.

    Memory of a test that just finished may take a moment to drain.

    Args:
        need_gb: Free VRAM required.
        timeout_s: How long to wait.
        poll_s: Delay between probes.
        probe: VRAM probe (injectable for tests).
        clock: Monotonic clock (injectable for tests).
        sleep: Sleep function (injectable for tests).

    Returns:
        ``(ok, memory)``. ``ok`` is False when the probe keeps failing or keeps
        reporting unknown memory: the snapshot came from a working probe, so
        losing it now is an anomaly, and starting the test would only move the
        failure into the CUDA allocation.
    """
    deadline = clock() + timeout_s
    while True:
        mem = probe()
        if mem is not None and mem.free_gb is not None and mem.free_gb >= need_gb:
            return True, mem
        if clock() >= deadline:
            return False, mem
        sleep(poll_s)


def split_reason(reason: str) -> Tuple[str, str]:
    """Split a skip reason into its category and text.

    Args:
        reason: Skip reason, optionally prefixed with ``Skipped: `` and ``[category] ``.

    Returns:
        ``(category, text)``; reasons without a known prefix are ``'marker'``.
    """
    reason = reason.strip()
    if reason.startswith('Skipped: '):
        reason = reason[len('Skipped: ') :]
    if reason.startswith('['):
        category, _, text = reason[1:].partition('] ')
        if category in CATEGORIES:
            return category, text
    return 'marker', reason


def heavy_nodeids(nodeids: Iterable[str], heavy_keys: Set[str]) -> List[str]:
    """Pick the runnable heavy dynamic tests out of collected node ids.

    Args:
        nodeids: Collected pytest node ids.
        heavy_keys: :meth:`Plan.runnable_heavy_keys`.

    Returns:
        The matching node ids, in input order.
    """
    hits = []
    for nodeid in nodeids:
        path, _, rest = nodeid.partition('::')
        test_key = FILE_KEYS.get(PurePosixPath(path.replace('\\', '/')).name)
        if not test_key or not rest.endswith(']') or '[' not in rest:
            continue
        param = rest[rest.index('[') + 1 : -1]
        if f'{test_key}/{param}' in heavy_keys:
            hits.append(nodeid)
    return hits


def format_skip_report(
    entries: List[Tuple[str, str, str, Optional[str]]], selected: int, plan: Plan, only: Optional[str]
) -> List[str]:
    """Render the ``--list-skipped`` report.

    Args:
        entries: ``(nodeid, category, text, note)`` per listed test; ``note``
            says why a test fails instead of skipping, else None.
        selected: Number of selected tests.
        plan: Session plan (for the hardware line).
        only: Category to show, or ``'all'``/None.

    Returns:
        Report lines, grouped by category.
    """
    shown = [e for e in entries if only in (None, 'all') or e[1] == only]
    lines = [
        f'hardware: {plan.snapshot.describe()}; strict: {"on" if plan.strict else "off"}',
        '',
    ]
    if not shown:
        lines.append('No selected test will be skipped' + ('' if only in (None, 'all') else f' for [{only}]') + '.')
    for category in CATEGORIES:
        group = [e for e in shown if e[1] == category]
        if not group:
            continue
        lines.append(f'[{category}] {len(group)}')
        for nodeid, _, text, note in sorted(group, key=lambda e: e[:3]):
            suffix = f'  ({note})' if note else ''
            lines.append(f'  {nodeid}')
            lines.append(f'      {text}{suffix}')
    lines.append('')
    lines.append(
        f'{len(shown)} of {selected} selected test(s) listed. Skips decided while a test runs '
        '(e.g. server not available) are not predicted.'
    )
    return lines
