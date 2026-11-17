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
Convert a pipeline written against the OLD node-config format to the current one.

Plan 5.6.8. The old ``services.json`` format stored a component's config as
``{"profile": "<name>", "<name>": {...}}`` or as flat keys, and the old
``Config.getNodeConfig`` merged them over the profile's defaults. The current
format stores a path-addressed tree (plan 5.6.2): selector value at its path,
branch leaves under the branch value, hoisted leaves at the root, defaults
never written. The resolver rejects every key it does not declare, so an old
pipe fails at validate, start and publish with the key named. This module
rewrites it instead, at those same doors, from the ``legacy`` block each
pre-existing node definition carries (``tools/legacy_blocks.py``).

Per component, in order:
    1. DETECT. The config is old-shape when it carries the legacy selector key,
       a profile-named block, or a key the new schema does not declare but the
       legacy block knows. A config the resolver already accepts is returned
       untouched, so the function is idempotent.
    2. FLATTEN the old way. The profile is the stored ``profile`` key, else the
       old default; the user's values are the profile-named block overlaid by
       the top-level keys (the old ``overlay_top_level`` rule). Profile
       defaults are never written back: an unset key stays unset.
    3. BRANCH. The new selector takes, in order: ``legacy.profileMap``, the
       profile name itself, the profile's own value for the selector key (an
       LLM profile's ``model``, a ``splitter``, a ``backend``), a branch named
       in the profile's ``migration`` text, and for an LLM node ``custom`` with
       ``customModel`` = the profile's model (a warning). Nothing else: an
       unmappable profile is an error.
    4. PLACE each user key at the new schema's path for the chosen branch,
       after ``legacy.renamed`` and ``legacy.credential``. Hoisting is already
       in the path the engine emits.
    5. DROP AND WARN. ``legacy.dropped`` keys and profile metadata go silently;
       a value for a now-constant leaf is removed with a warning naming it; a
       value equal to the new default and every empty string are omitted;
       declared coercions apply with a warning.
    6. REFUSE, NEVER GUESS. A key that is none of the above is an error naming
       the component, the key and the candidates. The converted config must
       resolve; a resolver error is reported as the component's error.

Pipeline level: every component id is a dot-free segment and every component
carries a ``name`` (filled from the node's title, else the id, with a
warning); the pipeline carries a ``name`` (filled from ``project_id`` with a
warning); a deleted provider is an error; the old per-node ``parameters``
block goes with the node's ``dropped`` list.

The server returns the converted text only; nothing is written back here.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Tuple

from .address import SEGMENT_PATTERN

# The engine (rocketlib) and the schema lookup are imported where they are
# used, so this module imports stdlib-only like address.py and parameters.py:
# the saas hermetic test harness loads it by file with no engine present.

# ============================================================================
# Constants
# ============================================================================

#: Providers the hard break removed (plan 12 D, B25/B26); their pipelines are
#: rewritten by hand, never converted.
DELETED_PROVIDERS = frozenset({'autopipe', 'vectorizer', 'remote', 'remote_server'})

#: Keys the old profile blocks carried that were never node config.
PROFILE_METADATA = frozenset(
    {'title', 'capabilities', 'deprecated', 'deprecatedBy', 'migration', 'modelSource', 'tokens'}
)

#: Keys at the root of a component config the resolver treats as not the node's.
OWNED_KEYS = frozenset({'name', 'secureParameters'})

#: What the OLD editor stamped on every component config: the source markers
#: and the per-node ``parameters`` stub. Kept where the new schema declares
#: them (as constants), dropped silently where it does not.
OLD_EDITOR_STAMPS = frozenset({'hideForm', 'mode', 'type', 'parameters', 'show_advanced', 'advanced_mode'})

#: The deleted sub-provider ("combo") blocks a store or vectorizer carried
#: (plan 12 D): a dict under one of these names has no new home.
COMBO_BLOCKS = frozenset({'embedding', 'store', 'preprocessor'})

#: Property types whose stored value is ignored or credential-shaped; a user
#: value on a constant is reported, the others move verbatim.
CONSTANT_TYPE = 'constant'

#: The branch an LLM node converts an unmappable profile to, carrying the
#: old model id in this leaf (plan 5.6.8, best effort).
CUSTOM_BRANCH = 'custom'
CUSTOM_MODEL_LEAF = 'customModel'

