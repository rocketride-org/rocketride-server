"""
Unit tests for ``ai.common.llm_native_stream`` Anthropic thinking-config gates.

Regression coverage for the Claude 5 HTTP 400 bug (GitHub issue #1911): the
engine sent ``thinking: {type: 'enabled', budget_tokens: N}`` to every model
that wasn't Opus 4.7/4.8, but Claude 4.7+ — including the whole Claude 5
family — rejects that shape with::

    "thinking.type.enabled" is not supported for this model. Use
    "thinking.type.adaptive" and "output_config.effort" to control thinking
    behavior.

The fix inverts the gate into an explicit legacy allowlist so unknown and
future model names default to the current adaptive shape.

Covers:

- ``gate_model_name`` — vendor routing-prefix stripping.
- ``build_anthropic_thinking_kwargs`` — per-model-family thinking shape,
  legacy budget arithmetic, and the Claude 3/3.5 Haiku exclusion (Haiku 4.5
  supports thinking, legacy shape only).
- Group invariants over the ``llm_anthropic`` node's ``services.json`` profile
  enum: every enum model must have a declared expected shape here, so adding a
  profile without deciding its thinking shape fails the suite.
"""

from pathlib import Path

import json5
import pytest

from ai.common.llm_native_stream import (
    _anthropic_base_model_id,
    build_anthropic_thinking_kwargs,
    gate_model_name,
)

# Default output-token window used where the test only cares about the shape.
_OUT = 8192

_ADAPTIVE = {'type': 'adaptive', 'display': 'summarized'}


# ---------------------------------------------------------------------------
# gate_model_name — vendor prefix stripping
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'raw, expected',
    [
        ('claude-sonnet-5', 'claude-sonnet-5'),
        ('anthropic/claude-sonnet-5', 'claude-sonnet-5'),
        ('openrouter/anthropic/claude-sonnet-5', 'claude-sonnet-5'),
        ('vertex_ai/claude-opus-4-6', 'claude-opus-4-6'),
        ('  Claude-Fable-5  ', 'claude-fable-5'),
        ('', ''),
    ],
)
def test_gate_model_name_strips_vendor_prefixes(raw, expected):
    assert gate_model_name(raw) == expected


# ---------------------------------------------------------------------------
# Claude 5 family — must get adaptive, never enabled/budget_tokens (the bug)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'model',
    [
        'claude-sonnet-5',
        'claude-opus-5',
        'claude-opus-5-fast',
        'claude-fable-5',
        'claude-mythos-5',
        'claude-fable-latest',
        'claude-opus-latest',
        'claude-sonnet-latest',
    ],
)
def test_claude5_family_gets_adaptive(model):
    kwargs = build_anthropic_thinking_kwargs(gate_model_name(model), _OUT)
    assert kwargs == {'thinking': _ADAPTIVE}
    # The two ingredients of the 400 must be absent.
    assert 'budget_tokens' not in kwargs['thinking']
    assert 'betas' not in kwargs


@pytest.mark.parametrize(
    'model',
    [
        'openrouter/anthropic/claude-sonnet-5',
        'anthropic/claude-fable-5',
        'openrouter/claude-opus-5',
    ],
)
def test_claude5_family_gets_adaptive_behind_vendor_prefixes(model):
    kwargs = build_anthropic_thinking_kwargs(gate_model_name(model), _OUT)
    assert kwargs == {'thinking': _ADAPTIVE}


# ---------------------------------------------------------------------------
# Opus 4.7 / 4.8 — adaptive regression (pre-fix behavior preserved)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'model',
    [
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-opus-4-7-fast',
        'claude-opus-4-8-fast',
    ],
)
def test_opus_47_48_keep_adaptive(model):
    kwargs = build_anthropic_thinking_kwargs(gate_model_name(model), _OUT)
    assert kwargs == {'thinking': _ADAPTIVE}


# ---------------------------------------------------------------------------
# Legacy models — enabled + budget_tokens regression (pre-fix behavior kept)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'model',
    [
        'claude-sonnet-4-6',
        'claude-opus-4-6',
        'claude-sonnet-4-5',
        'claude-opus-4-5',
        'claude-opus-4-1',
        'claude-opus-4',
        'claude-sonnet-4',
        'claude-opus-4-0',
        'claude-sonnet-4-0',
        'claude-haiku-4-5',
        # Resolves to Haiku 4.5, which only accepts the legacy shape.
        'claude-haiku-latest',
        'claude-mythos-preview',
        'openrouter/anthropic/claude-haiku-4-5',
        # Dated full ids
        'claude-opus-4-20250514',
        'claude-sonnet-4-20250514',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5-20251001',
        'claude-3-5-sonnet-20241022',
        'claude-3-7-sonnet-20250219',
    ],
)
def test_legacy_models_keep_enabled_shape(model):
    kwargs = build_anthropic_thinking_kwargs(gate_model_name(model), _OUT)
    assert kwargs['thinking'] == {'type': 'enabled', 'budget_tokens': 4096}
    assert kwargs['betas'] == ['interleaved-thinking-2025-05-14']


