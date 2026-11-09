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

"""Config resolution: what reaches the algorithm, and what the resolver refuses before it can.

The tunables used to be clamped and defaulted by the node itself. The schema now
carries every default and range, and the resolver enforces them, so a value the
algorithm was never tried at never arrives: it fails validation with the key
named. The quality field stays free text and keeps its own normalisation.
"""

import math
import sys
from pathlib import Path

import pytest
import rocketlib
from rocketlib.config import ConfigError, resolveConfig

NODES_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

pytest.importorskip('cv2', reason='process.py imports the imaging stack at module scope')

from scan_cropper.process import _params_from_config, resolve_quality  # noqa: E402


def _resolve(conn_config):
    """Resolve a stored config exactly as IGlobal.beginGlobal() would."""
    return resolveConfig(rocketlib.getServiceSchema('scan_cropper'), conn_config)


class TestParamsFromConfig:
    """The whole tunable set, as the node builds it from the resolved config."""

    def test_an_empty_config_gives_the_documented_defaults(self):
        params = _params_from_config(_resolve({}))

        assert params.detect_size == 3000
        assert params.texture == 4.0
        assert params.max_depth == 4
        assert params.min_relative == 0.4

    def test_a_scan_type_sets_its_own_values(self):
        """Loose prints never touch, so the seam search is off and smaller leftovers are kept."""
        params = _params_from_config(_resolve({'profile': 'loose'}))

        assert (params.max_depth, params.min_relative, params.texture) == (0, 0.2, 4.0)

        params = _params_from_config(_resolve({'profile': 'detail'}))
        assert (params.detect_size, params.max_depth) == (4500, 6)

    def test_a_value_stored_under_the_scan_type_wins(self):
        params = _params_from_config(_resolve({'album': {'detectSize': 800}, 'skew': 3.0}))

        assert (params.detect_size, params.skew) == (800, 3.0)

    def test_a_numeric_string_is_a_config_error(self):
        """A hand-edited config quotes its numbers as often as not; the resolver names the key."""
        with pytest.raises(ConfigError, match='texture'):
            _resolve({'album': {'texture': '9.0'}})

    def test_values_outside_the_documented_range_are_config_errors(self):
        with pytest.raises(ConfigError, match='detectSize'):
            _resolve({'album': {'detectSize': 50}})
        with pytest.raises(ConfigError, match='detectSize'):
            _resolve({'album': {'detectSize': 99999}})
        with pytest.raises(ConfigError, match='skew'):
            _resolve({'skew': 0})

    def test_a_boolean_is_not_a_number(self):
        """`bool` is a subclass of `int`, so `true` would otherwise cut a blob apart once."""
        with pytest.raises(ConfigError, match='maxDepth'):
            _resolve({'album': {'maxDepth': True}})

    def test_a_key_the_schema_does_not_declare_is_an_error(self):
        with pytest.raises(ConfigError, match='tune'):
            _resolve({'tune': True})


class TestResolveQuality:
    """The JPEG quality field: 'auto' or a number from 1 to 100."""

    def test_auto_is_auto(self):
        assert resolve_quality('auto') == 'auto'
        assert resolve_quality(' AUTO ') == 'auto'

    def test_a_number_is_clamped_to_the_jpeg_range(self):
        assert resolve_quality('95') == 95
        assert resolve_quality(95) == 95
        assert resolve_quality('250') == 100
        assert resolve_quality(0) == 1

    def test_rubbish_falls_back_to_auto(self):
        assert resolve_quality('plenty') == 'auto'
        assert resolve_quality(math.inf) == 'auto'
