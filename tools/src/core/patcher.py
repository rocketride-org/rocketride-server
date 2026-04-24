"""
Patcher — comment-preserving JSON5 patcher for services.json files.

services.json files use JSON5 format: // comments, trailing commas.
Stdlib json will reject them. This module uses the json5 package for
parsing and a bracket-counting splice strategy for writing, so that
top-level // comment blocks are never disturbed.

Patching strategy
-----------------
1. Read the file as raw text.
2. Parse the whole file with json5 to get the full data dict.
3. Locate the ``"profiles": {`` block in the raw text via bracket counting.
4. Re-serialise only the updated profiles dict as JSON (tab-indented).
5. Splice the new profiles block back into the raw text.
6. Write the result (or return it in dry-run mode).
"""

from __future__ import annotations

import json
import re
from typing import Dict, Any

try:
    import json5
except ImportError:
    raise ImportError("The 'json5' package is required. Install it with: pip install json5")


def load(file_path: str) -> Dict[str, Any]:
    """
    Parse a services.json file (JSON5 format) and return its data as a dict.

    Args:
        file_path: Absolute or relative path to the services.json file

    Returns:
        Parsed data dict
    """
    with open(file_path, 'r', encoding='utf-8') as fh:
        return json5.load(fh)


def _find_profiles_block(raw: str) -> tuple[int, int, int]:
    """
    Find the character range of the value of "profiles": { ... } in raw text.

    Uses bracket counting so it handles any level of nesting correctly.
    Searches for the literal string ``"profiles":`` followed (possibly after
    whitespace/comments) by ``{``, then counts braces until the matching
    ``}`` is found.

    Args:
        raw: Full file content as a string

    Returns:
        (start, end, indent_level) where raw[start:end] is the profiles object
        and indent_level is the number of leading tabs on the ``"profiles":`` line,
        used to re-indent the serialised replacement block.

    Raises:
        ValueError: If the profiles block cannot be located
    """
    # Find "profiles": with optional whitespace before the opening brace
    pattern = re.compile(r'"profiles"\s*:\s*(\{)', re.DOTALL)
    match = pattern.search(raw)
    if not match:
        raise ValueError('Could not locate "profiles": { in services.json')

    brace_start = match.start(1)

    # Determine indentation of the "profiles": line so the replacement block
    # can be indented to the same depth.
    line_start = raw.rfind('\n', 0, brace_start) + 1
    line_prefix = raw[line_start:brace_start]
    indent_level = len(line_prefix) - len(line_prefix.lstrip('\t'))

    depth = 0
    i = brace_start
    while i < len(raw):
        ch = raw[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return brace_start, i + 1, indent_level
        i += 1

    raise ValueError('Unbalanced braces: could not find end of "profiles" block')


# Canonical field order within a single profile dict.
# Fields listed here appear first, in this order; any unlisted fields follow
# in their original insertion order.
_PROFILE_FIELD_ORDER = [
    'title',
    'model',
    'modelSource',
    'modelTotalTokens',
    '_src_modelTotalTokens',
    'modelOutputTokens',
    '_src_modelOutputTokens',
    'deprecated',
    'deprecatedSince',
    'migration',
]


def _normalize_profile(profile: Any) -> Any:
    """
    Return a profile dict with fields in canonical order.

    Non-dict values (e.g. the ``"custom"`` placeholder) are returned unchanged.

    Args:
        profile: A single profile value from the profiles dict

    Returns:
        A new dict with fields ordered canonically, or the original value unchanged
    """
    if not isinstance(profile, dict):
        return profile
    ordered: Dict[str, Any] = {}
    for key in _PROFILE_FIELD_ORDER:
        if key in profile:
            ordered[key] = profile[key]
    for key, value in profile.items():
        if key not in ordered:
            ordered[key] = value
    return ordered


def _inject_source_comments(serialized: str) -> str:
    """
    Post-process a serialised profiles JSON string to turn ``_src_FIELD``
    annotation lines into inline ``// source`` comments on the preceding field.

    The merger writes provenance as sibling keys, e.g.::

        "modelTotalTokens": 1000000,
        "_src_modelTotalTokens": "openrouter",

    This function converts that pair into::

        "modelTotalTokens": 1000000, // openrouter

    The ``_src_*`` line is then removed.

    Args:
        serialized: JSON string from json.dumps()

    Returns:
        String with source annotations converted to inline comments
    """
    lines = serialized.split('\n')
    result = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # Detect a _src_ annotation line: optional whitespace, "_src_FIELD": "value"
        src_match = re.match(r'^(\s*)"_src_(\w+)":\s*"([^"]*)"(,?)$', line)
        if src_match and result:
            field_name = src_match.group(2)
            source_val = src_match.group(3)
            # Find the most recent output line that contains the annotated field
            for j in range(len(result) - 1, -1, -1):
                prev = result[j]
                if f'"{field_name}"' in prev:
                    # Append the inline comment, stripping any trailing comma first
                    # then re-appending it so the comment sits before the comma.
                    comma_match = re.search(r'(,)\s*$', prev)
                    if comma_match:
                        result[j] = prev[: comma_match.start(1)] + f', // {source_val}'
                    else:
                        result[j] = prev.rstrip() + f' // {source_val}'
                    break
            # Drop the _src_ line (do not append to result)
        else:
            result.append(line)
        i += 1
    return '\n'.join(result)


def _serialize_profiles(profiles: Dict[str, Any], indent_level: int = 0) -> str:
    """
    Serialise a profiles dict to a pretty-printed JSON string with tab indentation.

    All lines after the opening ``{`` are prefixed with ``indent_level`` extra tabs
    so the block slots in at the correct depth inside the surrounding file.
    Profile fields are normalised to canonical order before serialisation.
    ``_src_FIELD`` annotation keys are converted to inline ``// source`` comments.

    Args:
        profiles: The profiles dict to serialise
        indent_level: Number of extra tabs to prepend to every line except the first

    Returns:
        JSON string properly indented for in-place splicing
    """
    normalised = {key: _normalize_profile(value) for key, value in profiles.items()}
    raw = json.dumps(normalised, indent='\t', ensure_ascii=False)
    raw = _inject_source_comments(raw)
    if indent_level <= 0:
        return raw
    prefix = '\t' * indent_level
    lines = raw.split('\n')
    return '\n'.join(lines[:1] + [prefix + line for line in lines[1:]])


def _find_fields_block(raw: str) -> tuple[int, int, int]:
    """
    Find the character range of the value of ``"fields": { ... }`` in raw text.

    Same bracket-counting approach as ``_find_profiles_block`` but targets
    the top-level ``"fields"`` key.

    Args:
        raw: Full file content as a string

    Returns:
        (start, end, indent_level) where raw[start:end] is the fields object

    Raises:
        ValueError: If the fields block cannot be located
    """
    pattern = re.compile(r'"fields"\s*:\s*(\{)', re.DOTALL)
    match = pattern.search(raw)
    if not match:
        raise ValueError('Could not locate "fields": { in services.json')

    brace_start = match.start(1)
    line_start = raw.rfind('\n', 0, brace_start) + 1
    line_prefix = raw[line_start:brace_start]
    indent_level = len(line_prefix) - len(line_prefix.lstrip('\t'))

    depth = 0
    i = brace_start
    while i < len(raw):
        ch = raw[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return brace_start, i + 1, indent_level
        i += 1

    raise ValueError('Unbalanced braces: could not find end of "fields" block')


def _detect_namespace(fields: Dict[str, Any]) -> str:
    """
    Detect the field namespace prefix from the fields dict.

    Looks for a key ending in ``'.profile'`` (e.g. ``'mistral.profile'`` → ``'mistral'``).

    Args:
        fields: The parsed ``"fields"`` dict from services.json

    Returns:
        Namespace string, or empty string if not found
    """
    for key in fields:
        if key.endswith('.profile'):
            return key[: -len('.profile')]
    return ''


def _repair_field_objects(fields: Dict[str, Any]) -> bool:
    """
    Ensure every profile field object that exposes ``llm.cloud.apikey`` also
    exposes ``llm.cloud.modelSource``, and that ``llm.cloud.modelSource`` is
    always the last entry in its ``properties`` list.

    This is a forward-compatibility repair: field objects created before
    ``llm.cloud.modelSource`` was introduced omit it from their properties list,
    and occasionally a provider-specific field gets inserted after it by hand.
    Running this repair on every patch pass heals both cases even when no new
    profiles are being added in the current sync run.

    Args:
        fields: The ``"fields"`` dict to mutate in-place

    Returns:
        True if at least one field object was repaired, False otherwise
    """
    repaired = False
    for value in fields.values():
        if not isinstance(value, dict):
            continue
        props = value.get('properties')
        if not isinstance(props, list):
            continue
        has_apikey = 'llm.cloud.apikey' in props
        has_model_source = 'llm.cloud.modelSource' in props
        if has_apikey and not has_model_source:
            props.append('llm.cloud.modelSource')
            repaired = True
        elif has_model_source and props[-1] != 'llm.cloud.modelSource':
            props.remove('llm.cloud.modelSource')
            props.append('llm.cloud.modelSource')
            repaired = True
    return repaired


def _update_fields_for_added(
    fields: Dict[str, Any],
    namespace: str,
    profile_key: str,
    profile: Dict[str, Any],
    protected: set,
) -> None:
    """
    Add the three field entries required for a newly added profile:
    the field object, enum entry, and conditional entry.

    Skips protected keys (e.g. ``"custom"``). Does not add duplicate entries.
    Only updates the ``enum`` if it is a static list of ``[key, title]`` pairs
    (dynamic ``["*>preconfig.profiles.*.title"]`` references are left untouched).

    Args:
        fields: The ``"fields"`` dict to mutate in-place
        namespace: Field namespace prefix (e.g. ``'mistral'``)
        profile_key: Profile key being added (e.g. ``'devstral-medium'``)
        profile: The new profile dict (used for the title)
        protected: Profile keys that should never be touched (e.g. ``{'custom'}``)
    """
    if not namespace or profile_key in protected:
        return

    field_key = f'{namespace}.{profile_key}'

    # 1. Field object
    if field_key not in fields:
        fields[field_key] = {
            'object': profile_key,
            'properties': ['llm.cloud.apikey', 'llm.cloud.modelSource'],
        }

    # 2 & 3. enum + conditional live inside the profile selector field
    profile_field = fields.get(f'{namespace}.profile')
    if not isinstance(profile_field, dict):
        return

    # enum — only touch if it's a static list of [key, title] pairs
    enum = profile_field.get('enum', [])
    if enum and isinstance(enum[0], list):
        existing = {e[0] for e in enum if isinstance(e, list)}
        if profile_key not in existing:
            title = profile.get('title', profile_key)
            enum.append([profile_key, title])

    # conditional
    conditional = profile_field.get('conditional', [])
    existing_vals = {c.get('value') for c in conditional if isinstance(c, dict)}
    if profile_key not in existing_vals:
        conditional.append({'value': profile_key, 'properties': [field_key]})


def _update_fields_for_deprecated(
    fields: Dict[str, Any],
    namespace: str,
    profile_key: str,
    protected: set,
) -> None:
    """
    Mark a profile as deprecated in the static enum by appending
    ``' (deprecated)'`` to its display title.

    The field object and conditional entry are intentionally left intact so
    that existing pipelines that reference the profile continue to load and run.

    Skips protected keys and dynamic enum references.

    Args:
        fields: The ``"fields"`` dict to mutate in-place
        namespace: Field namespace prefix
        profile_key: Profile key being deprecated
        protected: Profile keys that should never be touched
    """
    if not namespace or profile_key in protected:
        return

    profile_field = fields.get(f'{namespace}.profile')
    if not isinstance(profile_field, dict):
        return

    enum = profile_field.get('enum', [])
    if not (enum and isinstance(enum[0], list)):
        return  # dynamic reference — skip

    for entry in enum:
        if isinstance(entry, list) and entry[0] == profile_key:
            if len(entry) > 1 and not str(entry[1]).endswith(' (deprecated)'):
                entry[1] = str(entry[1]) + ' (deprecated)'
            break


def _serialize_fields(fields: Dict[str, Any], indent_level: int = 0) -> str:
    """
    Serialise a fields dict to a pretty-printed JSON string with tab indentation.

    Unlike the profiles serialiser, the fields block contains no ``//`` comments
    so it can be serialised with plain ``json.dumps`` without special handling.

    Args:
        fields: The complete ``"fields"`` dict
        indent_level: Number of extra tabs to prepend to every line except the first

    Returns:
        JSON string properly indented for in-place splicing
    """
    raw = json.dumps(fields, indent='\t', ensure_ascii=False)
    if indent_level <= 0:
        return raw
    prefix = '\t' * indent_level
    lines = raw.split('\n')
    return '\n'.join(lines[:1] + [prefix + line for line in lines[1:]])


def patch(
    file_path: str,
    updated_profiles: Dict[str, Any],
    added_profile_keys: set | None = None,
    deprecated_profile_keys: set | None = None,
    protected_profile_keys: set | None = None,
    dry_run: bool = False,
) -> str:
    """
    Update ``preconfig.profiles`` and the ``fields`` block inside a services.json
    file while preserving all existing // comments and surrounding structure.

    For each newly added profile key the function:
      - adds a ``<ns>.<key>`` field object entry
      - appends ``[key, title]`` to the static ``enum`` list (if static)
      - appends a ``conditional`` entry

    For each deprecated profile key the function:
      - appends ``' (deprecated)'`` to the title in the static ``enum`` list

    Field objects and conditional entries for deprecated profiles are left intact
    so existing pipelines continue to load and run correctly.

    Args:
        file_path: Path to the services.json file to patch
        updated_profiles: The complete updated profiles dict
        added_profile_keys: Profile keys that were newly added (need field wiring)
        deprecated_profile_keys: Profile keys that were deprecated (enum label update)
        protected_profile_keys: Profile keys to never modify in the fields block
        dry_run: If True, return the new file content without writing to disk

    Returns:
        The new file content as a string

    Raises:
        ValueError: If the profiles or fields block cannot be located
        IOError: If the file cannot be read or written
    """
    with open(file_path, 'r', encoding='utf-8') as fh:
        raw = fh.read()

    _added = added_profile_keys or set()
    _deprecated = deprecated_profile_keys or set()
    _protected = protected_profile_keys or set()

    # --- Patch preconfig.profiles ---
    # Move newly added profiles to the end, sorted by key, so repeated runs produce
    # identical file output regardless of the order the provider API returned models in.
    if _added:
        existing_portion = {k: v for k, v in updated_profiles.items() if k not in _added}
        new_portion = {k: updated_profiles[k] for k in sorted(_added) if k in updated_profiles}
        updated_profiles = {**existing_portion, **new_portion}

    p_start, p_end, p_indent = _find_profiles_block(raw)
    new_profiles_str = _serialize_profiles(updated_profiles, indent_level=p_indent)
    raw = raw[:p_start] + new_profiles_str + raw[p_end:]

    try:
        f_start, f_end, f_indent = _find_fields_block(raw)
    except ValueError:
        # No fields block in this file — skip silently
        f_start = None

    if f_start is not None:
        # Parse the current fields block from the already-updated raw text
        fields_text = raw[f_start:f_end]
        try:
            fields: Dict[str, Any] = json5.loads(fields_text)
        except Exception:
            fields = json.loads(fields_text)

        ns = _detect_namespace(fields)

        # Repair existing field objects that are missing llm.cloud.modelSource
        _repair_field_objects(fields)

        for key in sorted(_added):
            profile = updated_profiles.get(key, {})
            _update_fields_for_added(fields, ns, key, profile, _protected)

        for key in sorted(_deprecated):
            _update_fields_for_deprecated(fields, ns, key, _protected)

        new_fields_str = _serialize_fields(fields, indent_level=f_indent)
        raw = raw[:f_start] + new_fields_str + raw[f_end:]

    if not dry_run:
        with open(file_path, 'w', encoding='utf-8') as fh:
            fh.write(raw)

    return raw


def get_profiles(file_path: str) -> Dict[str, Any]:
    """
    Extract the ``preconfig.profiles`` dict from a services.json file.

    Args:
        file_path: Path to the services.json file

    Returns:
        The profiles dict, or an empty dict if the key path does not exist
    """
    data = load(file_path)
    return data.get('preconfig', {}).get('profiles', {})
