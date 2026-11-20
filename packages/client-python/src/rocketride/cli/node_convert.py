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
Convert an old-format node definition to the current format (``rocketride node convert``).

Breaking change B6: the engine loads ``propertyDefinitions``/``properties``
only. A custom node written against the old format (``preconfig``, ``fields``,
``shape``) is converted once, offline, by this module. Pure: stdlib only, no
server, no client. Kept rule-for-rule with the TypeScript CLI's
``src/cli/node_convert.ts``; ``tests/fixtures/node_convert`` holds the cases
both suites check.

The conversion keeps what the old engine did with the file:

    1. ``fields`` -> ``propertyDefinitions``. Member renames: ``secure`` ->
       ``secret``; ``const`` -> ``type: "constant"`` with that ``default``;
       ``enum`` + ``enumNames`` -> ``[[value, label], ...]``; a ``*>path.*.key``
       enum entry is expanded from the file; ``items`` -> ``item``; a list
       ``type`` keeps its first entry. Presentation hints map where the new
       format has one (``hidden``, ``format: "textarea"``, ``secret``,
       ``type: "upload"`` with its ``options.accept``, ``type: "oauth2"``) and
       are dropped otherwise. ``optional``, ``field`` and ``ui:*`` are dropped.
       A ``combo`` field has no new form and is dropped with a warning. A local
       field named like a shared one still merges onto it (the engine's rule is
       unchanged). The engine refuses ``secret`` inside an array item, so the
       flag moves from the item's members to the array. In a library file (no
       ``protocol``) a conditional field becomes a selector definition.
    2. ``shape`` -> ``properties``: the ``Pipe`` section (else ``Source``, else
       the first). An ``object``/``section`` field becomes a group named by its
       ``object``. Every other section is dropped with a warning.
    3. ``preconfig`` -> a ``profile`` selector. The field whose enum lists
       ``*>preconfig.profiles`` (or, in a file with profiles, the field named
       ``profile`` with an enum or a conditional) becomes
       ``{"name": "profile", "enum": {...}}`` with one branch per value. A branch's properties are its conditional's
       properties, with an ``object`` named like the branch unwrapped (the
       branch value is already the storage path). A profile value becomes the
       property's ``default`` (``{"base": ref, "default": value}``), and a
       profile key with no property becomes a ``constant`` so the node still
       reads it. Profile metadata (``title``, ``deprecated``, ``deprecatedBy``,
       ``migration``) is not config, and a constant that names a property
       declared beside the selector is dropped (the old engine let that
       property win; the namespace is shared), with a warning when the values
       differ. With profiles but no selector, the default profile's values
       apply at the root.
    4. Any other ``conditional`` becomes a selector keyed by its values; on a
       boolean it cannot (branch keys are strings), so its properties are
       listed after it, always shown, with a warning.
    5. ``config`` (the engine refuses it) is dropped with a warning; every
       other top-level member is kept in place.
    6. The ``legacy`` block goes LAST, derived exactly as
       ``tools/legacy_blocks.py`` derives it (``build_block`` below is that
       script's function minus its hand-verified table, which names in-repo
       nodes only), so ``task_convert`` converts pipelines saved against the
       old definition.

The output is JSON (comments are not carried over), tab-indented.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

# ============================================================================
# Constants
# ============================================================================

#: Profile keys that describe the profile, not the node's config.
PROFILE_METADATA = frozenset({'title', 'deprecated', 'deprecatedBy', 'migration'})

#: Field members the conversion consumes or drops (never copied as-is).
CONSUMED_MEMBERS = frozenset(
    {'optional', 'secure', 'const', 'enum', 'enumNames', 'conditional', 'field', 'ui', 'items', 'object', 'section'}
)

#: Top-level members the current engine refuses or that the conversion replaces.
REPLACED_MEMBERS = frozenset({'preconfig', 'fields', 'shape', 'config'})

#: Sections tried, in order, for the node's own properties.
SECTION_ORDER = ('Pipe', 'Source')

#: The enum entry prefix that expands a member of the file itself.
ENUM_EXPANSION = '*>'

#: The name every converted profile selector is stored under (the old
#: ``getNodeConfig`` read ``profile`` whatever the field was called).
PROFILE_SELECTOR = 'profile'


@dataclass
class NodeConversion:
    """What ``convert_definition`` returns: the converted definition and what it did."""

    definition: Dict[str, Any]
    warnings: List[str] = field(default_factory=list)
    legacy: bool = False

    def text(self) -> str:
        """The converted definition as the file text (tab-indented JSON, trailing newline)."""
        return json.dumps(self.definition, indent='\t', ensure_ascii=False) + '\n'


