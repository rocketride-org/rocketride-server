# =============================================================================
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
Node configuration resolution.

The engine resolves a node's ``services.json`` into a schema whose every leaf
carries a dotted ``path`` and whose ``params`` array lists the leaves a
pipeline may expose as parameters. ``resolveConfig`` takes that schema and the
node's connection config (a tree addressed by those paths) and produces the
one object a node reads: a ``ConfigView``.

The pass is: read selector values -> mark reachable branches -> defaults from
reachable leaves -> merge the connection config by path (non-None wins) ->
validate every leaf against its descriptor -> flatten to the active branch so
the node never sees branches. Unknown keys are hard errors naming the key; a
declared key under a branch that is not selected is tolerated and left alone,
so switching the selector back finds that branch's values intact. Defaults are
never written back anywhere: an unset key means "use the default", so a node
shipping a better default later flows through.

This module is pure Python with no engine dependency, so the same validator
serves the engine subprocess, the editor's validate command, publish, and the
per-call parameter filter.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Tuple

# ==== Constants ==============================================================

#: A ``${ROCKETRIDE_*}`` placeholder inside a config VALUE. Such a value is
#: resolved per caller at read time, so it is never baked at global scope.
ENV_PLACEHOLDER = re.compile(r'\$\{(ROCKETRIDE_[A-Za-z0-9_]*)\}')

#: Root-level keys the editor owns that are not node configuration.
EDITOR_OWNED_KEYS = frozenset({'name'})

#: Property types whose stored value is never validated: the resolved value of
#: a constant is always its default, and the rest are credential- or
#: upload-shaped placeholders the Phase 2 gateway owns.
UNCHECKED_TYPES = frozenset({'constant', 'oauth2', 'upload', 'secret', 'env', 'null', 'auto', 'semantic'})

#: The PROTOCOL_CAPS bit a node carries once it is certified reentrant-safe
#: (MULTITENANT = BIT(17) in engine-core/apLib/url/Url.hpp). The resolved
#: schema's "capabilities" is the PROTOCOL_CAPS int bitmask. Taken from the
#: engine's PROTOCOL_CAPS when this module runs inside it; the literal keeps
#: the module pure for the validators that run without an engine.
try:
    from .types import PROTOCOL_CAPS as _PROTOCOL_CAPS

    MULTITENANT_BIT = int(getattr(_PROTOCOL_CAPS, 'MULTITENANT', 1 << 17))
except ImportError:
    MULTITENANT_BIT = 1 << 17


# ==== Errors =================================================================


class ConfigError(ValueError):
    """A node configuration does not fit its schema. Hard error at validate AND execute."""


class TenancyViolation(Exception):
    """A node read per-caller data where only shared state may live. Carries a teaching message."""


# ==== Schema walk ============================================================


@dataclass(frozen=True)
class _Leaf:
    """One resolvable value in the schema."""

    path: str
    descriptor: Dict[str, Any]

    @property
    def name(self) -> str:
        """The short name a node reads: the last path segment."""
        return self.path.rsplit('.', 1)[-1]


@dataclass
class _Selector:
    """An enum-with-property-sets: its own leaf plus the branches it reaches."""

    path: str
    prefix: str
    branches: Tuple[str, ...]


@dataclass
class _Schema:
    """The flattened view of a resolved schema the resolver works from."""

    leaves: Dict[str, _Leaf] = field(default_factory=dict)
    selectors: Dict[str, _Selector] = field(default_factory=dict)
    prefixes: set = field(default_factory=set)

    def branch_of(self, path: str) -> Optional[Tuple[_Selector, str]]:
        """
        Return the innermost (selector, branch) whose branch holds ``path``, or None.

        A hoisted leaf sits at the selector's own level, so it starts with no
        branch prefix and belongs to no branch: it is reachable for every value
        of the selector.
        """
        best = None
        for selector in self.selectors.values():
            for branch in selector.branches:
                branch_prefix = f'{selector.prefix}{branch}.'
                if path.startswith(branch_prefix) and (best is None or len(branch_prefix) > len(best[2])):
                    best = (selector, branch, branch_prefix)
        return (best[0], best[1]) if best else None


