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
    1. DETECT. A config the resolver accepts is current. One it rejects is old
       only when it carries a signal of the old format: the old selector key
       (when the new selector has another name), a profile-named block, a key
       the legacy block lists, an old editor stamp with no leaf, or a branch
       leaf written flat at the root. Anything else is a current config with a
       mistake, which stays the resolver's error.
    2. FLATTEN the old way. The profile is the stored ``profile`` key, else the
       old default; its values come first, overlaid by the profile-named block
       and then the top-level keys (the old ``overlay_top_level`` rule). A
       value that came only from the profile is written when it differs from
       the new default (the old run used it), and is never an error.
    3. BRANCH. Every selector of the new schema (root and nested) gets a
       branch. The primary selector (the first at the root) takes, in order:
       the user's own value for it (an old flat ``authType``, a rename that
       targets it), ``legacy.profileMap``, the profile name, the profile's own
       value for it (an LLM profile's ``model``), the branch whose leaves fit,
       the schema default for the generic profile, a branch named in the
       profile's ``migration`` text, and for an LLM node ``custom`` with
       ``customModel`` = the profile's model (a warning). Every other selector
       takes the user's or the profile's value for it, else its default. An
       unmappable profile is an error.
    4. PLACE each key at the new schema's path for the chosen branches, after
       ``legacy.renamed`` and ``legacy.credential``; hoisting is already in the
       path the engine emits. An old nested group is expanded into its dotted
       keys before the branch is chosen (``auth: {enabled: true}`` drives the
       ``auth`` selector like ``auth.enabled`` would). An open group (no
       declared members) is placed whole. A key of a switched-away branch stays
       under that branch, as does an inactive block that names a real branch.
    5. DROP AND WARN. ``legacy.dropped`` keys (bare or profile-qualified) and
       profile metadata go silently; so do the old editor's stamps and the
       deleted combo sub-blocks (with a warning); a constant keeps its marker
       value and loses a stale override with a warning; a value equal to the
       new default and every empty string are omitted; a whole float becomes an
       integer and an out-of-range number is clamped, with a warning.
    6. REFUSE, NEVER GUESS. A user key that is none of the above is an error
       naming the component, the key and the candidates. The converted config
       must resolve; a resolver error is reported as the component's error.

Pipeline level: a string component id must be one dot-free segment (B5);
deleted providers (``autopipe``, ``remote``, ``vectorizer``) are errors; an
unknown provider is the engine's structural error and is left alone; missing
component and pipeline names are filled from the node's title / ``project_id``
only when a conversion happened, and reported otherwise.

The server returns the converted text only; nothing is written back here. The
module imports stdlib-only: the engine is imported where it is used, so the
saas hermetic test harness can load it by file with no engine present.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Set, Tuple

from .address import SEGMENT_PATTERN

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

#: What the OLD editor stamped on every component config: the source markers,
#: the per-node ``parameters`` stub and the form's own toggles. Kept where the
#: new schema declares them (as constants), dropped silently where it does not.
OLD_EDITOR_STAMPS = frozenset({'hideForm', 'mode', 'type', 'parameters', 'show_advanced', 'advanced_mode'})

#: The deleted sub-provider ("combo") blocks a store or vectorizer carried
#: (plan 12 D): a dict under one of these names has no new home.
COMBO_BLOCKS = frozenset({'embedding', 'store', 'preprocessor'})

#: A property type whose stored value is the node's, not the user's.
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
    open_group: bool = False  # a group with no declared members: placed whole


@dataclass
class _Selector:
    name: str
    path: str
    default: Any
    branches: Dict[str, Dict[str, _Leaf]]  # branch -> short name -> leaf (nested selectors excluded)


@dataclass
class _Plan:
    """The new schema, indexed for one component: root leaves and every selector, root or nested."""

    root_leaves: Dict[str, _Leaf]
    selectors: List[_Selector]  # the first is the PRIMARY one (the first at the root)

    @property
    def primary(self) -> Optional[_Selector]:
        return self.selectors[0] if self.selectors else None

    def selector(self, name: str) -> Optional[_Selector]:
        return next((s for s in self.selectors if s.name == name), None)

    def leaves_for(self, choices: Mapping[str, Optional[str]]) -> Dict[str, _Leaf]:
        """Root leaves plus the leaves of every selector's chosen branch."""
        merged = dict(self.root_leaves)
        for selector in self.selectors:
            branch = choices.get(selector.name)
            if branch is not None:
                merged.update(selector.branches.get(branch, {}))
        return merged

    def all_leaf_names(self) -> Set[str]:
        names = set(self.root_leaves)
        for selector in self.selectors:
            for leaves in selector.branches.values():
                names.update(leaves)
        return names

    def elsewhere(self, short: str, choices: Mapping[str, Optional[str]]) -> List[_Leaf]:
        """The leaves named ``short`` in branches that were NOT chosen (a switched-away block's keys)."""
        found: List[_Leaf] = []
        for selector in self.selectors:
            for branch, leaves in selector.branches.items():
                if branch != choices.get(selector.name) and short in leaves:
                    found.append(leaves[short])
        return found


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
    """Index the resolved schema: root leaves and every selector with its branches' leaves."""
    root_leaves: Dict[str, _Leaf] = {}
    selectors: List[_Selector] = []

    def collect(props: Iterable[Any], into: Dict[str, _Leaf]) -> None:
        for prop in props or []:
            if not isinstance(prop, dict):
                continue
            name = prop.get('name')
            path = prop.get('path')
            if isinstance(prop.get('enum'), dict):
                if not isinstance(name, str):
                    continue
                branches: Dict[str, Dict[str, _Leaf]] = {}
                for branch, body in prop['enum'].items():
                    leaves: Dict[str, _Leaf] = {}
                    if isinstance(body, dict):
                        collect(body.get('properties') or [], leaves)
                    branches[str(branch)] = leaves
                selectors.append(_Selector(name, str(path or name), prop.get('default'), branches))
                continue
            members = prop.get('properties')
            if isinstance(members, list) and prop.get('type') != 'array':
                if members:
                    collect(members, into)  # a group: its members are the leaves
                elif isinstance(name, str):
                    into[name] = _Leaf(name, str(path or name), prop, open_group=True)
                continue
            if isinstance(name, str) and isinstance(path, str):
                into[name] = _Leaf(name, path, prop)

    collect(schema.get('properties') or [], root_leaves)
    return _Plan(root_leaves, selectors)


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
    """Coerce ``value`` where the old format was looser; (value, note)."""
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
        self.dropped: Set[str] = set(legacy.get('dropped') or [])

    # ---- detection ----------------------------------------------------------

    def is_old_shape(self, config: Mapping[str, Any]) -> bool:
        # A config the resolver accepts is current, whatever its keys are
        # named (a new branch block may share a name with an old profile)
        if _resolves(self.schema, dict(config)) is None:
            return False
        # Not resolvable as written: it is OLD only when it carries a signal of
        # the old format; otherwise it is a current config with a mistake, which
        # the resolver reports at the door as before (never a conversion error)
        primary = self.plan.primary
        if self.selector_key in config and self.profiles and (primary is None or primary.name != self.selector_key):
            return True
        if any(key in self.profiles and isinstance(value, dict) for key, value in config.items()):
            return True
        known = self.dropped | set(self.legacy.get('renamed') or {}) | set(self.legacy.get('credential') or {})
        selector_names = {s.name for s in self.plan.selectors}
        leaves = self.plan.all_leaf_names()
        branch_only = leaves - set(self.plan.root_leaves)
        for key, value in config.items():
            if key in known or key.split('.')[-1] in known:
                return True
            # The old NESTED form of a renamed group (`auth: {enabled: true}`)
            if isinstance(value, dict) and any(f'{key}.{inner}' in known for inner in value):
                return True
            if key in OLD_EDITOR_STAMPS and key not in leaves and key not in selector_names:
                return True
            # The old FLAT form: a branch leaf written at the root (the old
            # default profile decided which branch it belonged to)
            if key in branch_only and not isinstance(value, dict):
                return True
        return False

    # ---- flatten ------------------------------------------------------------

    def flatten(self, config: Mapping[str, Any]) -> Tuple[Optional[str], Dict[str, Any], Set[str]]:
        """The old merge: (profile, every effective key, the keys that came ONLY from the profile)."""
        profile = config.get(self.selector_key) if self.profiles else None
        if profile is None and self.profiles:
            profile = self.legacy.get('default')
        if self.profiles and (not isinstance(profile, str) or profile not in self.profiles):
            self.errors.append(
                f'profile {profile!r} is not one of the old profiles {sorted(self.profiles)} of {self.provider}'
            )
            return None, {}, set()
        # The profile's own values come first: the old run used them, so a
        # value the new branch does not default to has to be written
        user: Dict[str, Any] = {
            k: v for k, v in (self.profiles.get(profile) or {}).items() if k not in PROFILE_METADATA and v is not None
        }
        from_profile = set(user)
        nested = config.get(profile) if isinstance(profile, str) else None
        if isinstance(nested, dict):
            user.update(nested)
            from_profile -= set(nested)
        for key, value in config.items():
            if key == self.selector_key and self.profiles:
                continue
            if isinstance(key, str) and key in self.profiles and isinstance(value, dict):
                continue  # a profile block: the active one was taken above, the others are inactive
            if value is None:
                continue
            user[key] = value
            from_profile.discard(key)
        self._expand_groups(user, from_profile)
        return profile, user, from_profile

    def _expand_groups(self, user: Dict[str, Any], from_profile: Set[str]) -> None:
        """Expand an old nested group into dotted keys, so its members drive branch choice and placement."""
        leaves = self.plan.all_leaf_names()
        for key in list(user):
            value = user[key]
            if not isinstance(value, dict) or not value:
                continue
            if key in COMBO_BLOCKS or key.split('.')[-1] in leaves or key in self.profiles:
                continue  # a block with its own meaning: a deleted combo, an object/open-group leaf, a profile
            del user[key]
            for inner, inner_value in value.items():
                dotted = f'{key}.{inner}'
                user[dotted] = inner_value
                if key in from_profile:
                    from_profile.add(dotted)
            from_profile.discard(key)

    # ---- branches -----------------------------------------------------------

    def _rename(self, key: str, value: Any, profile: Optional[str]) -> Tuple[str, Any]:
        """Apply ``legacy.renamed`` / ``legacy.credential`` to one key; (new key or path, value)."""
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

    def _user_value_for(
        self, selector: _Selector, user: Mapping[str, Any], profile: Optional[str], from_profile: Set[str]
    ) -> Optional[str]:
        """The user's OWN value for ``selector`` (not the profile's): by its name, or through a rename that targets it."""
        own = user.get(selector.name) if selector.name not in from_profile else None
        if isinstance(own, str) and own in selector.branches:
            return own
        for key, value in user.items():
            if key in from_profile:
                continue
            target, mapped = self._rename(key, value, profile)
            if target != key and target == selector.name and isinstance(mapped, str) and mapped in selector.branches:
                return mapped
        return None

    def choose_primary(
        self, selector: _Selector, profile: Optional[str], user: Dict[str, Any], from_profile: Set[str]
    ) -> Optional[str]:
        """The primary selector's branch for ``profile``; appends an error when none."""
        branches = selector.branches
        values = self.profiles.get(profile, {}) if profile is not None else {}
        # 1. The user's own value: an explicit override always wins
        own = self._user_value_for(selector, user, profile, from_profile)
        if own is not None:
            return own
        # 2. The hand-verified map, the profile name, the profile's own value
        if profile is not None:
            mapped = (self.legacy.get('profileMap') or {}).get(profile)
            if isinstance(mapped, str) and mapped in branches:
                return mapped
            if profile in branches:
                return profile
        candidate = values.get(selector.name)
        if isinstance(candidate, str) and candidate in branches:
            return candidate
        # 3. The branch whose leaves fit the user's branch-only keys, when exactly one does
        root = set(self.plan.root_leaves)
        shorts = {k.split('.')[-1] for k in user if k not in from_profile}
        branch_only = shorts - root - OLD_EDITOR_STAMPS - self.dropped - PROFILE_METADATA - {selector.name}
        if branch_only:
            fits = [b for b, leaves in branches.items() if branch_only <= set(leaves)]
            if len(fits) == 1:
                return fits[0]
        # 4. No old selector at all, or the one generic profile: the schema's default branch
        if profile is None or (not values or set(self.profiles) <= {profile}):
            return str(selector.default) if selector.default is not None else None
        # 5. A retired profile whose migration note names a branch
        migration = values.get('migration')
        if isinstance(migration, str):
            for name in sorted(branches, key=len, reverse=True):
                if re.search(r'(?<![\w.-])' + re.escape(name) + r'(?![\w.-])', migration):
                    self.warnings.append(
                        f'profile {profile!r} is retired; converted to {selector.name}={name!r} as its migration note says'
                    )
                    return name
        # 6. An LLM profile with no counterpart: custom + the old model id
        if CUSTOM_BRANCH in branches and CUSTOM_MODEL_LEAF in branches[CUSTOM_BRANCH]:
            model = values.get('model') or user.get('model')
            if isinstance(model, str) and model:
                self.warnings.append(
                    f'profile {profile!r} has no counterpart; converted to {selector.name}={CUSTOM_BRANCH!r} '
                    f'with {CUSTOM_MODEL_LEAF}={model!r}'
                )
                user.setdefault(CUSTOM_MODEL_LEAF, model)
                return CUSTOM_BRANCH
        self.errors.append(
            f'profile {profile!r} of {self.provider} has no counterpart among {selector.name} values {sorted(branches)}'
        )
        return None

    def choose_branches(
        self, profile: Optional[str], user: Dict[str, Any], from_profile: Set[str]
    ) -> Dict[str, Optional[str]]:
        """A branch per selector: the primary by the profile rules, the others by value, else default."""
        choices: Dict[str, Optional[str]] = {}
        values = self.profiles.get(profile, {}) if profile is not None else {}
        for index, selector in enumerate(self.plan.selectors):
            if index == 0:
                choices[selector.name] = self.choose_primary(selector, profile, user, from_profile)
                continue
            own = self._user_value_for(selector, user, profile, from_profile)
            if own is None:
                candidate = values.get(selector.name)
                own = candidate if isinstance(candidate, str) and candidate in selector.branches else None
            if own is None and selector.default is not None:
                own = str(selector.default)
            choices[selector.name] = own
        return choices

    # ---- place --------------------------------------------------------------

    def _is_dropped(self, key: str, profile: Optional[str]) -> bool:
        short = key.split('.')[-1]
        return (
            key in self.dropped or short in self.dropped or (profile is not None and f'{profile}.{key}' in self.dropped)
        )

    def inactive_branch_blocks(self, config: Mapping[str, Any], profile: Optional[str]) -> Dict[str, Any]:
        """Old inactive profile blocks whose name is also a NEW branch: the resolver keeps them, so does the converter."""
        branch_names = {b for s in self.plan.selectors for b in s.branches}
        return {
            key: value
            for key, value in config.items()
            if key != profile and key in branch_names and key in self.profiles and isinstance(value, dict)
        }

    def convert(self, config: Mapping[str, Any]) -> Dict[str, Any]:
        """Convert one old-shape config to the new tree; errors and warnings accumulate on self."""
        profile, user, from_profile = self.flatten(config)
        if self.errors:
            return dict(config)
        choices = self.choose_branches(profile, user, from_profile)
        if self.errors:
            return dict(config)
        leaves = self.plan.leaves_for(choices)
        selector_names = {s.name for s in self.plan.selectors}
        out: Dict[str, Any] = {}

        # Every selector whose chosen branch is not its default
        for selector in self.plan.selectors:
            branch = choices.get(selector.name)
            if branch is not None and branch != selector.default:
                _set_path(out, selector.path, branch)
        # A switched-away block that names a real branch survives as it is (plan 5.6.2)
        for key, block in self.inactive_branch_blocks(config, profile).items():
            out[key] = copy.deepcopy(block)

        for key, value in user.items():
            if key in OWNED_KEYS:
                out[key] = value
                continue
            if key.split('.')[-1] in PROFILE_METADATA:
                continue
            target, value = self._rename(key, value, profile)
            if target in selector_names:
                # The branch was chosen above; a user's own value that is none of
                # the branches, or that contradicts the branch chosen from another
                # key, is refused here rather than silently replaced
                selector = self.plan.selector(target)
                if key not in from_profile and selector is not None and str(value) != str(choices.get(target)):
                    if isinstance(value, str) and value in selector.branches:
                        self.errors.append(
                            f'{target}={value!r} contradicts {target}={choices.get(target)!r} chosen from the other keys'
                        )
                    else:
                        self.errors.append(
                            f'{target}={value!r} is not one of {sorted(selector.branches)} of {self.provider}'
                        )
                continue
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
                others = self.plan.elsewhere(short, choices)
                if len(others) == 1:
                    leaf = others[0]
                elif len(others) > 1:
                    if key in from_profile:
                        continue
                    self.errors.append(
                        f'config key {key!r} belongs to several branches of {self.provider}: {sorted(o.path for o in others)}'
                    )
                    continue
            if leaf is None:
                if self._is_dropped(key, profile) or key in from_profile:
                    continue
                if key in COMBO_BLOCKS and isinstance(value, dict):
                    self.warnings.append(f'the {key!r} sub-provider block was removed with the combo pattern; dropped')
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
                # `type`); a user's marker is kept, a stale override dropped
                if _is_default(value, leaf.descriptor):
                    if key not in from_profile:
                        _set_path(out, leaf.path, value)
                else:
                    self.warnings.append(
                        f'{leaf.name}={value!r} is fixed by the node now ({leaf.descriptor.get("default")!r}); the stored value was dropped'
                    )
                continue
            if value == '' or value is None:
                continue
            if leaf.open_group:
                if value:  # an empty group is the editor's stub, not a value
                    _set_path(out, leaf.path, copy.deepcopy(value))
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

        # A valid id and a name per component. A non-string id is the engine's
        # own structural error (and names no component); a placeholder in an id
        # is the placeholder check's error (plan 6.2); a string that breaks the
        # address grammar is refused here with the rule
        if not isinstance(component_id, str) or '${' in component_id:
            continue
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

        # The config
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