# ============================================================================
# JSON with comments (tools/legacy_blocks.py)
# ============================================================================


def _strip_comments(text: str) -> str:
    """Remove ``//`` comments outside strings, line by line."""
    out: List[str] = []
    for line in text.splitlines():
        quotes = 0
        i = 0
        cut: Optional[int] = None
        while i < len(line):
            ch = line[i]
            if ch == '\\' and quotes % 2 == 1:
                i += 2
                continue
            if ch == '"':
                quotes += 1
            elif ch == '/' and line[i : i + 2] == '//' and quotes % 2 == 0:
                cut = i
                break
            i += 1
        out.append(line if cut is None else line[:cut])
    return '\n'.join(out)


def _strip_trailing_commas(text: str) -> str:
    """Remove a ``,`` that directly precedes ``}`` or ``]`` (whitespace between), outside strings."""
    out: List[str] = []
    quotes = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '\\' and quotes % 2 == 1:
            out.append(text[i : i + 2])
            i += 2
            continue
        if ch == '"':
            quotes += 1
        elif ch == ',' and quotes % 2 == 0:
            j = i + 1
            while j < len(text) and text[j] in ' \t\r\n':
                j += 1
            if j < len(text) and text[j] in '}]':
                i += 1
                continue
        out.append(ch)
        i += 1
    return ''.join(out)


def load_json(text: str) -> Dict[str, Any]:
    """Parse a services.json, tolerating the ``//`` comments and trailing commas the files may carry."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(_strip_trailing_commas(_strip_comments(text)))


# ============================================================================
# The legacy block (tools/legacy_blocks.py, without its in-repo HAND table)
# ============================================================================


def strip_prefix(key: str) -> str:
    """``chunker.chunk_size`` -> ``chunk_size``; ``opensearch.auth.enabled`` -> ``auth.enabled``."""
    head, _, rest = key.partition('.')
    return rest or head


def old_schema(doc: Dict[str, Any]) -> Tuple[Set[str], Optional[str], Optional[str], Dict[str, Any]]:
    """Return (old keys, selector key, default profile, profiles verbatim)."""
    keys: Set[str] = set()
    pre = doc.get('preconfig') or {}
    profiles = pre.get('profiles') or {}
    fields = doc.get('fields') or {}
    # Members of an array item are not node keys
    array_names = {n for n, f in fields.items() if isinstance(f, dict) and f.get('type') == 'array'}
    item_fields = {n for n in fields if any(n.startswith(a + '.') for a in array_names)}

    def stored_name(name: str) -> str:
        # Fields are usually `<node>.<key>`; a few declare bare keys, where
        # the first segment is itself a field
        head, _, rest = name.partition('.')
        return rest if rest and head not in fields else name

    for name, item in fields.items():
        if not isinstance(item, dict) or 'object' in item or name in item_fields:
            continue
        # The profile selector itself: the stored key was always `profile`
        enum = item.get('enum')
        if isinstance(enum, list) and any(isinstance(e, str) and e.startswith('*>preconfig') for e in enum):
            continue
        if stored_name(name).split('.')[-1] == 'profile' and profiles:
            continue
        keys.add(stored_name(name))
    for profile in profiles.values():
        if isinstance(profile, dict):
            keys.update(k for k in profile if k != 'title')
    selector = 'profile' if profiles else None
    return keys, selector, pre.get('default'), profiles


def new_schema(doc: Dict[str, Any], shared: Dict[str, Any]) -> Tuple[Set[str], Set[str]]:
    """Return (leaf short names, selector names) the new definition declares."""
    leaves: Set[str] = set()
    selectors: Set[str] = set()
    defs = dict(shared)
    defs.update(doc.get('propertyDefinitions') or {})

    def add_def(key: str) -> None:
        value = defs.get(key)
        if isinstance(value, dict) and isinstance(value.get('enum'), dict):
            selectors.add(strip_prefix(key).split('.')[-1])
            for branch in value['enum'].values():
                if isinstance(branch, dict):
                    walk(branch.get('properties'))
        else:
            leaves.add(key.split('.')[-1])
            if isinstance(value, dict):
                if isinstance(value.get('properties'), list):
                    walk(value['properties'])
                for item in (value.get('item'), value.get('items')):
                    if isinstance(item, str):
                        add_def(item)
                    elif isinstance(item, dict):
                        walk([item])

    def walk(props: Any) -> None:
        for prop in props or []:
            if isinstance(prop, str):
                add_def(prop)
                continue
            if not isinstance(prop, dict):
                continue
            if 'base' in prop and 'name' not in prop:
                add_def(prop['base'])
                continue
            name = prop.get('name') or (prop['base'].split('.')[-1] if 'base' in prop else None)
            if isinstance(prop.get('enum'), dict):
                if name:
                    selectors.add(name)
                for branch in prop['enum'].values():
                    if isinstance(branch, dict):
                        walk(branch.get('properties'))
            elif name:
                leaves.add(name)
            if isinstance(prop.get('properties'), list):
                walk(prop['properties'])
            for item in (prop.get('item'), prop.get('items')):
                if isinstance(item, str):
                    add_def(item)
                elif isinstance(item, dict):
                    walk([item])

    walk(doc.get('properties'))
    return leaves, selectors


def build_block(old: Dict[str, Any], new: Dict[str, Any], shared: Dict[str, Any]) -> Dict[str, Any]:
    """Derive one node's ``legacy`` block from its old and new definitions."""
    old_keys, selector, default, profiles = old_schema(old)
    leaves, selectors = new_schema(new, shared)
    renamed: Dict[str, Any] = {}

    # LLM family: the custom profile's `model` became the root leaf `customModel`
    custom = profiles.get('custom')
    if isinstance(custom, dict) and 'model' in custom and 'customModel' in leaves:
        renamed.setdefault('custom.model', 'customModel')

    mapped = set(renamed) | {k.split('.')[-1] for k in renamed}
    dropped = sorted(
        key
        for key in old_keys
        if key not in mapped
        and key.split('.')[-1] not in leaves
        and key.split('.')[-1] not in selectors
        and key not in leaves
    )

    block: Dict[str, Any] = {}
    if selector:
        block['selector'] = selector
    if default is not None:
        block['default'] = default
    block['profiles'] = profiles
    block['dropped'] = dropped
    if renamed:
        block['renamed'] = renamed
    return block