# ---------------------------------------------------------------------------
# Claude 3 / 3.5 Haiku — never get thinking parameters (Haiku 4.5 does, above)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'model',
    [
        'claude-3-haiku',
        'claude-3-haiku-20240307',
        'claude-3-5-haiku-20241022',
        'openrouter/anthropic/claude-3-haiku',
    ],
)
def test_claude3_haiku_never_gets_thinking(model):
    assert build_anthropic_thinking_kwargs(gate_model_name(model), _OUT) == {}


# ---------------------------------------------------------------------------
# Unknown / future models — must default to adaptive (the inversion guarantee)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'model',
    [
        'claude-sonnet-6',
        'claude-opus-6',
        'claude-fable-6',
        'claude-sonnet-5-20260901',  # hypothetical dated Claude 5 id
        'claude-newfamily-1',
    ],
)
def test_unknown_future_models_default_to_adaptive(model):
    """A future model launch must fail toward the current API shape, not the removed one."""
    kwargs = build_anthropic_thinking_kwargs(gate_model_name(model), _OUT)
    assert kwargs == {'thinking': _ADAPTIVE}


@pytest.mark.parametrize(
    'model',
    [
        'claude-sonnet-4-50',  # must not be swallowed by a claude-sonnet-4-5 prefix
        'claude-opus-4-20',  # must not be swallowed by a claude-opus-4-2 prefix
        'claude-opus-4-10',
        'claude-haiku-4-50',
        'claude-sonnet-4-60',
        'claude-30-sonnet',  # must not be swallowed by the claude-3- family rule
    ],
)
def test_legacy_ids_match_whole_segments_not_prefixes(model):
    """Legacy matching is on the whole id, so a longer version never inherits it."""
    kwargs = build_anthropic_thinking_kwargs(gate_model_name(model), _OUT)
    assert kwargs == {'thinking': _ADAPTIVE}


@pytest.mark.parametrize(
    'model, expected_base',
    [
        ('claude-opus-4-5-20251101', 'claude-opus-4-5'),
        ('claude-opus-4-20250514', 'claude-opus-4'),
        ('claude-opus-4-8-fast', 'claude-opus-4-8'),
        ('claude-opus-5-fast', 'claude-opus-5'),
        ('claude-sonnet-4-50', 'claude-sonnet-4-50'),  # 2 digits: not a date
        ('claude-sonnet-5', 'claude-sonnet-5'),
        # Composed suffixes must reduce in either order.
        ('claude-opus-4-6-20251101-fast', 'claude-opus-4-6'),
        ('claude-opus-4-6-fast-20251101', 'claude-opus-4-6'),
    ],
)
def test_base_model_id_strips_only_dated_and_deployment_suffixes(model, expected_base):
    assert _anthropic_base_model_id(model) == expected_base


@pytest.mark.parametrize(
    'model',
    [
        'claude-opus-4-6-20251101-fast',
        'claude-opus-4-6-fast-20251101',
        'claude-haiku-4-5-20251001-fast',
        'claude-sonnet-4-5-20250929-fast',
    ],
)
def test_composed_suffix_legacy_ids_keep_enabled_shape(model):
    """A dated + deployment id is still the legacy base model, in either suffix order."""
    kwargs = build_anthropic_thinking_kwargs(gate_model_name(model), _OUT)
    assert kwargs['thinking']['type'] == 'enabled'
    assert kwargs['betas'] == ['interleaved-thinking-2025-05-14']


@pytest.mark.parametrize(
    'model',
    [
        'claude-opus-5-20260901-fast',
        'claude-sonnet-5-fast-20260901',
    ],
)
def test_composed_suffix_claude5_ids_keep_adaptive(model):
    """Composed-suffix normalization must not drag a Claude 5 id into the legacy shape."""
    kwargs = build_anthropic_thinking_kwargs(gate_model_name(model), _OUT)
    assert kwargs == {'thinking': _ADAPTIVE}


# ---------------------------------------------------------------------------
# Legacy budget arithmetic — unchanged by the fix
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'output_tokens, expected_budget',
    [
        (8192, 4096),  # half the window
        (128000, 64000),  # half the window (large)
        (4096, 2048),  # floor kicks in: max(2048, 2048)
        (3000, 2048),  # floor beats half (1500 -> 2048), still < window
        (2048, 1024),  # floor >= window -> window - 1024
    ],
)
def test_legacy_budget_computation(output_tokens, expected_budget):
    kwargs = build_anthropic_thinking_kwargs('claude-sonnet-4-6', output_tokens)
    assert kwargs['thinking'] == {'type': 'enabled', 'budget_tokens': expected_budget}
    assert kwargs['thinking']['budget_tokens'] < output_tokens


