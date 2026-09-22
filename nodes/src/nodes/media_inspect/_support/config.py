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

"""Node configuration: profile values layered over the node's own defaults."""

from __future__ import annotations
import math

from rocketlib import warning

try:
    from rocketlib import OPEN_MODE
except ImportError:  # older engine builds
    OPEN_MODE = None


def as_bool(value, default: bool = False) -> bool:
    """Interpret value as a Boolean, returning default when value is None."""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


def load_node_config(iglobal, defaults: dict, name: str) -> dict:
    """Profile values from the pipeline config layered over the node's defaults (typed like the defaults)."""
    config = dict(defaults)
    try:
        if OPEN_MODE is not None and iglobal.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return config
    except Exception:  # noqa: BLE001
        pass
    try:
        from ai.common.config import Config

        cfg = Config.getNodeConfig(iglobal.glb.logicalType, iglobal.glb.connConfig) or {}
    except Exception as exc:  # noqa: BLE001
        warning(f'{name}: using default config: {exc}')
        return config
    for key, default in defaults.items():
        value = cfg.get(key)
        if value is None or (value == '' and not isinstance(default, str)):
            continue
        if isinstance(default, bool):
            config[key] = as_bool(value, default)
        elif isinstance(default, int):
            try:
                config[key] = int(float(value))
            except (TypeError, ValueError, OverflowError):
                pass
        elif isinstance(default, float):
            try:
                parsed = float(value)
                if math.isfinite(parsed):
                    config[key] = parsed
            except (TypeError, ValueError, OverflowError):
                pass
        else:
            config[key] = value
    return config
