# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
The pipeline ``parameters`` map and the per-call values it admits (plan 5.2, 5.4).

A ``.pipe`` exposes per-call parameters as a pure string map::

    "parameters": {"maxEdge": "depth_estimate_1.max_edge"}

public name -> ``nodeId.configKey``, where the FIRST segment is a component id
and the rest is the leaf's schema ``path`` (dotted for a leaf inside a group)
or its short key. Only a ``param``-flagged leaf may be exposed; the resolver
(``rocketlib.resolveConfig``) knows which those are, and it refuses selectors,
secrets and env-valued keys at load, so the same check covers them here.

Two readers, one rule:

- ``validate_parameters`` checks the MAP itself, at validate, execute and
  publish (plan 5.4 items 1, 3, 4): well-formed, public names
  ``[A-Za-z0-9_]+``, every target naming an existing component and a
  ``param``-flagged key of it.
- ``resolve_call_params`` turns the caller's ADMITTED params (public name ->
  value, already filtered by name against the map) into the per-node map the
  engine applies (``{nodeId: {configKey: value}}``), validating each value
  against the leaf's descriptor through the same resolver (plan 5.4 item 5,
  the descriptor half; the map half is ``TaskControl.check_params``).

Errors follow the engine's own ``errors`` shape (``id`` + ``message``), so the
validate command appends them to the same list.
"""

import re
from typing import Any, Dict, List, Mapping, Optional, Tuple

# The resolver (rocketlib + node_config) is imported where it is used: the
# publish doors run this module inside the hermetic saas test harness, which
# has no engine, and a pipeline without a parameters map never needs it.

# ==== Constants ===============================================================

#: A public parameter name (plan 5.4 item 1).
PUBLIC_NAME = re.compile(r'^[A-Za-z0-9_]+$')


# ==== Helpers ====================================================================


def parse_target(target: Any) -> Optional[Tuple[str, str]]:
    """
    Split a map value ``nodeId.configKey`` into its component id and key.

    Args:
        target: The map value.

    Returns:
        ``(node_id, key)`` (the key keeps its own dots), or None when the
        value is not a string of at least two non-empty dot-separated segments.
    """
    # Step 1: only a string can be a target (the object form {node, key} is refused)
    if not isinstance(target, str):
        return None
    # Step 2: the FIRST dot separates the component id from the key; the key
    # keeps its own dots (a leaf inside a group is addressed by its schema path)
    node_id, dot, key = target.partition('.')
    # Step 3: every segment must be non-empty ('a.', '.b' and 'a..b' are malformed)
    if not dot or not node_id or not key or '' in key.split('.'):
        return None
    return node_id, key


def _components_by_id(pipeline: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    """The pipeline's components keyed by id (malformed entries skipped)."""
    out: Dict[str, Dict[str, Any]] = {}
    for component in pipeline.get('components') or []:
        # A component without a string id cannot be a target; the engine's
        # own structural validation reports it
        if isinstance(component, dict) and isinstance(component.get('id'), str):
            out[component['id']] = component
    return out


def _view_of(component: Mapping[str, Any]):
    """The component's resolved config view, or None when its provider or config does not resolve."""
    from rocketlib import ConfigError

    from .node_config import resolve_node_config

    # Step 1: a provider name and an object (or absent) config are the
    # resolver's preconditions; anything else is the component's own error
    provider = component.get('provider')
    config = component.get('config')
    if not isinstance(provider, str) or not provider or not isinstance(config, (dict, type(None))):
        return None
    # Step 2: resolve exactly as the node does at start (defaults applied,
    # active branch only), so the param set and the paths are the node's
    try:
        return resolve_node_config(provider, config or {})
    except (ConfigError, ValueError):
        # The config's own errors are reported by the config check; a map
        # target into a component that does not resolve is not a second error
        return None


def _key_of(view, key: str) -> Optional[str]:
    """The view's short key for ``key`` given as a short key or a schema path, or None."""
    # A short key names the leaf directly
    if key in view:
        return key
    # Otherwise the key is a schema path ('service.customerId'): find the leaf
    # whose path it is. Paths are unique per node (resolver invariant).
    for short in view:
        if view.path_of(short) == key:
            return short
    return None


# ==== The map ====================================================================


