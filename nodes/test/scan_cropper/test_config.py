# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Config parsing: what the node does with a value it was not expecting.

A pipeline config can be hand-edited, so these functions are the boundary where
arbitrary JSON meets the detector's tunables. Their contract is that a bad value
falls back and warns — it must not kill the pipeline, and it must not travel on
either, which is the part that is easy to get wrong: `float` accepts `Infinity`
and `NaN`, and clamping does not stop them.
"""

import math
import sys
from pathlib import Path

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from scan_cropper.process import _number, _params_from_config, resolve_quality  # noqa: E402


class TestNumber:
    """One numeric field, read out of the config."""

    def test_a_good_value_is_taken_as_given(self):
        assert _number({'detectSize': 2500}, 'detectSize', 3000, int) == 2500

    def test_a_missing_field_falls_back_to_the_default(self):
        assert _number({}, 'detectSize', 3000, int) == 3000

    def test_values_are_clamped_to_the_documented_range(self):
        assert _number({'detectSize': 50}, 'detectSize', 3000, int) == 800
        assert _number({'detectSize': 99999}, 'detectSize', 3000, int) == 8000

    def test_a_numeric_string_is_accepted(self):
        """A hand-edited config quotes its numbers as often as not."""
        assert _number({'texture': '9.0'}, 'texture', 4.0, float) == 9.0

    def test_something_that_is_not_a_number_falls_back(self):
        assert _number({'texture': 'plenty'}, 'texture', 4.0, float) == 4.0
        assert _number({'texture': None}, 'texture', 4.0, float) == 4.0

    def test_infinity_on_an_integer_field_falls_back(self):
        """`int(float('inf'))` raises OverflowError, which is not a ValueError, so it
        escaped the fallback and failed the node at startup.
        """
        assert _number({'detectSize': math.inf}, 'detectSize', 3000, int) == 3000

    def test_infinity_on_a_float_field_falls_back(self):
        """Nothing raises here, and the clamp yields the ceiling — a different setting
        from the one the config asked for, so it falls back instead.
        """
        assert _number({'texture': math.inf}, 'texture', 4.0, float) == 4.0

    def test_not_a_number_falls_back(self):
        """The quiet one: every comparison against nan is false, so the clamp returns it
        untouched and each threshold reading it becomes a no-op.
        """
        assert _number({'minArea': math.nan}, 'minArea', 0.005, float) == 0.005


class TestParamsFromConfig:
    """The whole tunable set, as the node builds it."""

    def test_an_empty_config_gives_the_documented_defaults(self):
        params = _params_from_config({})

        assert params.detect_size == 3000
        assert params.texture == 4.0
        assert params.max_depth == 4

    def test_one_poisoned_field_does_not_take_the_others_with_it(self):
        params = _params_from_config({'texture': math.nan, 'maxDepth': 0})

        assert params.texture == 4.0
        assert params.max_depth == 0

    def test_every_tunable_survives_a_config_of_rubbish(self):
        rubbish = dict.fromkeys(
            ('detectSize', 'texture', 'minArea', 'maxArea', 'maxAspect', 'minRelative', 'maxDepth', 'skew'),
            'not a number at all',
        )

        params = _params_from_config(rubbish)

        assert params.skew > 0, 'the seam search divides by this'
        assert all(math.isfinite(v) for v in (params.texture, params.min_area, params.max_area))


class TestResolveQuality:
    """The `quality` field is free text, and it does not always arrive as text."""

    def test_auto_is_recognised_whatever_the_casing(self):
        assert resolve_quality('auto') == 'auto'
        assert resolve_quality('  AUTO ') == 'auto'

    def test_a_json_number_is_accepted(self):
        """`.strip()` on an int raises, so this is not the same path as a string."""
        assert resolve_quality(95) == 95

    def test_a_numeric_string_is_accepted(self):
        assert resolve_quality('80') == 80

    def test_values_are_clamped_to_the_jpeg_range(self):
        assert resolve_quality(0) == 1
        assert resolve_quality(500) == 100

    def test_anything_unrecognisable_becomes_auto(self):
        assert resolve_quality('best') == 'auto'
        assert resolve_quality(None) == 'auto'

    def test_non_finite_values_become_auto(self):
        assert resolve_quality(math.inf) == 'auto'
        assert resolve_quality(math.nan) == 'auto'