@pytest.mark.parametrize('output_tokens', [2000, 1024, 512, 0])
def test_legacy_budget_window_too_small_skips_thinking(output_tokens):
    assert build_anthropic_thinking_kwargs('claude-sonnet-4-6', output_tokens) == {}


def test_adaptive_shape_ignores_output_window():
    """Adaptive thinking has no budget, so tiny output windows must not disable it."""
    for output_tokens in (0, 512, 8192, 128000):
        kwargs = build_anthropic_thinking_kwargs('claude-sonnet-5', output_tokens)
        assert kwargs == {'thinking': _ADAPTIVE}


# ---------------------------------------------------------------------------
# Group invariants over the llm_anthropic services.json profile enum
# ---------------------------------------------------------------------------

# Expected thinking shape per model id: 'adaptive' | 'enabled' | None (no thinking).
# test_enum_models_all_declared forces every NEW enum entry to add a row here —
# deciding its shape explicitly instead of inheriting a default, which is
# exactly how the Claude 5 bug shipped.
EXPECTED_THINKING_SHAPE = {
    'claude-3-haiku': None,
    'claude-fable-5': 'adaptive',
    'claude-fable-latest': 'adaptive',
    'claude-haiku-4-5': 'enabled',
    # Alias for Haiku 4.5, which only accepts the legacy shape.
    'claude-haiku-latest': 'enabled',
    'claude-mythos-5': 'adaptive',
    'claude-mythos-preview': 'enabled',
    'claude-opus-4': 'enabled',
    'claude-opus-4-1': 'enabled',
    'claude-opus-4-5': 'enabled',
    'claude-opus-4-6': 'enabled',
    'claude-opus-4-7': 'adaptive',
    'claude-opus-4-7-fast': 'adaptive',
    'claude-opus-4-8': 'adaptive',
    'claude-opus-4-8-fast': 'adaptive',
    'claude-opus-5': 'adaptive',
    'claude-opus-5-fast': 'adaptive',
    'claude-opus-latest': 'adaptive',
    'claude-sonnet-4': 'enabled',
    'claude-sonnet-4-5': 'enabled',
    'claude-sonnet-4-6': 'enabled',
    'claude-sonnet-5': 'adaptive',
    'claude-sonnet-latest': 'adaptive',
}

_SERVICES_JSON = Path(__file__).resolve().parents[5] / 'nodes' / 'src' / 'nodes' / 'llm_anthropic' / 'services.json'


def _enum_models() -> list:
    """Extract every non-empty profile model id from the node's services.json."""
    spec = json5.loads(_SERVICES_JSON.read_text())
    profiles = spec['preconfig']['profiles']
    return sorted({p['model'] for p in profiles.values() if p.get('model')})


def test_services_json_exists():
    assert _SERVICES_JSON.is_file(), f'missing {_SERVICES_JSON}'


def test_enum_models_all_declared():
    """Every profile in the enum must have a declared expected thinking shape."""
    missing = [m for m in _enum_models() if m not in EXPECTED_THINKING_SHAPE]
    assert not missing, (
        f'services.json profiles without a declared thinking shape: {missing}. '
        'Add each to EXPECTED_THINKING_SHAPE — decide whether the model takes '
        "adaptive thinking, legacy 'enabled' + budget_tokens, or none."
    )


@pytest.mark.parametrize('model, shape', sorted(EXPECTED_THINKING_SHAPE.items()))
def test_group_every_known_model_gets_declared_shape(model, shape):
    """Group check: the builder emits the declared shape for every known enum model."""
    kwargs = build_anthropic_thinking_kwargs(gate_model_name(model), _OUT)
    if shape is None:
        assert kwargs == {}
    elif shape == 'adaptive':
        assert kwargs == {'thinking': _ADAPTIVE}
    else:  # 'enabled'
        assert kwargs['thinking']['type'] == 'enabled'
        assert 0 < kwargs['thinking']['budget_tokens'] < _OUT
        assert kwargs['betas'] == ['interleaved-thinking-2025-05-14']


def test_group_no_enum_model_gets_shape_claude5_rejects():
    """Group check: no Claude 5 / 4.7+ model may ever receive 'enabled' + budget_tokens."""
    adaptive_only = [m for m, s in EXPECTED_THINKING_SHAPE.items() if s == 'adaptive']
    offenders = []
    for model in adaptive_only:
        kwargs = build_anthropic_thinking_kwargs(gate_model_name(model), _OUT)
        if kwargs.get('thinking', {}).get('type') == 'enabled':
            offenders.append(model)
    assert not offenders, f'models sent the removed thinking shape (would 400): {offenders}'