def _parent_prefix(path: str) -> str:
    """Return the dotted prefix of a path's parent level ('' at the root)."""
    return path[: path.rindex('.') + 1] if '.' in path else ''


def _walk(properties: Any, prefix: str, schema: _Schema) -> None:
    """
    Record every leaf and selector under ``properties``.

    Step 1: a grouped subsection (``properties`` and no ``enum``) is not a leaf;
    its children resolve at ``prefix + name``.
    Step 2: everything else is a leaf at its emitted ``path`` (or, for a schema
    without paths, at ``prefix + name``). The first emission of a path wins, so
    a leaf hoisted above a selector that is still emitted inside every branch
    is recorded once.
    Step 3: a selector's branches resolve at the selector's own level, so a
    nested selector inside a branch is just a leaf of that level.
    """
    if not isinstance(properties, list):
        return
    for prop in properties:
        if not isinstance(prop, dict):
            continue
        name = prop.get('name')
        children = prop.get('properties')
        enum = prop.get('enum')

        if isinstance(children, list) and not isinstance(enum, dict):
            group_prefix = f'{prefix}{name}.' if name else prefix
            _walk(children, group_prefix, schema)
            continue

        if not name and not prop.get('path'):
            continue
        path = prop.get('path') or f'{prefix}{name}'
        if path not in schema.leaves:
            schema.leaves[path] = _Leaf(path, prop)

        if isinstance(enum, dict):
            level = _parent_prefix(path)
            schema.selectors.setdefault(path, _Selector(path, level, tuple(enum.keys())))
            for branch, body in enum.items():
                if isinstance(body, dict):
                    _walk(body.get('properties'), f'{level}{branch}.', schema)


def _index_schema(schema: Dict[str, Any]) -> _Schema:
    """Flatten a resolved schema into leaves, selectors and the prefixes that lead to them."""
    indexed = _Schema()
    _walk(schema.get('properties'), '', indexed)
    for path in indexed.leaves:
        parts = path.split('.')
        for depth in range(1, len(parts)):
            indexed.prefixes.add('.'.join(parts[:depth]))
    return indexed


# ==== Value helpers ==========================================================


