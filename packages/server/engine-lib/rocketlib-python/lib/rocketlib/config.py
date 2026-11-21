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

import copy
import json
import re
import threading
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, NamedTuple, Optional, Tuple

# ==== Constants ==============================================================

#: A ``${ROCKETRIDE_*}`` placeholder inside a config VALUE. The server expands
#: it from the control's environment before the config reaches the engine;
#: a value still carrying one (the editor, validation) is not validated.
ENV_PLACEHOLDER = re.compile(r'\$\{(ROCKETRIDE_[A-Za-z0-9_]*)\}')

#: Root-level keys the editor owns that are not node configuration.
EDITOR_OWNED_KEYS = frozenset({'name'})

# Written by the engine, never by a node author: the encrypted-secret
# section a stored pipeline carries at the config root. The engine decrypts
# it before a node runs, so the resolver skips it rather than reporting it
ENGINE_OWNED_KEYS = frozenset({'secureParameters'})

#: Property types whose stored value is never validated: the resolved value of
#: a constant is always its default, and the rest are credential- or
#: upload-shaped placeholders the Phase 2 gateway owns.
UNCHECKED_TYPES = frozenset({'constant', 'oauth2', 'upload', 'secret', 'env', 'null', 'auto', 'semantic'})

#: The most re-resolved views one control keeps for selector parameters (plan
#: 5.1: settings is re-resolved per distinct params map and cached on the
#: control). A call whose map is not cached resolves it again; nothing is lost.
OVERLAY_CACHE_SIZE = 64


# ==== Errors =================================================================


class ConfigError(ValueError):
    """
    A node configuration does not fit its schema, or a node read it wrongly.

    Hard error at validate AND execute. Also raised, with a teaching message,
    when a node reads a ``param``-flagged key from ``IGlobal.config``: a
    parameter is per call and lives on ``IInstance.settings``.

    Attributes:
        problems: For a refused parameter overlay, the reason per key the
            caller named (key -> reason), so a per-call filter reports each
            one by name; empty for every other error.
    """

    def __init__(self, message: str, problems: Optional[Dict[str, str]] = None):
        """
        Build the error.

        Args:
            message: The whole message.
            problems: Key -> reason for a refused parameter overlay.
        """
        super().__init__(message)
        self.problems: Dict[str, str] = dict(problems or {})


# ==== The node's identity ====================================================


class NodeInfo(NamedTuple):
    """
    The reserved ``config.node`` record: what a node is, filled by the engine (plan 5.6.4).

    Read-only, present on every ``ConfigView`` (``settings`` included). Later
    framework facts join this record, never a new attribute on the Python
    object.
    """

    id: str  #: The component id in the ``.pipe``; what ``settings`` keys its params by.
    name: str  #: The author's display name, else the id.
    provider: str  #: The logical type: the pipeline's ``provider`` word.
    physicalType: str  #: The factory the engine built: ``python``, ``cpp``, ...
    capabilities: int  #: The node's PROTOCOL_CAPS bitmask.
    controlId: str  #: The control this IGlobal serves (transient; '' for the default slot).


#: The one name no schema leaf may take: it is the identity record on every view.
RESERVED_KEY = 'node'

#: The record of a view built without an identity (a test, a bare resolve).
NO_NODE = NodeInfo(id='', name='', provider='', physicalType='', capabilities=0, controlId='')


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
    # parent path ('' for the root) -> the OWN names of its children (groups,
    # branches, leaves) as the schema declares them, so a stored key can be
    # checked as a single segment: "gpt-5.2" is a declared branch name while
    # "cloud.apikey" is two segments written flat
    children: Dict[str, set] = field(default_factory=dict)

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
            if name:
                schema.children.setdefault(prefix.rstrip('.'), set()).add(name)
                # Declared even when every child is hoisted away, so a stored
                # empty block for it is "nothing set", not an unknown key
                schema.prefixes.add(group_prefix.rstrip('.'))
            _walk(children, group_prefix, schema)
            continue

        if not name and not prop.get('path'):
            continue
        path = prop.get('path') or f'{prefix}{name}'
        if path not in schema.leaves:
            schema.leaves[path] = _Leaf(path, prop)
        own = name or path.rsplit('.', 1)[-1]
        schema.children.setdefault(_parent_prefix(path).rstrip('.'), set()).add(own)

        if isinstance(enum, dict):
            level = _parent_prefix(path)
            schema.selectors.setdefault(path, _Selector(path, level, tuple(enum.keys())))
            for branch, body in enum.items():
                if isinstance(body, dict):
                    schema.children.setdefault(level.rstrip('.'), set()).add(branch)
                    # A branch whose leaves are all hoisted still owns a block
                    schema.prefixes.add(f'{level}{branch}')
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