# ============================================================================
# Types
# ============================================================================

SchemaLookup = Callable[[str], Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]]


@dataclass
class ConvertResult:
    """What ``convert_pipeline`` returns: the pipeline to use, and what it did."""

    pipeline: Dict[str, Any]
    warnings: List[Dict[str, Any]] = field(default_factory=list)
    errors: List[Dict[str, Any]] = field(default_factory=list)
    touched: bool = False

    @property
    def ok(self) -> bool:
        return not self.errors

    def as_body(self) -> Dict[str, Any]:
        """The DAP body shape: ``{pipeline, warnings, errors, touched}``."""
        return {
            'pipeline': self.pipeline,
            'warnings': list(self.warnings),
            'errors': list(self.errors),
            'touched': self.touched,
        }


@dataclass
class _Leaf:
    name: str
    path: str
    descriptor: Dict[str, Any]


@dataclass
class _Selector:
    name: str
    path: str
    default: Any
    branches: Dict[str, List[Dict[str, Any]]]


@dataclass
class _Plan:
    """The new schema, indexed for one component."""

    root_leaves: Dict[str, _Leaf]
    selector: Optional[_Selector]
    branch_leaves: Dict[str, Dict[str, _Leaf]]  # branch -> short name -> leaf

    def leaves_for(self, branch: Optional[str]) -> Dict[str, _Leaf]:
        merged = dict(self.root_leaves)
        if branch is not None:
            merged.update(self.branch_leaves.get(branch, {}))
        return merged

    def elsewhere(self, short: str, branch: Optional[str]) -> List[_Leaf]:
        """The leaves named ``short`` in branches other than ``branch`` (a switched-away block's keys)."""
        return [leaves[short] for name, leaves in self.branch_leaves.items() if name != branch and short in leaves]


# ============================================================================
# Schema lookup
# ============================================================================


def default_schema_lookup(provider: str) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """The engine's resolved schema and raw definition for ``provider`` (None, None when unknown)."""
    from rocketlib import IJson, getServiceDefinition

    from ai.common.node_config import node_schema

    schema = node_schema(provider)
    if schema is None:
        return None, None
    raw = getServiceDefinition(provider)
    return schema, IJson.toDict(raw) if raw is not None else {}


def _resolves(schema: Mapping[str, Any], config: Any) -> Optional[str]:
    """Run the node's resolver over ``config``; None when it fits, else the resolver's message."""
    from rocketlib import ConfigError, IJson, resolveConfig

    try:
        resolveConfig(schema, IJson.toDict(config))
    except (ConfigError, ValueError) as error:
        return str(error)
    return None


def _index_schema(schema: Mapping[str, Any]) -> _Plan:
    """Index the resolved schema: root leaves, the root selector, each branch's leaves (hoisted ones included)."""
    root_leaves: Dict[str, _Leaf] = {}
    selector: Optional[_Selector] = None
    branch_leaves: Dict[str, Dict[str, _Leaf]] = {}

    def collect(props: Iterable[Any], into: Dict[str, _Leaf]) -> None:
        for prop in props or []:
            if not isinstance(prop, dict):
                continue
            name = prop.get('name')
            path = prop.get('path')
            if isinstance(prop.get('enum'), dict):
                # A nested selector is a leaf of its level; its branches' leaves
                # are reachable only through it and are left to the resolver
                if isinstance(name, str) and isinstance(path, str):
                    into[name] = _Leaf(name, path, prop)
                continue
            if isinstance(prop.get('properties'), list) and prop.get('type') not in ('array',):
                collect(prop['properties'], into)
                continue
            if isinstance(name, str) and isinstance(path, str):
                into[name] = _Leaf(name, path, prop)

    for prop in schema.get('properties') or []:
        if not isinstance(prop, dict):
            continue
        if isinstance(prop.get('enum'), dict) and selector is None:
            selector = _Selector(
                name=str(prop.get('name')),
                path=str(prop.get('path') or prop.get('name')),
                default=prop.get('default'),
                branches={
                    str(b): (bd.get('properties') or []) for b, bd in prop['enum'].items() if isinstance(bd, dict)
                },
            )
            for branch, props in selector.branches.items():
                leaves: Dict[str, _Leaf] = {}
                collect(props, leaves)
                branch_leaves[branch] = leaves
            continue
        collect([prop], root_leaves)
    return _Plan(root_leaves, selector, branch_leaves)