def validate_parameters(pipeline: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """
    Check a pipeline's ``parameters`` map (plan 5.4 items 1, 3, 4).

    Args:
        pipeline: The pipeline dict (``components``, optional ``parameters``).

    Returns:
        Error entries ``{id, message}``; empty when the map is valid or absent.
        ``id`` is the target component when the entry names one, else
        ``'parameters'``.
    """
    # Step 1: no map is a valid map; a map that is not an object is one error
    parameters = pipeline.get('parameters')
    if parameters is None:
        return []
    if not isinstance(parameters, Mapping):
        return [{'id': 'parameters', 'message': 'parameters must be an object of public name -> nodeId.configKey'}]

    errors: List[Dict[str, Any]] = []
    components = _components_by_id(pipeline)
    # Each component's config is resolved at most once, however many names target it
    views: Dict[str, Any] = {}
    for name, target in parameters.items():
        label = str(name)
        # Step 2: the public name is what callers type (params={name: value})
        # and what the HTTP door reads off the query string: identifier-like only
        if not isinstance(name, str) or not PUBLIC_NAME.match(name):
            errors.append({'id': 'parameters', 'message': f'parameter name {label!r} must match [A-Za-z0-9_]+'})
            continue
        # Step 3: the target is nodeId.configKey, nothing else
        parsed = parse_target(target)
        if parsed is None:
            errors.append(
                {'id': 'parameters', 'message': f'parameter {label!r} must target nodeId.configKey, got {target!r}'}
            )
            continue
        # Step 4: the component must exist in THIS pipeline
        node_id, key = parsed
        component = components.get(node_id)
        if component is None:
            errors.append({'id': 'parameters', 'message': f'parameter {label!r} targets unknown component {node_id!r}'})
            continue
        # Step 5: the key must be a leaf of the node, and a param-flagged one;
        # the resolver decides both (selectors, secrets and env-valued keys are
        # never param-flagged, so one membership test covers plan 5.1's refusals)
        if node_id not in views:
            views[node_id] = _view_of(component)
        view = views[node_id]
        if view is None:
            # The component's own config error is reported with the component
            continue
        short = _key_of(view, key)
        if short is None:
            errors.append({'id': node_id, 'message': f'parameter {label!r}: {node_id!r} has no config key {key!r}'})
        elif short not in view.param_keys:
            errors.append(
                {'id': node_id, 'message': f'parameter {label!r}: {node_id}.{key} is not a per-call parameter'}
            )
    return errors


# ==== The per-call values ======================================================


def resolve_call_params(
    pipeline: Mapping[str, Any],
    parameters: Mapping[str, Any],
    admitted: Mapping[str, Any],
    views: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, str]]]:
    """
    Turn admitted per-call params into the per-node map the engine applies (plan 5.4 item 5).

    Each value is validated against its leaf's descriptor through the node's
    resolver (type, bounds, enum); a target that is not a ``param``-flagged key
    of its node is refused. Values are LITERAL: nothing is env-expanded here
    (plan 0 S5).

    Args:
        pipeline: The control's pipeline.
        parameters: The control's ``parameters`` map (public name -> target).
        admitted: The caller's params, already admitted by public name.
        views: A cache of resolved views by component id the caller keeps for
            the pipeline's life (a control's pipeline is fixed for its life),
            so the schema is resolved once per component, not once per request.
            None resolves afresh.

    Returns:
        ``(per_node, errors)``: ``{nodeId: {key: value}}`` keyed by the leaf's
        schema path, and ``[{name, reason}]`` for every refused value.
    """
    from rocketlib import ConfigError

    per_node: Dict[str, Dict[str, Any]] = {}
    errors: List[Dict[str, str]] = []
    components = _components_by_id(pipeline)
    if views is None:
        views = {}
    for name, value in admitted.items():
        # Step 1: the public name -> its target. The name was admitted against
        # the map already, so a missing or malformed target is the map's fault
        # (an older artifact), reported by name like every other refusal
        parsed = parse_target(parameters.get(name))
        if parsed is None:
            errors.append({'name': str(name), 'reason': 'the parameters map does not name a nodeId.configKey target'})
            continue
        # Step 2: the node's resolved view: the descriptors the value is checked
        # against. Resolved once per component into the caller's cache; a
        # component that does not resolve is not retried per request either
        node_id, key = parsed
        if node_id not in views:
            component = components.get(node_id)
            views[node_id] = _view_of(component) if component is not None else None
        view = views[node_id]
        if view is None:
            errors.append({'name': str(name), 'reason': f'component {node_id!r} does not resolve'})
            continue
        short = _key_of(view, key)
        if short is None:
            errors.append({'name': str(name), 'reason': f'{node_id!r} has no config key {key!r}'})
            continue
        # Step 3: the resolver's own overlay validates the value (type, bounds,
        # enum) and refuses a non-param key, so the data path and the node's
        # settings view can never disagree about what is admissible
        try:
            view.overlay({short: value})
        except ConfigError as e:
            errors.append({'name': str(name), 'reason': str(e)})
            continue
        # Step 4: keyed by the leaf's schema path, which settings.overlay reads
        per_node.setdefault(node_id, {})[view.path_of(short)] = value
    return per_node, errors