def _param_paths(params: Any) -> frozenset:
    """
    Return the leaf paths the ``params`` descriptors name.

    The engine strips the ``param`` flag from the resolved leaves (plan 5.1),
    so the descriptors are the one record of which leaves are parameters: a
    leaf is a parameter when a descriptor's ``field`` is its path.
    """
    if not isinstance(params, list):
        return frozenset()
    return frozenset(
        str(descriptor['field'])
        for descriptor in params
        if isinstance(descriptor, dict) and isinstance(descriptor.get('field'), str) and descriptor['field']
    )


def _segments(path: str, indexed: _Schema) -> List[str]:
    """
    Split a leaf path into the stored tree's keys, level by level.

    A declared child name may itself contain a dot (a branch named
    ``gpt-5.2``), so each level takes the longest name it declares that the
    rest of the path starts with; an undeclared level splits at the dot.
    """
    segments: List[str] = []
    parent, rest = '', path
    while rest:
        names = indexed.children.get(parent, ())
        match = max((name for name in names if rest == name or rest.startswith(f'{name}.')), key=len, default=None)
        if match is None:
            match = rest.split('.', 1)[0]
        segments.append(match)
        parent = f'{parent}.{match}' if parent else match
        rest = rest[len(match) + 1 :]
    return segments


def _set_path(tree: Dict[str, Any], segments: List[str], value: Any) -> None:
    """Write ``value`` into the stored tree at ``segments``, creating the blocks on the way."""
    node = tree
    for segment in segments[:-1]:
        child = node.get(segment)
        if not isinstance(child, dict):
            child = {}
            node[segment] = child
        node = child
    node[segments[-1]] = value


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
        # Each element against the item schema: a scalar or array item
        # directly (an array item recurses into its own item), an item that
        # is a group of resolved fields as an object of them
        item = descriptor.get('item') or descriptor.get('items')
        if not isinstance(item, dict):
            return
        fields = _group_fields(item)
        if fields is not None:
            for index, element in enumerate(value):
                _validate_object(f'{key}[{index}]', element, fields, problems)
        elif item.get('type') not in (None, 'object'):
            for index, element in enumerate(value):
                _validate_value(f'{key}[{index}]', element, item, problems)


def _thawed(value: Any) -> Any:
    """A plain copy of a parameter value: read-only mappings become dicts, tuples lists, at every depth."""
    if isinstance(value, Mapping):
        return {str(name): _thawed(member) for name, member in value.items()}
    if isinstance(value, (list, tuple)):
        return [_thawed(member) for member in value]
    return value