def wants_block(old: Dict[str, Any], block: Dict[str, Any]) -> bool:
    """Whether a definition gets the block: it had old config, and an old pipe could carry a key the new schema rejects."""
    if not old.get('preconfig') and not old.get('fields'):
        return False
    return any(block.get(k) for k in ('profiles', 'dropped', 'renamed', 'credential', 'profileMap'))


# ============================================================================
# Field conversion
# ============================================================================


def _short(ref: str) -> str:
    """The property name a reference resolves to: its last dotted component."""
    return ref.split('.')[-1]


def _show(value: Any) -> str:
    """A value in a warning: compact JSON, identical to the TypeScript CLI's ``JSON.stringify``."""
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def _lookup(doc: Dict[str, Any], path: str) -> Any:
    """The member of ``doc`` at the dotted ``path`` (None when absent)."""
    node: Any = doc
    for part in path.split('.'):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def _is_profile_enum(item: Dict[str, Any]) -> bool:
    """Whether ``item``'s enum lists the file's profiles (it is the profile selector)."""
    enum = item.get('enum')
    marker = ENUM_EXPANSION + 'preconfig.profiles'
    return isinstance(enum, list) and any(isinstance(e, str) and e.startswith(marker) for e in enum)


class _Converter:
    """One definition's conversion; collects the converted local definitions and the warnings."""

    def __init__(self, doc: Dict[str, Any], shared: Dict[str, Any]):
        self.doc = doc
        self.shared = shared
        self.fields: Dict[str, Any] = doc.get('fields') or {}
        pre = doc.get('preconfig') or {}
        self.profiles: Dict[str, Any] = pre.get('profiles') or {}
        self.default_profile: Optional[str] = pre.get('default')
        self.definitions: Dict[str, Any] = {}
        self.warnings: List[str] = []
        self.shared_refs: List[str] = []
        self.reached: Set[str] = set()
        # id() of each generated profile constant, and of each profile
        # selector -> the old selector field's short name
        self.generated: Set[int] = set()
        self.profile_selectors: Dict[int, str] = {}

    # ------------------------------------------------------------------
    # One field definition
    # ------------------------------------------------------------------

    def warn(self, text: str) -> None:
        if text not in self.warnings:
            self.warnings.append(text)

    def selects_profile(self, ref: str, item: Dict[str, Any]) -> bool:
        """
        Whether ``item`` is the profile selector.

        Its enum lists the profiles, or it is the field the old engine read the
        profile from (named ``profile``, with an enum or a conditional) in a
        file that has profiles.
        """
        if _is_profile_enum(item):
            return True
        return bool(self.profiles) and _short(ref) == PROFILE_SELECTOR and ('conditional' in item or 'enum' in item)

    def enum_list(self, item: Dict[str, Any]) -> List[Any]:
        """The old ``enum`` (+ ``enumNames``, + ``*>`` expansions) as the new list form."""
        names = item.get('enumNames') if isinstance(item.get('enumNames'), list) else None
        out: List[Any] = []
        for index, entry in enumerate(item.get('enum') or []):
            if isinstance(entry, list):
                out.append(list(entry))
            elif isinstance(entry, str) and entry.startswith(ENUM_EXPANSION):
                spec = entry[len(ENUM_EXPANSION) :]
                path, marker, key = spec.partition('.*.')
                members = _lookup(self.doc, path)
                if isinstance(members, dict):
                    for value, body in members.items():
                        label = body.get(key) if marker and isinstance(body, dict) else None
                        out.append([value, label if isinstance(label, str) else value])
            elif names is not None and index < len(names):
                out.append([entry, names[index]])
            else:
                out.append(entry)
        return out

    def ui_hints(self, name: str, item: Dict[str, Any], out: Dict[str, Any]) -> None:
        """Map the old presentation hints onto the new flags; drop the rest."""
        hints: Dict[str, Any] = {}
        if isinstance(item.get('ui'), dict):
            hints.update(item['ui'])
        hints.update({k: v for k, v in item.items() if k.startswith('ui:')})
        widget = hints.get('ui:widget')
        if widget == 'hidden':
            out['hidden'] = True
        elif widget == 'textarea':
            out['format'] = 'textarea'
        elif widget in ('password', 'ApiKeyWidget'):
            out['secret'] = True
        elif widget in ('GoogleButtonWidget', 'MicrosoftButtonWidget'):
            out['type'] = 'oauth2'
            self.warn(f'{name}: the {widget} became an "oauth2" property; add its "options" (scopes) by hand')
        elif widget is not None:
            self.warn(f'{name}: the ui widget {_show(widget)} has no counterpart and was dropped')
        # An upload's accepted file types move to its "options"
        options = hints.get('ui:options') if isinstance(hints.get('ui:options'), dict) else {}
        accept = hints.get('ui:options:accept', options.get('accept'))
        if out.get('type') == 'upload' and isinstance(accept, str):
            out['options'] = {'accept': accept}

    def convert_field(self, name: str, item: Dict[str, Any]) -> Dict[str, Any]:
        """One old field (not a group, not a selector) as a new property definition."""
        out: Dict[str, Any] = {}
        upload = False
        for key, value in item.items():
            if key in CONSUMED_MEMBERS or key.startswith('ui:'):
                continue
            if key == 'type' and isinstance(value, list):
                kinds = [v for v in value if v != 'null']
                out['type'] = kinds[0] if kinds else 'string'
                self.warn(f'{name}: the type list {_show(value)} became {_show(out["type"])}')
                continue
            if key == 'format' and value == 'password':
                out['secret'] = True
                continue
            if key == 'format' and value == 'data-url':
                upload = True
                continue
            out[key] = copy.deepcopy(value)
        # After the copy, so a `type` listed after `format` cannot undo it
        if upload:
            out['type'] = 'upload'
        if item.get('secure') is True:
            out['secret'] = True
        if 'enum' in item:
            out['enum'] = self.enum_list(item)
        if 'const' in item:
            out['type'] = 'constant'
            out['default'] = copy.deepcopy(item['const'])
        if isinstance(item.get('items'), (dict, str)):
            out['item'] = self.convert_item(name, item['items'])
            # The engine refuses a secret inside an array item (its encrypt
            # walk has no "[]" step): the array itself carries the flag
            if self.unsecret(out['item']):
                out['item'] = self.unsecret(out['item'], apply=True)
                out['secret'] = True
                self.warn(f'{name}: "secret" moved from the array item\'s members to the array')
            unknown = self.unresolved(out['item'])
            if unknown:
                self.warn(
                    f'{name}: the array item references {", ".join(unknown)}, which this offline conversion cannot '
                    'read; the engine refuses a secret inside an array item, so check none of them is secret '
                    'before loading the node'
                )
        self.ui_hints(name, item, out)
        return out

    def unresolved(self, spec: Any) -> List[str]:
        """The shared references in an array item whose definition (and so whose ``secret`` flag) is unknown here."""
        if isinstance(spec, str):
            return [] if spec in self.definitions or spec in self.shared else [spec]
        if not isinstance(spec, dict):
            return []
        if isinstance(spec.get('properties'), list):
            found: List[str] = []
            for member in spec['properties']:
                found.extend(r for r in self.unresolved(member) if r not in found)
            return found
        if 'secret' not in spec and isinstance(spec.get('base'), str):
            return self.unresolved(spec['base'])
        return []

    def is_secret(self, spec: Any) -> bool:
        """Whether a specifier resolves to a secret property."""
        if isinstance(spec, str):
            definition = self.definitions.get(spec) or self.shared.get(spec)
            return isinstance(definition, dict) and definition.get('secret') is True
        if isinstance(spec, dict):
            if 'secret' in spec:
                return spec['secret'] is True
            return isinstance(spec.get('base'), str) and self.is_secret(spec['base'])
        return False

    def unsecret(self, spec: Any, apply: bool = False) -> Any:
        """Find (``apply=False``: truthy when any) or clear (``apply=True``: the new spec) secret members of an item."""
        if isinstance(spec, dict) and isinstance(spec.get('properties'), list):
            members = [self.unsecret(member, apply) for member in spec['properties']]
            if not apply:
                return any(members)
            return {**spec, 'properties': members}
        if not self.is_secret(spec):
            return spec if apply else False
        if not apply:
            return True
        if isinstance(spec, str):
            return {'base': spec, 'secret': False}
        return {**spec, 'secret': False}

    def convert_item(self, name: str, items: Any) -> Any:
        """An old array's ``items`` as the new ``item`` specifier."""
        if isinstance(items, str):
            specs = self.reference(items, {})
            return specs[0] if specs else items
        if items.get('type') == 'object' and isinstance(items.get('properties'), list):
            return {'name': 'entry', 'properties': self.properties(items['properties'], {})}
        entry = self.convert_field(name, items)
        return {'name': 'entry', **entry}

    # ------------------------------------------------------------------
    # Property lists
    # ------------------------------------------------------------------

    def properties(self, refs: Iterable[Any], values: Dict[str, Any], unwrap: Optional[str] = None) -> List[Any]:
        """Convert an old ``properties`` list; ``values`` are the profile values in force, ``unwrap`` the branch value."""
        out: List[Any] = []
        for ref in refs or []:
            if isinstance(ref, str):
                item = self.fields.get(ref)
                if (
                    unwrap is not None
                    and isinstance(item, dict)
                    and item.get('object') == unwrap
                    and isinstance(item.get('properties'), list)
                ):
                    self.reached.add(ref)
                    out.extend(self.properties(item['properties'], values))
                    continue
                out.extend(self.reference(ref, values))
            elif isinstance(ref, dict):
                out.extend(self.inline(ref, values))
        self.prune_constants(out)
        return out

    def prune_constants(self, level: List[Any]) -> None:
        """
        Drop a profile constant that names a property declared beside the profile selector.

        Branch names and leaf names share one namespace per level, and a
        constant identical in every branch is hoisted to the selector's level,
        where it would collide. The old engine let the top-level key win over
        the profile value, so the sibling property is what survives.
        """
        siblings: Set[str] = set()
        for spec in level:
            if isinstance(spec, dict) and isinstance(spec.get('enum'), dict):
                continue
            siblings |= self.names([spec]) if isinstance(spec, str) else {self.level_name(spec)}
        for spec in level:
            if not (isinstance(spec, dict) and id(spec) in self.profile_selectors):
                continue
            reserved = siblings | {PROFILE_SELECTOR, self.profile_selectors[id(spec)]}
            for value, branch in spec['enum'].items():
                kept: List[Any] = []
                for prop in branch.get('properties') or []:
                    if id(prop) in self.generated and prop['name'] in reserved:
                        if prop['name'] not in (PROFILE_SELECTOR, self.profile_selectors[id(spec)]):
                            # Names only: the values may be secret
                            if self.sibling_default(level, prop['name']) != prop['default']:
                                self.warn(
                                    f'profile {_show(value)} sets {prop["name"]}, which is declared outside the '
                                    "profile with a different default; the profile's value is not carried"
                                )
                        continue
                    kept.append(prop)
                branch['properties'] = kept

    def level_name(self, spec: Any) -> str:
        """The name a specifier takes at its own level."""
        if isinstance(spec, str):
            return _short(spec)
        name = spec.get('name') or (spec.get('base') if isinstance(spec.get('base'), str) else '')
        return _short(name)

    def sibling_default(self, level: List[Any], name: str) -> Any:
        """The default of the property named ``name`` at ``level`` (None when it has none)."""
        for spec in level:
            if self.level_name(spec) != name:
                continue
            if isinstance(spec, dict) and 'default' in spec:
                return spec['default']
            ref = spec if isinstance(spec, str) else spec.get('base')
            definition = (self.definitions.get(ref) or self.shared.get(ref)) if isinstance(ref, str) else None
            return definition.get('default') if isinstance(definition, dict) else None
        return None

    def reference(self, ref: str, values: Dict[str, Any]) -> List[Any]:
        """One bare-string reference as zero or more new specifiers."""
        item = self.fields.get(ref)
        if not isinstance(item, dict):
            # A shared definition: kept by name
            if ref not in self.shared_refs:
                self.shared_refs.append(ref)
            return [self.with_default(ref, values, self.shared.get(ref))]
        self.reached.add(ref)
        if 'combo' in item:
            self.warn(f'{ref}: a "combo" (sub-provider) field has no counterpart and was dropped')
            return []
        if 'object' in item or 'section' in item:
            return [self.group(ref, item, values)]
        if 'conditional' in item or self.selects_profile(ref, item):
            return self.selector(ref, item)
        if ref not in self.definitions:
            self.definitions[ref] = self.convert_field(ref, item)
        return [self.with_default(ref, values, self.definitions[ref])]

    def inline(self, item: Dict[str, Any], values: Dict[str, Any]) -> List[Any]:
        """An inline old field inside a ``properties`` list."""
        name = item.get('name') or item.get('object') or item.get('section') or 'entry'
        if 'object' in item or 'section' in item:
            return [self.group(name, item, values)]
        if 'conditional' in item or self.selects_profile(name, item):
            return self.selector(name, item)
        converted = self.convert_field(name, item)
        converted.setdefault('name', name)
        # The profile in force sets its default, by the rules `with_default` applies to a reference
        key = _short(str(converted['name']))
        if key in values and values[key] != '' and values[key] is not None and converted.get('default') != values[key]:
            converted['default'] = copy.deepcopy(values[key])
        return [converted]

    def with_default(self, ref: str, values: Dict[str, Any], definition: Optional[Dict[str, Any]]) -> Any:
        """``ref``, or ``{"base": ref, "default": v}`` when the profile in force sets a different value."""
        short = _short(ref)
        if short not in values:
            return ref
        value = values[short]
        if value == '' or value is None:
            return ref
        if isinstance(definition, dict) and definition.get('default') == value:
            return ref
        return {'base': ref, 'default': copy.deepcopy(value)}

    def group(self, ref: str, item: Dict[str, Any], values: Dict[str, Any]) -> Dict[str, Any]:
        """An ``object``/``section`` field as a group named by its ``object``."""
        out: Dict[str, Any] = {'name': item.get('object') or item.get('section') or _short(ref)}
        for key in ('title', 'description'):
            if key in item:
                out[key] = copy.deepcopy(item[key])
        out['properties'] = self.properties(item.get('properties') or [], values)
        return out

    # ------------------------------------------------------------------
    # Selectors
    # ------------------------------------------------------------------

    def selector(self, ref: str, item: Dict[str, Any]) -> List[Any]:
        """A conditional field (or the profile field) as a selector, or flattened when it cannot be one."""
        conditionals: List[Tuple[Any, List[Any]]] = []
        for cond in item.get('conditional') or []:
            if isinstance(cond, dict):
                conditionals.append((cond.get('value'), list(cond.get('properties') or [])))
        if self.selects_profile(ref, item):
            return [self.profile_selector(ref, item, conditionals)]

        options = self.enum_list(item)
        values = [o[0] if isinstance(o, list) else o for o in options]
        for value, _props in conditionals:
            for each in value if isinstance(value, list) else [value]:
                if each not in values:
                    values.append(each)
                    options.append(each)
        if any(not isinstance(v, str) for v in values):
            # A branch key is a string: a boolean (or numeric) toggle is flattened
            self.warn(f'{ref}: the conditional on a non-string value is flattened; its properties are always shown')
            plain = dict(item)
            plain.pop('conditional', None)
            out: List[Any] = self.reference_plain(ref, plain)
            for _value, props in conditionals:
                for spec in self.properties(props, {}):
                    if spec not in out:
                        out.append(spec)
            return out

        labels = {
            (o[0] if isinstance(o, list) else o): (o[1] if isinstance(o, list) and len(o) > 1 else None)
            for o in options
        }
        out_field = self.selector_head(ref, item)
        branches: Dict[str, Any] = {}
        for value in values:
            props: List[Any] = []
            for cond_value, cond_props in conditionals:
                if cond_value == value or (isinstance(cond_value, list) and value in cond_value):
                    props.extend(cond_props)
            branch: Dict[str, Any] = {'title': labels.get(value) or value}
            branch['properties'] = self.properties(props, {}, unwrap=value)
            branches[value] = branch
        out_field['enum'] = branches
        return [out_field]

    def reference_plain(self, ref: str, item: Dict[str, Any]) -> List[Any]:
        """A flattened toggle: its own definition, minus the conditional."""
        if ref in self.fields:
            self.definitions[ref] = self.convert_field(ref, item)
            return [ref]
        converted = self.convert_field(ref, item)
        converted.setdefault('name', ref)
        return [converted]

    def selector_head(self, ref: str, item: Dict[str, Any]) -> Dict[str, Any]:
        """The selector's own members (name, title, description, type, default)."""
        head: Dict[str, Any] = {'name': _short(ref)}
        for key in ('title', 'description', 'type', 'default', 'hidden', 'readonly'):
            if key in item:
                head[key] = copy.deepcopy(item[key])
        head.setdefault('type', 'string')
        return head

    def profile_selector(
        self, ref: str, item: Dict[str, Any], conditionals: List[Tuple[Any, List[Any]]]
    ) -> Dict[str, Any]:
        """The profile field as the ``profile`` selector: one branch per profile."""
        head = self.selector_head(ref, item)
        self.profile_selectors[id(head)] = head['name']
        if head['name'] != PROFILE_SELECTOR:
            self.warn(f'{ref}: the profile selector is stored as "{PROFILE_SELECTOR}", as the old engine stored it')
            head['name'] = PROFILE_SELECTOR
        if 'default' not in head and self.default_profile is not None:
            head['default'] = self.default_profile
        options = self.enum_list(item)
        order: List[str] = []
        labels: Dict[str, Any] = {}
        for option in options:
            value = option[0] if isinstance(option, list) else option
            if isinstance(value, str) and value not in order:
                order.append(value)
                labels[value] = option[1] if isinstance(option, list) and len(option) > 1 else value
        for value, _props in conditionals:
            for each in value if isinstance(value, list) else [value]:
                if isinstance(each, str) and each not in order:
                    order.append(each)
                    labels[each] = self.profile_title(each)
        # A profile no option or conditional names is still a value the old engine accepted
        for each in self.profiles:
            if each not in order:
                order.append(each)
                labels[each] = self.profile_title(each)
        branches: Dict[str, Any] = {}
        for value in order:
            props: List[Any] = []
            for cond_value, cond_props in conditionals:
                if cond_value == value or (isinstance(cond_value, list) and value in cond_value):
                    props.extend(cond_props)
            profile = self.profiles.get(value) if isinstance(self.profiles.get(value), dict) else {}
            specs = self.properties(props, profile, unwrap=value)
            specs.extend(self.constants(profile, specs))
            branches[value] = {'title': labels.get(value) or value, 'properties': specs}
        head['enum'] = branches
        return head

    def profile_title(self, name: str) -> str:
        """A profile's own ``title``, else its name (the label of a branch no option labels)."""
        profile = self.profiles.get(name)
        title = profile.get('title') if isinstance(profile, dict) else None
        return title if isinstance(title, str) else name

    def constants(self, profile: Dict[str, Any], specs: List[Any]) -> List[Any]:
        """A ``constant`` for every profile key no property in ``specs`` declares."""
        names = self.names(specs)
        out: List[Any] = []
        for key, value in profile.items():
            if key in PROFILE_METADATA or key in names:
                continue
            constant = {'name': key, 'type': 'constant', 'default': copy.deepcopy(value)}
            self.generated.add(id(constant))
            out.append(constant)
        return out

    def names(self, specs: Iterable[Any]) -> Set[str]:
        """Every property name ``specs`` declares, groups and branches included."""
        found: Set[str] = set()
        for spec in specs:
            if isinstance(spec, str):
                found.add(_short(spec))
                definition = self.definitions.get(spec)
                if isinstance(definition, dict) and isinstance(definition.get('properties'), list):
                    found |= self.names(definition['properties'])
            elif isinstance(spec, dict):
                name = spec.get('name') or (_short(spec['base']) if isinstance(spec.get('base'), str) else None)
                if name:
                    found.add(_short(name))
                if isinstance(spec.get('properties'), list):
                    found |= self.names(spec['properties'])
                if isinstance(spec.get('enum'), dict):
                    for branch in spec['enum'].values():
                        if isinstance(branch, dict):
                            found |= self.names(branch.get('properties') or [])
        return found

    # ------------------------------------------------------------------
    # The definition
    # ------------------------------------------------------------------

    def section(self) -> Optional[Dict[str, Any]]:
        """The shape section holding the node's own properties."""
        sections = [s for s in self.doc.get('shape') or [] if isinstance(s, dict)]
        for wanted in SECTION_ORDER:
            for section in sections:
                if section.get('section') == wanted:
                    return section
        return sections[0] if sections else None

    def run(self) -> Dict[str, Any]:
        """Build the converted definition, member order kept, ``legacy`` last."""
        has_service = isinstance(self.doc.get('protocol'), str)
        properties: List[Any] = []
        if has_service:
            chosen = self.section()
            for other in self.doc.get('shape') or []:
                if isinstance(other, dict) and other is not chosen:
                    self.warn(f'the "{other.get("section")}" section has no counterpart and was dropped')
            root_values: Dict[str, Any] = {}
            if chosen is not None:
                if self.profiles and not any(
                    self.selects_profile(n, f) for n, f in self.fields.items() if isinstance(f, dict)
                ):
                    profile = self.profiles.get(self.default_profile) if self.default_profile else None
                    root_values = profile if isinstance(profile, dict) else {}
                properties = self.properties(chosen.get('properties') or [], root_values)
                if root_values:
                    properties.extend(self.constants(root_values, properties))
        else:
            # A shared-definition library: every field converts as itself, a
            # conditional one as a selector definition (its name is its key)
            for name, item in self.fields.items():
                if not isinstance(item, dict):
                    continue
                self.reached.add(name)
                if 'conditional' in item:
                    specs = self.selector(name, item)
                    if len(specs) == 1 and isinstance(specs[0], dict) and isinstance(specs[0].get('enum'), dict):
                        self.definitions[name] = {k: v for k, v in specs[0].items() if k != 'name'}
                        continue
                self.definitions[name] = self.convert_field(name, item)

        if 'config' in self.doc:
            self.warn(
                'the "config" member is refused by the current engine and was dropped; mark fields "secret" or "readonly" instead'
            )
        unreached = [n for n in self.fields if n not in self.reached]
        if unreached and has_service:
            self.warn(f"not reached from the node's section, so not carried over: {', '.join(unreached)}")
        if self.shared_refs:
            self.warn(
                'kept as references to shared definitions (check each exists in the current catalog): '
                + ', '.join(self.shared_refs)
            )

        # `propertyDefinitions` takes the place of `fields` (else of `shape`),
        # `properties` the place of `shape`; every other member stays put
        out: Dict[str, Any] = {}
        placed_defs = placed_props = False
        for key, value in self.doc.items():
            if key in ('fields', 'shape') and self.definitions and not placed_defs:
                out['propertyDefinitions'] = self.definitions
                placed_defs = True
            if key == 'shape' and has_service:
                out['properties'] = properties
                placed_props = True
            if key in REPLACED_MEMBERS or key == 'legacy':
                continue
            out[key] = copy.deepcopy(value)
        if self.definitions and not placed_defs:
            out['propertyDefinitions'] = self.definitions
        if has_service and not placed_props:
            out['properties'] = properties
        return out