# ============================================================================
# Config tree helpers
# ============================================================================


def _set_path(tree: Dict[str, Any], path: str, value: Any) -> None:
    node = tree
    parts = path.split('.')
    for part in parts[:-1]:
        child = node.get(part)
        if not isinstance(child, dict):
            child = {}
            node[part] = child
        node = child
    node[parts[-1]] = value


def _is_default(value: Any, descriptor: Mapping[str, Any]) -> bool:
    return 'default' in descriptor and value == descriptor['default']


def _coerce(value: Any, descriptor: Mapping[str, Any]) -> Tuple[Any, Optional[str]]:
    """Coerce ``value`` to the descriptor's type where the old format was looser; (value, note)."""
    kind = descriptor.get('type')
    if kind == 'integer' and isinstance(value, float) and value.is_integer():
        return int(value), None
    if kind in ('integer', 'number') and isinstance(value, (int, float)) and not isinstance(value, bool):
        maximum = descriptor.get('maximum')
        minimum = descriptor.get('minimum')
        if isinstance(maximum, (int, float)) and value > maximum:
            return maximum, f'clamped {value!r} to the maximum {maximum!r}'
        if isinstance(minimum, (int, float)) and value < minimum:
            return minimum, f'clamped {value!r} to the minimum {minimum!r}'
    return value, None


# ============================================================================
# One component
# ============================================================================