def _has_placeholder(value: Any) -> bool:
    """Return True when ``value`` (or any string inside it) carries a ${ROCKETRIDE_*} placeholder."""
    if isinstance(value, str):
        return ENV_PLACEHOLDER.search(value) is not None
    if isinstance(value, dict):
        return any(_has_placeholder(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(_has_placeholder(item) for item in value)
    return False


def _expand(value: Any, env: Mapping[str, Any]) -> Any:
    """Replace every ${ROCKETRIDE_*} placeholder in ``value`` from ``env``; unknown names stay as written."""
    if isinstance(value, str):

        def _sub(match: re.Match) -> str:
            name = match.group(1)
            return str(env[name]) if name in env else match.group(0)

        return ENV_PLACEHOLDER.sub(_sub, value)
    if isinstance(value, dict):
        return {key: _expand(item, env) for key, item in value.items()}
    if isinstance(value, list):
        return [_expand(item, env) for item in value]
    return value


def _enum_values(enum: Any) -> Optional[List[Any]]:
    """Return the allowed values of an enum member in any of its three forms, or None."""
    if isinstance(enum, dict):
        return list(enum.keys())
    if isinstance(enum, list):
        return [item[0] if isinstance(item, (list, tuple)) and item else item for item in enum]
    return None


def _coerce(value: Any, descriptor: Dict[str, Any]) -> Any:
    """Coerce an expanded placeholder string to the leaf's declared scalar type."""
    kind = descriptor.get('type')
    if not isinstance(value, str) or kind not in ('number', 'integer', 'boolean'):
        return value
    text = value.strip()
    try:
        if kind == 'integer':
            return int(text)
        if kind == 'number':
            return float(text) if ('.' in text or 'e' in text.lower()) else int(text)
    except ValueError:
        return value
    lowered = text.lower()
    if lowered in ('true', '1', 'yes', 'on'):
        return True
    if lowered in ('false', '0', 'no', 'off'):
        return False
    return value


def _type_error(kind: str, value: Any) -> Optional[str]:
    """Return a message when ``value`` is not of schema type ``kind``, else None."""
    checks = {
        'string': lambda v: isinstance(v, str),
        'boolean': lambda v: isinstance(v, bool),
        'integer': lambda v: isinstance(v, int) and not isinstance(v, bool),
        'number': lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        'array': lambda v: isinstance(v, (list, tuple)),
        'object': lambda v: isinstance(v, dict),
    }
    check = checks.get(kind)
    if check is None or check(value):
        return None
    return f'expects {kind}, got {type(value).__name__} {value!r}'


def _validate_value(key: str, value: Any, descriptor: Dict[str, Any], problems: List[str]) -> None:
    """
    Check one value against its leaf descriptor, appending any problem to ``problems``.

    Step 1: required leaves need a value. Step 2: a placeholder-bearing value is
    typed only once expanded, so it passes here. Step 3: type, enum, bounds.
    """
    kind = descriptor.get('type')
    if value is None or value == '':
        if descriptor.get('required') and kind not in UNCHECKED_TYPES:
            problems.append(f'"{key}" is required')
        return
    if kind in UNCHECKED_TYPES or _has_placeholder(value):
        return

    mismatch = _type_error(kind, value)
    if mismatch:
        problems.append(f'"{key}" {mismatch}')
        return

    allowed = _enum_values(descriptor.get('enum'))
    if allowed is not None and value not in allowed:
        problems.append(f'"{key}" must be one of {allowed}, got {value!r}')

    if kind in ('number', 'integer'):
        if 'minimum' in descriptor and value < descriptor['minimum']:
            problems.append(f'"{key}" must be >= {descriptor["minimum"]}, got {value!r}')
        if 'maximum' in descriptor and value > descriptor['maximum']:
            problems.append(f'"{key}" must be <= {descriptor["maximum"]}, got {value!r}')
    elif kind == 'string':
        if 'minLength' in descriptor and len(value) < descriptor['minLength']:
            problems.append(f'"{key}" must be at least {descriptor["minLength"]} characters')
        if 'maxLength' in descriptor and len(value) > descriptor['maxLength']:
            problems.append(f'"{key}" must be at most {descriptor["maxLength"]} characters')
    elif kind == 'array':
        if 'minItems' in descriptor and len(value) < descriptor['minItems']:
            problems.append(f'"{key}" must have at least {descriptor["minItems"]} items')
        if 'maxItems' in descriptor and len(value) > descriptor['maxItems']:
            problems.append(f'"{key}" must have at most {descriptor["maxItems"]} items')
        item = descriptor.get('item') or descriptor.get('items')
        if isinstance(item, dict) and item.get('type') not in (None, 'array', 'object'):
            for index, element in enumerate(value):
                _validate_value(f'{key}[{index}]', element, item, problems)


# ==== ConfigView =============================================================


class ConfigView(Mapping):
    """
    The one object a node reads its configuration from.

    Read-only, with attribute and item access (``config.model``,
    ``settings['maxEdge']``), and SCHEMA-ONLY: a key the schema does not declare
    is an ``AttributeError``/``KeyError``, never a silent None. The view knows
    which keys are ``param``-flagged and which hold a per-caller
    ``${ROCKETRIDE_*}`` value, so ``IGlobal.config`` can refuse them with a
    teaching message while ``settings`` serves them.
    """

    __slots__ = (
        '_values',
        '_descriptors',
        '_paths',
        '_param_keys',
        '_env_keys',
        '_params',
        '_capabilities',
        '_refuse_params',
        '_refuse_env',
    )

    def __init__(
        self,
        values: Dict[str, Any],
        descriptors: Dict[str, Dict[str, Any]],
        paths: Dict[str, str],
        params: List[Dict[str, Any]],
        capabilities: int = 0,
        *,
        refuse_params: bool = False,
        refuse_env: bool = False,
    ):
        """
        Build a view. Callers use ``resolveConfig``; this is the resolver's constructor.

        Args:
            values (dict): Flattened short name -> resolved value.
            descriptors (dict): Short name -> the leaf descriptor it came from.
            paths (dict): Short name -> the leaf's dotted path.
            params (list): The node's self-contained ``params`` descriptors.
            capabilities (int): The node's PROTOCOL_CAPS bitmask.
            refuse_params (bool): Raise ``TenancyViolation`` on param-flagged keys.
            refuse_env (bool): Raise ``TenancyViolation`` on env-valued keys.
        """
        object.__setattr__(self, '_values', dict(values))
        object.__setattr__(self, '_descriptors', dict(descriptors))
        object.__setattr__(self, '_paths', dict(paths))
        object.__setattr__(self, '_params', list(params))
        object.__setattr__(self, '_capabilities', int(capabilities))
        object.__setattr__(self, '_refuse_params', refuse_params)
        object.__setattr__(self, '_refuse_env', refuse_env)
        object.__setattr__(
            self, '_param_keys', frozenset(key for key, desc in descriptors.items() if desc.get('param'))
        )
        object.__setattr__(
            self, '_env_keys', frozenset(key for key, value in values.items() if _has_placeholder(value))
        )

    # ---- Mapping protocol ------------------------------------------------

    def __getitem__(self, key: str) -> Any:
        """Return the resolved value of ``key``; unknown keys raise ``KeyError``."""
        if key not in self._values:
            raise KeyError(self._unknown_message(key))
        self._refuse(key)
        return self._values[key]

    def __getattr__(self, name: str) -> Any:
        """Return the resolved value of ``name``; unknown keys raise ``AttributeError``."""
        if name.startswith('_') or name not in self._values:
            raise AttributeError(self._unknown_message(name))
        self._refuse(name)
        return self._values[name]

    def __iter__(self) -> Iterator[str]:
        """Iterate the declared keys."""
        return iter(self._values)

    def __len__(self) -> int:
        """Return the number of declared keys."""
        return len(self._values)

    def __contains__(self, key: object) -> bool:
        """Return True when ``key`` is a declared key of the active branch."""
        return key in self._values

    def __repr__(self) -> str:
        """Show the declared keys without forcing any refusal."""
        return f'ConfigView({sorted(self._values)})'

    # ---- Read-only --------------------------------------------------------

    def __setattr__(self, name: str, value: Any) -> None:
        """Refuse writes: the view is a snapshot the node never edits."""
        raise TypeError(f'ConfigView is read-only; cannot set "{name}"')

    def __delattr__(self, name: str) -> None:
        """Refuse deletes."""
        raise TypeError(f'ConfigView is read-only; cannot delete "{name}"')

    def __setitem__(self, key: str, value: Any) -> None:
        """Refuse writes."""
        raise TypeError(f'ConfigView is read-only; cannot set "{key}"')

    def __delitem__(self, key: str) -> None:
        """Refuse deletes."""
        raise TypeError(f'ConfigView is read-only; cannot delete "{key}"')

    # ---- What the view knows ----------------------------------------------

    @property
    def param_keys(self) -> frozenset:
        """The keys flagged ``param`` in the schema: readable only through ``settings``."""
        return self._param_keys

    @property
    def env_keys(self) -> frozenset:
        """The keys whose value carries a ``${ROCKETRIDE_*}`` placeholder."""
        return self._env_keys

    @property
    def params(self) -> List[Dict[str, Any]]:
        """The node's self-contained ``params`` descriptors, as the engine emitted them."""
        return list(self._params)

    @property
    def capabilities(self) -> int:
        """The node's PROTOCOL_CAPS bitmask (test bits with ``caps & PROTOCOL_CAPS.X``)."""
        return self._capabilities

    def path_of(self, key: str) -> str:
        """Return the dotted schema path of a short key."""
        if key not in self._paths:
            raise KeyError(self._unknown_message(key))
        return self._paths[key]

    def descriptor_of(self, key: str) -> Dict[str, Any]:
        """Return the leaf descriptor a short key resolved from."""
        if key not in self._descriptors:
            raise KeyError(self._unknown_message(key))
        return dict(self._descriptors[key])

    def to_dict(self) -> Dict[str, Any]:
        """Return a plain copy of every value, bypassing refusals (framework use)."""
        return dict(self._values)

    # ---- Derived views ----------------------------------------------------

    def restricted(self, *, refuse_params: bool, refuse_env: bool) -> 'ConfigView':
        """Return the same values behind the node-facing refusals of ``IGlobal.config``."""
        return ConfigView(
            self._values,
            self._descriptors,
            self._paths,
            self._params,
            self._capabilities,
            refuse_params=refuse_params,
            refuse_env=refuse_env,
        )

    def expand_env(self, env: Optional[Mapping[str, Any]]) -> 'ConfigView':
        """
        Return a view with every ``${ROCKETRIDE_*}`` placeholder filled from ``env``.

        A filled scalar is coerced to the leaf's declared type and re-validated;
        a name ``env`` does not hold stays as written.
        """
        if not env or not self._env_keys:
            return self._with_values(self._values)
        values = dict(self._values)
        problems: List[str] = []
        for key in self._env_keys:
            expanded = _expand(values[key], env)
            if not _has_placeholder(expanded):
                expanded = _coerce(expanded, self._descriptors[key])
            _validate_value(key, expanded, self._descriptors[key], problems)
            values[key] = expanded
        if problems:
            raise ConfigError('environment expansion: ' + '; '.join(problems))
        return self._with_values(values)

    def overlay(self, params: Optional[Mapping[str, Any]]) -> 'ConfigView':
        """
        Return a view with the caller's parameters applied.

        ``params`` is the server-filtered map for this node, keyed by the leaf
        path (``service.customerId``) or its short name. Only ``param``-flagged
        keys may be overlaid; anything else is a ``ConfigError`` because the
        server filter should have refused it.
        """
        if not params:
            return self._with_values(self._values)
        by_path = {path: key for key, path in self._paths.items()}
        values = dict(self._values)
        problems: List[str] = []
        for target, value in params.items():
            key = by_path.get(target, target if target in values else None)
            if key is None:
                problems.append(f'"{target}" is not a config key of this node')
                continue
            if key not in self._param_keys:
                problems.append(f'"{key}" is not a parameter of this node')
                continue
            if value is None:
                continue
            _validate_value(key, value, self._descriptors[key], problems)
            values[key] = value
        if problems:
            raise ConfigError('parameters: ' + '; '.join(problems))
        return self._with_values(values)

    # ---- Internals --------------------------------------------------------

    def _with_values(self, values: Dict[str, Any]) -> 'ConfigView':
        """Clone with ``values`` and no refusals (settings never refuses)."""
        return ConfigView(values, self._descriptors, self._paths, self._params, self._capabilities)

    def _refuse(self, key: str) -> None:
        """Raise the teaching error for a key this view must not serve."""
        if self._refuse_params and key in self._param_keys:
            raise TenancyViolation(
                f'"{key}" is a parameter; read it from self.settings in IInstance. '
                'IGlobal.config holds only values shared by every caller.'
            )
        if self._refuse_env and key in self._env_keys:
            raise TenancyViolation(
                f'"{key}" is set from the caller\'s environment (${{ROCKETRIDE_*}}); read it from '
                'self.settings in IInstance. IGlobal.config holds only values shared by every caller.'
            )

    def _unknown_message(self, key: str) -> str:
        """Compose the schema-only miss message."""
        return f'"{key}" is not a config key of this node; declared keys: {sorted(self._values)}'


# ==== Resolver ===============================================================


def _flatten_conn_config(
    conn_config: Any, prefix: str, indexed: _Schema, out: Dict[str, Any], problems: List[str]
) -> None:
    """Walk the stored tree, recording leaf values by path and reporting keys the schema has no place for."""
    if not isinstance(conn_config, dict):
        if conn_config is not None:
            problems.append(f'"{prefix.rstrip(".")}" must be a group of settings, got {type(conn_config).__name__}')
        return
    for key, value in conn_config.items():
        path = f'{prefix}{key}'
        if path in indexed.leaves:
            out[path] = value
        elif path in indexed.prefixes:
            if value is None:
                continue
            _flatten_conn_config(value, f'{path}.', indexed, out, problems)
        elif not prefix and key in EDITOR_OWNED_KEYS:
            continue
        else:
            problems.append(f'unknown config key "{path}"')


def resolveConfig(schema: Dict[str, Any], connConfig: Any) -> ConfigView:
    """
    Resolve a node's stored configuration against its engine-resolved schema.

    Args:
        schema (dict): The resolved service schema (``engLib.getServiceDefinition``):
            ``properties`` with a ``path`` on every leaf, ``params`` descriptors,
            and the node's ``capabilities`` bitmask.
        connConfig (dict): The node's config as the pipeline stores it, a tree
            addressed by the leaf paths. Already native (``IJson.toDict``).

    Returns:
        ConfigView: Defaults + stored values, validated and flattened to the active branch.

    Raises:
        ConfigError: Unknown key, a selector value with no branch, a
            type/range/enum/required/length violation on a reachable leaf, or
            two reachable leaves sharing a short name. Every problem found is
            listed in the one message.
    """
    if not isinstance(schema, dict):
        raise ConfigError('schema must be a dict')
    indexed = _index_schema(schema)
    problems: List[str] = []

    # Step 1: the stored tree, by path. Unknown keys are reported here.
    stored: Dict[str, Any] = {}
    _flatten_conn_config(connConfig or {}, '', indexed, stored, problems)

    # Step 2: the effective value of every path - stored non-None wins over the default.
    def value_of(path: str) -> Any:
        leaf = indexed.leaves[path]
        if leaf.descriptor.get('type') == 'constant':
            return leaf.descriptor.get('default')
        value = stored.get(path)
        return leaf.descriptor.get('default') if value is None else value

    # Step 3: reachability. A path under a branch is reachable when its selector
    # is reachable and holds that branch; a hoisted leaf is under no branch.
    reach_cache: Dict[str, bool] = {}

    def reachable(path: str) -> bool:
        if path in reach_cache:
            return reach_cache[path]
        owner = indexed.branch_of(path)
        if owner is None:
            result = True
        else:
            selector, branch = owner
            result = reachable(selector.path) and value_of(selector.path) == branch
        reach_cache[path] = result
        return result

    # Step 4: a reachable selector must point at a branch that exists.
    for selector in indexed.selectors.values():
        if not reachable(selector.path):
            continue
        choice = value_of(selector.path)
        if choice not in selector.branches:
            problems.append(
                f'"{selector.path}" is set to {choice!r}, which is not one of its options {list(selector.branches)}'
            )

    # Step 5: a stored key under a branch that is not selected is TOLERATED -
    # kept in the stored tree, not validated, not flattened - so switching the
    # selector back finds the other branch's values intact. Only a key the
    # schema does not declare at all (step 1) is an error.

    # Step 6: validate every reachable leaf and flatten to its short name.
    values: Dict[str, Any] = {}
    descriptors: Dict[str, Dict[str, Any]] = {}
    paths: Dict[str, str] = {}
    for path, leaf in indexed.leaves.items():
        if not reachable(path):
            continue
        value = value_of(path)
        _validate_value(path, value, leaf.descriptor, problems)
        name = leaf.name
        if name in paths:
            problems.append(f'"{path}" and "{paths[name]}" both resolve to "{name}"; one of them must be renamed')
            continue
        values[name] = value
        descriptors[name] = leaf.descriptor
        paths[name] = path

    if problems:
        raise ConfigError('; '.join(problems))

    capabilities = schema.get('capabilities')
    if not isinstance(capabilities, int) or isinstance(capabilities, bool):
        capabilities = 0
    params = schema.get('params')
    if not isinstance(params, list):
        params = []
    return ConfigView(values, descriptors, paths, params, capabilities)