def _group_fields(descriptor: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
    """The resolved fields of a descriptor that is a group of them, else None."""
    fields = descriptor.get('properties')
    if isinstance(fields, list) and fields and all(isinstance(child, dict) for child in fields):
        return fields
    return None


def _selector_branches(descriptor: Dict[str, Any]) -> Optional[Dict[str, List[Dict[str, Any]]]]:
    """A selector's branches (name -> its resolved fields), else None."""
    enum = descriptor.get('enum')
    if not isinstance(enum, dict) or not any(
        isinstance(branch, dict) and isinstance(branch.get('properties'), list) for branch in enum.values()
    ):
        return None
    return {
        str(name): [child for child in (branch.get('properties') or []) if isinstance(child, dict)]
        if isinstance(branch, dict)
        else []
        for name, branch in enum.items()
    }


def _validate_object(key: str, value: Any, fields: List[Dict[str, Any]], problems: List[str]) -> None:
    """
    Check one array element whose item is a group of fields, appending any problem to ``problems``.

    Step 1: the element is an object. Step 2: it names no field the item does
    not declare (a selector's branch blocks sit beside it, named by branch).
    Step 3: every declared field validates (required included); a field that
    is itself a group is an object of its own fields, checked the same way
    (an absent one as an empty object, so its required fields count). Step 4:
    the block of the branch each selector selects is checked like a group; a
    block of a branch it does not select is refused.
    """
    if not isinstance(value, dict):
        problems.append(f'"{key}" expects object, got {type(value).__name__} {value!r}')
        return
    declared = {str(child['name']): child for child in fields if child.get('name')}
    blocks = {
        branch: (name, branch_fields)
        for name, child in declared.items()
        for branch, branch_fields in (_selector_branches(child) or {}).items()
    }
    for name in value:
        if name not in declared and name not in blocks:
            problems.append(f'"{key}" has no field "{name}"; declared: {sorted(declared)}')
    for name, child in declared.items():
        grouped = _group_fields(child)
        if grouped is not None:
            member = value.get(name)
            _validate_object(f'{key}.{name}', {} if member is None else member, grouped, problems)
        else:
            _validate_value(f'{key}.{name}', value.get(name), child, problems)
    for branch, (selector, branch_fields) in blocks.items():
        member = value.get(branch)
        if branch != value.get(selector, declared[selector].get('default')):
            if member is not None:
                problems.append(f'"{key}.{branch}" is the block of a branch "{selector}" does not select')
            continue
        _validate_object(f'{key}.{branch}', {} if member is None else member, branch_fields, problems)


# ==== Overlay support ========================================================


class _Overlays:
    """
    What a family of views shares: the schema index and the re-resolved views.

    A family is one resolution and every view derived from it (the IGlobal's
    full and restricted views, every call's settings), so a control resolves
    each distinct selector-moving parameter map once for as long as its
    IGlobal lives. Bounded: the oldest entry goes first.
    """

    def __init__(self, index: Optional[_Schema] = None) -> None:
        """
        Start with an empty cache.

        Args:
            index: The schema's index when the resolver already built it.
        """
        self._lock = threading.Lock()
        self._index: Optional[_Schema] = index
        self._views: 'OrderedDict[str, ConfigView]' = OrderedDict()

    def index_of(self, schema: Dict[str, Any]) -> _Schema:
        """Return the schema's index, built on first use."""
        with self._lock:
            if self._index is None:
                self._index = _index_schema(schema)
            return self._index

    def get(self, key: str) -> Optional['ConfigView']:
        """Return the view cached under ``key``, or None."""
        with self._lock:
            view = self._views.get(key)
            if view is not None:
                self._views.move_to_end(key)
            return view

    def put(self, key: str, view: 'ConfigView') -> None:
        """Cache ``view`` under ``key``, dropping the oldest beyond the bound."""
        with self._lock:
            self._views[key] = view
            self._views.move_to_end(key)
            while len(self._views) > OVERLAY_CACHE_SIZE:
                self._views.popitem(last=False)


def _overlay_error(problems: Dict[str, str]) -> ConfigError:
    """
    Build the one error a refused overlay raises, naming every key.

    Args:
        problems: Key -> reason; a validator's reason already opens with the
            quoted path it checked, any other is a phrase about the key.
    """
    parts = [reason if reason.startswith('"') else f'"{key}" {reason}' for key, reason in problems.items()]
    return ConfigError('parameters: ' + '; '.join(parts), problems=problems)


# ==== ConfigView =============================================================


class ConfigView(Mapping):
    """
    The one object a node reads its configuration from.

    Read-only, with attribute and item access (``config.model``,
    ``settings['maxEdge']``), and SCHEMA-ONLY: a key the schema does not declare
    is an ``AttributeError``/``KeyError``, never a silent None. The view knows
    which keys are ``param``-flagged, so ``IGlobal.config`` can refuse them
    with a teaching message while ``settings`` serves them, and which keys
    the spec sets from the environment (``${ROCKETRIDE_*}``; the server
    expands them before the config reaches the control's IGlobal).

    ``config.node`` is the one reserved group: the node's identity as a
    read-only ``NodeInfo`` (plan 5.6.4), served by attribute, item and ``in``
    on every view, derived views included. It is a record, not a declared
    key: it is not iterated and not in ``to_dict()``.

    A view the resolver built also keeps the schema and the stored tree it
    came from, so ``overlay`` can re-resolve when a call's parameters move a
    selector (plan 5.1); the re-resolutions are cached on the view per
    distinct parameter map and shared by every view derived from it.
    """

    __slots__ = (
        '_values',
        '_descriptors',
        '_paths',
        '_param_keys',
        '_param_paths',
        '_env_keys',
        '_params',
        '_capabilities',
        '_node',
        '_refuse_params',
        '_schema',
        '_stored',
        '_shared',
    )

    def __init__(
        self,
        values: Dict[str, Any],
        descriptors: Dict[str, Dict[str, Any]],
        paths: Dict[str, str],
        params: List[Dict[str, Any]],
        capabilities: int = 0,
        *,
        node: Optional[NodeInfo] = None,
        refuse_params: bool = False,
        env_keys: Optional[frozenset] = None,
        schema: Optional[Dict[str, Any]] = None,
        stored: Optional[Dict[str, Any]] = None,
        shared: Optional['_Overlays'] = None,
    ):
        """
        Build a view. Callers use ``resolveConfig``; this is the resolver's constructor.

        Args:
            values (dict): Flattened short name -> resolved value.
            descriptors (dict): Short name -> the leaf descriptor it came from.
            paths (dict): Short name -> the leaf's dotted path.
            params (list): The node's self-contained ``params`` descriptors;
                a leaf is a parameter when one names its path (the engine
                strips the flag from the leaf itself).
            capabilities (int): The node's PROTOCOL_CAPS bitmask.
            node (NodeInfo): The node's identity record (``config.node``);
                ``NO_NODE`` when the view has none.
            refuse_params (bool): Raise ``ConfigError`` on param-flagged keys.
            env_keys (frozenset): The env-valued keys of the view this one
                derives from. A derived view (overlaid, restricted) keeps
                them: which keys the environment decides is a fact of the
                SPEC, not of the values currently in them.
            schema (dict): The resolved schema the view came from; None for
                a view built without one, which cannot move a selector.
            stored (dict): The stored config tree the view came from.
            shared (_Overlays): The schema index and the re-resolution cache
                of the view this one derives from.
        """
        param_paths = _param_paths(params)
        object.__setattr__(self, '_values', dict(values))
        object.__setattr__(self, '_descriptors', dict(descriptors))
        object.__setattr__(self, '_paths', dict(paths))
        object.__setattr__(self, '_params', list(params))
        object.__setattr__(self, '_capabilities', int(capabilities))
        object.__setattr__(self, '_node', node if node is not None else NO_NODE)
        object.__setattr__(self, '_refuse_params', refuse_params)
        object.__setattr__(self, '_param_paths', param_paths)
        object.__setattr__(self, '_param_keys', frozenset(key for key, path in paths.items() if path in param_paths))
        object.__setattr__(
            self,
            '_env_keys',
            env_keys
            if env_keys is not None
            else frozenset(key for key, value in values.items() if _has_placeholder(value)),
        )
        object.__setattr__(self, '_schema', schema)
        object.__setattr__(self, '_stored', stored if stored is not None else {})
        object.__setattr__(self, '_shared', shared if shared is not None else _Overlays())

    # ---- Mapping protocol ------------------------------------------------

    def __getitem__(self, key: str) -> Any:
        """Return the resolved value of ``key`` (or the ``node`` record); unknown keys raise ``KeyError``."""
        if key == RESERVED_KEY:
            return self._node
        if key not in self._values:
            raise KeyError(self._unknown_message(key))
        self._refuse(key)
        return self._values[key]

    def __getattr__(self, name: str) -> Any:
        """Return the resolved value of ``name`` (or the ``node`` record); unknown keys raise ``AttributeError``."""
        if name == RESERVED_KEY:
            return self._node
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
        """Return True when ``key`` is a declared key of the active branch, or the ``node`` record."""
        return key == RESERVED_KEY or key in self._values

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
        """The keys of this view flagged ``param`` in the schema: readable only through ``settings``."""
        return self._param_keys

    @property
    def param_paths(self) -> frozenset:
        """The paths of every ``param``-flagged leaf of the schema, whichever branch holds it."""
        return self._param_paths

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

    def leaf_path(self, key: str) -> Optional[str]:
        """
        Return the schema path of a leaf named by ``key``, whichever branch holds it.

        Args:
            key: A leaf path (``service.customerId``), a short key of this
                view, or a short name exactly one leaf of the schema carries.

        Returns:
            The path, or None when ``key`` names no leaf (or an ambiguous short name).
        """
        index = self._index()
        if index is None:
            return self._paths.get(key) if key in self._paths else (key if key in self._paths.values() else None)
        if key in index.leaves:
            return key
        if key in self._paths:
            return self._paths[key]
        matches = [path for path, leaf in index.leaves.items() if leaf.name == key]
        return matches[0] if len(matches) == 1 else None

    def to_dict(self) -> Dict[str, Any]:
        """Return a plain copy of every value, bypassing refusals (framework use)."""
        return dict(self._values)

    # ---- Derived views ----------------------------------------------------

    def restricted(self, *, refuse_params: bool) -> 'ConfigView':
        """Return the same values behind the node-facing refusal of ``IGlobal.config``."""
        return ConfigView(
            self._values,
            self._descriptors,
            self._paths,
            self._params,
            self._capabilities,
            node=self._node,
            refuse_params=refuse_params,
            env_keys=self._env_keys,
            schema=self._schema,
            stored=self._stored,
            shared=self._shared,
        )

    def overlay(self, params: Optional[Mapping[str, Any]]) -> 'ConfigView':
        """
        Return a view with the caller's parameters applied (plan 5.1).

        ``params`` is the server-filtered map for this node, keyed by the leaf
        path (``service.customerId``) or a short name. Only ``param``-flagged
        leaves may be overlaid, each value validated against its leaf (an
        array's elements against its item). Selector parameters apply FIRST:
        when one is among them the view is RE-RESOLVED against the schema
        (``resolveConfig(schema, config + params)``), cached per distinct
        parameter map, so the branch leaves a call reaches are the ones its
        selector values select; a leaf no branch of the call reaches is
        refused. Anything the server filter should have refused raises a
        ``ConfigError`` whose ``problems`` name each key.

        Args:
            params: The node's admitted parameters, or None.

        Returns:
            ConfigView: The call's effective configuration, never refusing.

        Raises:
            ConfigError: A key that is not a parameter, a value that does not
                fit, a selector value whose branch does not resolve, or a leaf
                the call's branch set does not reach.
        """
        if not params:
            return self._with_values(self._values)

        # Step 1: each key names a param-flagged leaf and its value fits the leaf
        index = self._index()
        problems: Dict[str, str] = {}
        values_by_path: Dict[str, Any] = {}
        target_of: Dict[str, str] = {}
        for target, value in params.items():
            # A frozen caller's value arrives as read-only views; the view
            # keeps a plain private copy
            value = _thawed(value)
            path = self.leaf_path(str(target))
            if path is None:
                problems[str(target)] = 'is not a config key of this node'
                continue
            if path not in self._param_paths:
                problems[str(target)] = 'is not a parameter of this node'
                continue
            if value is None:
                continue
            descriptor = index.leaves[path].descriptor if index is not None else self._descriptors[self._short(path)]
            found: List[str] = []
            _validate_value(path, value, descriptor, found)
            if found:
                problems[str(target)] = '; '.join(found)
                continue
            values_by_path[path] = value
            target_of[path] = str(target)
        if problems:
            raise _overlay_error(problems)

        # Step 2: selector values first. One among them re-resolves the view
        # with the call's values, so the branches it reaches are the call's
        selectors = [path for path in values_by_path if index is not None and path in index.selectors]
        if selectors:
            base = self._reresolved(values_by_path, [target_of[path] for path in selectors])
        else:
            base = self

        # Step 3: every leaf must be reachable under the call's branch set; a
        # re-resolved view already holds the values, a plain overlay sets them
        shorts = {path: short for short, path in base._paths.items()}
        values = dict(base._values)
        for path, value in values_by_path.items():
            short = shorts.get(path)
            if short is None:
                problems[target_of[path]] = 'is under a branch this call does not select'
                continue
            values[short] = value
        if problems:
            raise _overlay_error(problems)
        return base._with_values(values)

    # ---- Internals --------------------------------------------------------

    def _with_values(self, values: Dict[str, Any]) -> 'ConfigView':
        """Clone with ``values`` and no refusal (settings never refuses); the env-valued keys, the node record and the schema stay."""
        return ConfigView(
            values,
            self._descriptors,
            self._paths,
            self._params,
            self._capabilities,
            node=self._node,
            env_keys=self._env_keys,
            schema=self._schema,
            stored=self._stored,
            shared=self._shared,
        )

    def _index(self) -> Optional[_Schema]:
        """Return the schema index, built once per family of views; None without a schema."""
        if self._schema is None:
            return None
        return self._shared.index_of(self._schema)

    def _short(self, path: str) -> str:
        """Return the short key of a path of this view."""
        for short, own in self._paths.items():
            if own == path:
                return short
        return path

    def _reresolved(self, values_by_path: Dict[str, Any], selector_targets: List[str]) -> 'ConfigView':
        """
        Return the view resolved again with the call's parameters in the stored tree (cached).

        Args:
            values_by_path: The validated parameter values by leaf path.
            selector_targets: The caller's keys of the selectors among them,
                named when the branch they select does not resolve.

        Returns:
            ConfigView: The re-resolved view, never refusing.

        Raises:
            ConfigError: The selected branch does not resolve (a required
                leaf without a value, for one).
        """
        index = self._index()
        key = json.dumps(sorted(values_by_path.items()), default=repr)
        cached = self._shared.get(key)
        if cached is not None:
            return cached

        # The stored tree with the call's values written at their paths,
        # resolved exactly as the control's own config was
        merged = copy.deepcopy(self._stored)
        for path, value in values_by_path.items():
            _set_path(merged, _segments(path, index), copy.deepcopy(value))
        try:
            view = resolveConfig(self._schema, merged, node=self._node)
        except ConfigError as e:
            raise _overlay_error(
                {target: f'selects a branch that does not resolve: {e}' for target in selector_targets}
            )

        # The re-resolved view keeps what the environment decides (a fact of
        # the spec) and shares the cache of the view it derives from
        derived = ConfigView(
            view._values,
            view._descriptors,
            view._paths,
            view._params,
            view._capabilities,
            node=view._node,
            env_keys=self._env_keys,
            schema=self._schema,
            stored=self._stored,
            shared=self._shared,
        )
        self._shared.put(key, derived)
        return derived

    def _refuse(self, key: str) -> None:
        """Raise the teaching error for a key this view must not serve."""
        if self._refuse_params and key in self._param_keys:
            raise ConfigError(
                f'"{key}" is a parameter; read it from self.settings in IInstance. '
                'IGlobal.config holds only the values of the control, not of one call.'
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
        if '.' in key and key not in indexed.children.get(prefix.rstrip('.'), ()):
            # Several segments written as one flat dotted key ("cloud.apikey":
            # ..., or "cloud.auth": {...}) would resolve like the nested tree,
            # but the engine's encrypt walk descends object by object and
            # would never find a secret beneath it, so it would stay plaintext.
            # Only the nested shape is accepted; a dotted key that IS a declared
            # child name (a branch block such as "gpt-5.2") is a single segment
            # and passes.
            problems.append(f'config key "{path}" must be written nested, not as one dotted key')
            continue
        if path in indexed.leaves:
            out[path] = value
        elif path in indexed.prefixes:
            if value is None:
                continue
            _flatten_conn_config(value, f'{path}.', indexed, out, problems)
        elif not prefix and (key in EDITOR_OWNED_KEYS or key in ENGINE_OWNED_KEYS):
            continue
        else:
            problems.append(f'unknown config key "{path}"')


def resolveConfig(schema: Dict[str, Any], connConfig: Any, node: Optional[NodeInfo] = None) -> ConfigView:
    """
    Resolve a node's stored configuration against its engine-resolved schema.

    Args:
        schema (dict): The resolved service schema (``engLib.getServiceSchema``):
            ``properties`` with a ``path`` on every leaf, ``params`` descriptors,
            and the node's ``capabilities`` bitmask.
        connConfig (dict): The node's config as the pipeline stores it, a tree
            addressed by the leaf paths. Native: the owned dict the engine
            hands the control's IGlobal.
        node (NodeInfo): The node's identity, served as ``config.node``.

    Returns:
        ConfigView: Defaults + stored values, validated and flattened to the active branch.

    Raises:
        ConfigError: A leaf named ``node`` (the reserved identity record),
            an unknown key, a selector value with no branch, a
            type/range/enum/required/length violation on a reachable leaf, or
            two reachable leaves sharing a short name. Every problem found is
            listed in the one message.
    """
    if not isinstance(schema, dict):
        raise ConfigError('schema must be a dict')
    indexed = _index_schema(schema)
    problems: List[str] = []

    # Step 0: the reserved name. A leaf called "node" would shadow the identity
    # record on every view, so the services.json that declares one is refused
    # at load, whatever its stored values
    for path, leaf in indexed.leaves.items():
        if leaf.name == RESERVED_KEY:
            service = schema.get('title') or schema.get('type') or 'this node'
            raise ConfigError(
                f'"{path}" in the services.json of {service!s} declares a leaf named "{RESERVED_KEY}": '
                f'that name is reserved for the node identity record (config.{RESERVED_KEY})'
            )

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

    # The view keeps the schema and its own copy of the stored tree, so a
    # call whose parameters move a selector re-resolves from them (plan 5.1)
    return ConfigView(
        values,
        descriptors,
        paths,
        params,
        capabilities,
        node=node,
        schema=schema,
        stored=copy.deepcopy(connConfig) if isinstance(connConfig, dict) else {},
        shared=_Overlays(indexed),
    )