class _Component:
    """The conversion of one component's config; collects its warnings and errors."""

    def __init__(self, component_id: str, provider: str, schema: Mapping[str, Any], legacy: Mapping[str, Any]):
        self.id = component_id
        self.provider = provider
        self.schema = schema
        self.legacy = legacy
        self.plan = _index_schema(schema)
        self.warnings: List[str] = []
        self.errors: List[str] = []
        self.profiles: Dict[str, Dict[str, Any]] = {
            str(k): v for k, v in (legacy.get('profiles') or {}).items() if isinstance(v, dict)
        }
        self.selector_key = legacy.get('selector') or 'profile'

    # ---- detection ----------------------------------------------------------

    def is_old_shape(self, config: Mapping[str, Any]) -> bool:
        # A config the resolver accepts is current, whatever its keys are
        # named (a new branch block may share a name with an old profile)
        if _resolves(self.schema, dict(config)) is None:
            return False
        # Not resolvable as written: it is OLD only when it carries a signal of
        # the old format; otherwise it is a current config with a mistake, which
        # the resolver reports at the door as before (never a conversion error)
        selector = self.plan.selector
        if self.selector_key in config and self.profiles and (selector is None or selector.name != self.selector_key):
            return True
        if any(key in self.profiles and isinstance(value, dict) for key, value in config.items()):
            return True
        known = (
            set(self.legacy.get('dropped') or [])
            | set(self.legacy.get('renamed') or {})
            | set(self.legacy.get('credential') or {})
        )
        branch_names = {name for branch in self.plan.branch_leaves.values() for name in branch}
        leaves = set(self.plan.root_leaves) | branch_names
        for key, value in config.items():
            if key in known or key.split('.')[-1] in known:
                return True
            if key in OLD_EDITOR_STAMPS and key not in leaves and (selector is None or key != selector.name):
                return True
            # The old FLAT form: a branch leaf written at the root (the old
            # default profile decided which branch it belonged to)
            if key in branch_names and key not in self.plan.root_leaves and not isinstance(value, dict):
                return True
        return False

    # ---- flatten ------------------------------------------------------------

    def flatten(self, config: Mapping[str, Any]) -> Tuple[Optional[str], Dict[str, Any]]:
        """The old merge: (profile name, the USER's values keyed the old way)."""
        profile = config.get(self.selector_key) if self.profiles else None
        if profile is None and self.profiles:
            profile = self.legacy.get('default')
        if self.profiles and (not isinstance(profile, str) or profile not in self.profiles):
            self.errors.append(
                f'profile {profile!r} is not one of the old profiles {sorted(self.profiles)} of {self.provider}'
            )
            return None, {}
        user: Dict[str, Any] = {}
        nested = config.get(profile) if isinstance(profile, str) else None
        if isinstance(nested, dict):
            user.update(nested)
        for key, value in config.items():
            if key == self.selector_key and self.profiles:
                continue
            if isinstance(key, str) and key in self.profiles and isinstance(value, dict):
                continue  # a profile block: the active one was taken above, the others are inactive
            if value is None:
                continue
            user[key] = value
        return profile, user

    def inactive_branch_blocks(self, config: Mapping[str, Any], profile: Optional[str]) -> Dict[str, Any]:
        """Old inactive profile blocks whose name is also a NEW branch: the resolver keeps them, so does the converter."""
        selector = self.plan.selector
        if selector is None:
            return {}
        return {
            key: value
            for key, value in config.items()
            if key != profile and key in selector.branches and key in self.profiles and isinstance(value, dict)
        }

    # ---- branch -------------------------------------------------------------

    def choose_branch(self, profile: Optional[str], user: Dict[str, Any]) -> Tuple[Optional[str], bool]:
        """The new branch for ``profile``; (branch, fallback_to_custom). Appends an error when none."""
        selector = self.plan.selector
        if selector is None:
            return None, False
        branches = selector.branches
        values = self.profiles.get(profile, {}) if profile is not None else {}
        # 1. The hand-verified map, then the user's own value for the selector
        #    key (an old flat `authType`, `mode`, `splitter`)
        if profile is not None:
            mapped = (self.legacy.get('profileMap') or {}).get(profile)
            if isinstance(mapped, str) and mapped in branches:
                return mapped, False
        own = user.get(selector.name)
        if isinstance(own, str) and own in branches:
            return own, False
        # ... including an old key whose rename TARGETS the selector (a boolean
        # `store_mode` that became `mode`, mapped through its value table)
        for key, value in user.items():
            target, mapped_value = self._rename(key, value, profile)
            if target != key and target == selector.name and isinstance(mapped_value, str) and mapped_value in branches:
                return mapped_value, False
        # 2. The profile name itself, then the profile's value for the selector key
        if profile is not None and profile in branches:
            return profile, False
        candidate = values.get(selector.name)
        if isinstance(candidate, str) and candidate in branches:
            return candidate, False
        # 3. The branch whose leaves fit the user's branch-only keys, when exactly one does
        root = set(self.plan.root_leaves)
        branch_only = {k.split('.')[-1] for k in user if k.split('.')[-1] not in root and k not in OLD_EDITOR_STAMPS}
        branch_only -= set(self.legacy.get('dropped') or []) | PROFILE_METADATA | {selector.name}
        if branch_only:
            fits = [b for b, leaves in self.plan.branch_leaves.items() if branch_only <= set(leaves)]
            if len(fits) == 1:
                return fits[0], False
        # 4. No old selector at all, or the one generic profile: the schema's default branch
        if profile is None or (not values or set(self.profiles) <= {profile}):
            return str(selector.default) if selector.default is not None else None, False
        migration = values.get('migration')
        if isinstance(migration, str):
            for candidate in sorted(branches, key=len, reverse=True):
                if re.search(r'(?<![\w.-])' + re.escape(candidate) + r'(?![\w.-])', migration):
                    self.warnings.append(
                        f'profile {profile!r} is retired; converted to {selector.name}={candidate!r} as its migration note says'
                    )
                    return candidate, False
        if CUSTOM_BRANCH in branches and CUSTOM_MODEL_LEAF in self.plan.branch_leaves.get(CUSTOM_BRANCH, {}):
            model = values.get('model') or user.get('model')
            if isinstance(model, str) and model:
                self.warnings.append(
                    f'profile {profile!r} has no counterpart; converted to {selector.name}={CUSTOM_BRANCH!r} '
                    f'with {CUSTOM_MODEL_LEAF}={model!r}'
                )
                user.setdefault(CUSTOM_MODEL_LEAF, model)
                return CUSTOM_BRANCH, True
        self.errors.append(
            f'profile {profile!r} of {self.provider} has no counterpart among {selector.name} values {sorted(branches)}'
        )
        return None, False

    # ---- place --------------------------------------------------------------

    def _rename(self, key: str, value: Any, profile: Optional[str]) -> Tuple[str, Any]:
        """Apply ``legacy.renamed`` / ``legacy.credential`` to one user key; returns (new key or path, value)."""
        renamed = self.legacy.get('renamed') or {}
        credential = self.legacy.get('credential') or {}
        # A key from the profile-named block is addressed as `<profile>.<key>`
        # in the legacy tables (the LLM `custom.model`), else by itself
        names = ([f'{profile}.{key}'] if profile else []) + [key, key.split('.')[-1]]
        rule = next((table[n] for table in (renamed, credential) for n in names if n in table), None)
        if rule is None:
            return key, value
        if isinstance(rule, str):
            return rule, value
        target = rule.get('to', key)
        values = rule.get('values') or {}
        text = 'true' if value is True else 'false' if value is False else str(value)
        if text in values:
            return target, values[text]
        return target, value

    def convert(self, config: Mapping[str, Any]) -> Dict[str, Any]:
        """Convert one old-shape config to the new tree; errors and warnings accumulate on self."""
        profile, user = self.flatten(config)
        if self.errors:
            return dict(config)
        branch, _ = self.choose_branch(profile, user)
        if self.errors:
            return dict(config)
        leaves = self.plan.leaves_for(branch)
        dropped = set(self.legacy.get('dropped') or [])
        out: Dict[str, Any] = {}

        # The selector itself, when the schema has one and the value is not its default
        selector = self.plan.selector
        if selector is not None and branch is not None and branch != selector.default:
            _set_path(out, selector.path, branch)
        # A switched-away block that names a real branch survives as it is (plan 5.6.2)
        for key, block in self.inactive_branch_blocks(config, profile).items():
            out[key] = copy.deepcopy(block)

        # A worklist: an old nested group (`parameters: {botToken: ...}`) is
        # expanded into its dotted keys and placed leaf by leaf
        pending = list(user.items())
        while pending:
            key, value = pending.pop(0)
            if key in OWNED_KEYS:
                out[key] = value
                continue
            if key.split('.')[-1] in PROFILE_METADATA:
                continue
            target, value = self._rename(key, value, profile)
            if selector is not None and target == selector.name:
                continue  # the branch was chosen above (a renamed `model` targets a leaf, not the selector)
            short = target.split('.')[-1]
            leaf = leaves.get(short)
            # A renamed/credential target is a schema PATH; prefer the leaf
            # whose path matches it exactly
            if leaf is None or (target != key and leaf.path != target):
                exact = next((entry for entry in leaves.values() if entry.path == target), None)
                leaf = exact or leaf
            if leaf is None:
                # A key of a branch other than the chosen one: the resolver keeps
                # it under its own branch, unvalidated, so switching back finds it
                others = self.plan.elsewhere(short, branch)
                if len(others) == 1:
                    leaf = others[0]
                elif len(others) > 1:
                    self.errors.append(
                        f'config key {key!r} belongs to several branches of {self.provider}: {sorted(o.path for o in others)}'
                    )
                    continue
            if leaf is None:
                if key in dropped or short in dropped or key.split('.')[-1] in dropped:
                    continue
                if key in COMBO_BLOCKS and isinstance(value, dict):
                    self.warnings.append(f'the {key!r} sub-provider block was removed with the combo pattern; dropped')
                    continue
                if isinstance(value, dict) and value and not all(k in dropped for k in value):
                    pending.extend((f'{key}.{inner}', inner_value) for inner, inner_value in value.items())
                    continue
                if isinstance(value, dict):
                    continue  # an empty group, or one made only of dropped keys
                if key in OLD_EDITOR_STAMPS:
                    continue
                self.errors.append(
                    f'config key {key!r} has no place in {self.provider}; it is none of {sorted(leaves)}'
                )
                continue
            if leaf.descriptor.get('type') == CONSTANT_TYPE:
                # The editor writes a constant's value as a marker (`mode: Source`,
                # `type`); keep it when it is the node's, drop a stale override
                if _is_default(value, leaf.descriptor):
                    _set_path(out, leaf.path, value)
                else:
                    self.warnings.append(
                        f'{leaf.name}={value!r} is fixed by the node now ({leaf.descriptor.get("default")!r}); the stored value was dropped'
                    )
                continue
            if value == '' or value is None:
                continue
            value, note = _coerce(value, leaf.descriptor)
            if note:
                self.warnings.append(f'{leaf.name}: {note}')
            if _is_default(value, leaf.descriptor):
                continue
            _set_path(out, leaf.path, value)

        # The result must be what the node will run
        problem = _resolves(self.schema, copy.deepcopy(out))
        if problem is not None:
            self.errors.append(f'the converted config of {self.provider} does not resolve: {problem}')
        return out