# ============================================================================
# Entry points
# ============================================================================


def is_old_format(doc: Dict[str, Any]) -> bool:
    """Whether ``doc`` is an old-format definition (``preconfig``, ``fields`` or ``shape``, and no current members)."""
    if 'propertyDefinitions' in doc or 'properties' in doc:
        return False
    return any(key in doc for key in ('preconfig', 'fields', 'shape'))


def convert_definition(old: Dict[str, Any], shared: Optional[Dict[str, Any]] = None) -> NodeConversion:
    """
    Convert one old-format node definition and attach its ``legacy`` block.

    Args:
        old: The parsed old definition (``load_json``).
        shared: Shared ``propertyDefinitions`` (``core/services.common*.json``)
            when available; used to compare defaults and to classify shared
            selectors exactly as ``tools/legacy_blocks.py`` does. Optional: a
            reference to a definition it does not hold is kept by name.

    Returns:
        The converted definition, its warnings, and whether a ``legacy``
        block was written.

    Raises:
        ValueError: when ``old`` is not an old-format definition.
    """
    if not isinstance(old, dict) or not is_old_format(old):
        raise ValueError(
            'not an old-format node definition (no "preconfig", "fields" or "shape", or it already declares "properties")'
        )
    # The containers the conversion walks: a wrong type is this file's error, never a crash mid-batch
    for key, kind, what in (('fields', dict, 'an object'), ('preconfig', dict, 'an object'), ('shape', list, 'a list')):
        if old.get(key) is not None and not isinstance(old[key], kind):
            raise ValueError(f'"{key}" must be {what}')
    profiles = (old.get('preconfig') or {}).get('profiles')
    if profiles is not None and not isinstance(profiles, dict):
        raise ValueError('"preconfig.profiles" must be an object')
    shared = shared or {}
    converter = _Converter(old, shared)
    definition = converter.run()
    result = NodeConversion(definition, converter.warnings)
    if isinstance(old.get('protocol'), str):
        block = build_block(old, definition, shared)
        if wants_block(old, block):
            definition['legacy'] = block
            result.legacy = True
    return result