# ============================================================================
# The pipeline
# ============================================================================


def _note(entries: List[Dict[str, Any]], component_id: Optional[str], message: str) -> None:
    entry: Dict[str, Any] = {'message': message}
    if component_id is not None:
        entry['id'] = component_id
    entries.append(entry)


def convert_pipeline(pipeline: Mapping[str, Any], schema_for: Optional[SchemaLookup] = None) -> ConvertResult:
    """
    Convert ``pipeline`` to the current node-config format (plan 5.6.8).

    Args:
        pipeline: The flat pipeline dict (``components``, ``project_id``, ...), as read.
        schema_for: ``provider -> (resolved schema, raw definition)``; the engine's by default.

    Returns:
        ConvertResult: the pipeline to use (a copy; the input is never mutated),
        the warnings, the errors, and whether anything changed. With errors the
        returned pipeline carries the converted components that succeeded and
        the original config of those that did not.
    """
    lookup = schema_for or default_schema_lookup
    result = ConvertResult(pipeline=copy.deepcopy(dict(pipeline)))
    out = result.pipeline

    # Names are checked on every pipeline and FILLED only when a conversion
    # happened anyway, so the converted text is complete while a current
    # pipeline is never rewritten for a missing label
    pipeline_nameless = not isinstance(out.get('name'), str) or not out['name'].strip()
    nameless: List[Tuple[Dict[str, Any], str]] = []  # (component, fallback name)

    components = out.get('components')
    if not isinstance(components, list):
        return result

    for component in components:
        if not isinstance(component, dict):
            continue
        component_id = component.get('id')
        provider = component.get('provider')

        # Step 2: a valid id and a name per component. A non-string id is the
        # engine's own structural error (and names no component); a string
        # that breaks the address grammar is refused here with the rule
        if not isinstance(component_id, str):
            continue
        if '${' in component_id:
            continue  # a placeholder in an id is the placeholder check's error (plan 6.2)
        if not SEGMENT_PATTERN.fullmatch(component_id):
            _note(
                result.errors,
                component_id,
                f'component id {component_id!r} must be one dot-free segment of letters, digits, _ and - (B5)',
            )
            continue
        if not isinstance(provider, str) or not provider:
            _note(result.errors, component_id, 'the component names no provider')
            continue
        if provider in DELETED_PROVIDERS:
            _note(
                result.errors, component_id, f'provider {provider!r} was removed; address a published pipeline instead'
            )
            continue
        schema, raw = lookup(provider)
        if schema is None:
            continue  # the engine's structural validation names an unknown node; nothing to convert
        if not isinstance(component.get('name'), str) or not component['name'].strip():
            title = (raw or {}).get('title') if isinstance(raw, dict) else None
            nameless.append((component, title if isinstance(title, str) and title.strip() else component_id))

        # Steps 3-6: the config
        legacy = (raw or {}).get('legacy') if isinstance(raw, dict) else None
        config = component.get('config')
        if not isinstance(legacy, dict) or not isinstance(config, dict) or not config:
            continue
        worker = _Component(component_id, provider, schema, legacy)
        if not worker.is_old_shape(config):
            continue
        converted = worker.convert(config)
        for message in worker.warnings:
            _note(result.warnings, component_id, message)
        for message in worker.errors:
            _note(result.errors, component_id, message)
        if not worker.errors and converted != config:
            component['config'] = converted
            result.touched = True

    # The names: filled in a converted pipeline, reported otherwise
    if pipeline_nameless:
        fallback = out.get('project_id') if isinstance(out.get('project_id'), str) and out['project_id'] else 'Pipeline'
        if result.touched:
            out['name'] = fallback
            _note(result.warnings, None, f'the pipeline had no name; named it {fallback!r}')
        else:
            _note(result.warnings, None, 'the pipeline has no name')
    for component, fallback in nameless:
        if result.touched:
            component['name'] = fallback
            _note(result.warnings, component['id'], f'the component had no name; named it {fallback!r}')
        else:
            _note(result.warnings, component['id'], 'the component has no name')
    return result
