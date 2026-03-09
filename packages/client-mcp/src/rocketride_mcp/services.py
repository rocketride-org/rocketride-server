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

"""Query live service definitions from the RocketRide engine."""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from rocketride import RocketRideClient

_CACHE_TTL_SECONDS = 300  # 5 minutes
_cached_services: Optional[tuple[str, float]] = None


async def fetch_services(client: RocketRideClient) -> Optional[str]:
    """Fetch all service definitions from the engine and format for AI consumption.

    Returns a formatted string describing every available node, its profiles,
    and config fields. Cached with a 5-minute TTL.
    """
    global _cached_services

    if _cached_services:
        content, fetched_at = _cached_services
        if time.time() - fetched_at < _CACHE_TTL_SECONDS:
            return content

    try:
        response = await client.get_services()
    except Exception:
        if _cached_services:
            return _cached_services[0]
        return None

    services = response.get('services', {})
    if not isinstance(services, dict) or not services:
        if _cached_services:
            return _cached_services[0]
        return None

    content = _format_services(services)
    _cached_services = (content, time.time())
    return content


def _format_services(services: Dict[str, Any]) -> str:
    """Format raw engine service definitions into a readable reference for the AI.

    The engine returns each service as a dict with keys like:
      title, protocol, classType, capabilities, description, lanes,
      input, preconfig (default + profiles dict), fields, shape
    """
    lines: List[str] = []
    lines.append('# RocketRide Node Service Catalog (Live from Engine)')
    lines.append('')
    lines.append('This is the live service catalog from the running RocketRide engine.')
    lines.append('It reflects the exact nodes, profiles, and config fields available.')
    lines.append('')

    for name, definition in sorted(services.items()):
        if not isinstance(definition, dict):
            continue

        title = definition.get('title', name)
        lines.append(f'## {name} — {title}')

        # Description (may be a list of strings)
        desc = definition.get('description', '')
        if isinstance(desc, list):
            desc = ''.join(desc)
        if desc:
            lines.append(f'  {desc.strip()}')

        # Class type and capabilities
        class_type = definition.get('classType', [])
        if class_type:
            lines.append(f'  Type: {", ".join(class_type)}')
        capabilities = definition.get('capabilities', [])
        if capabilities:
            lines.append(f'  Capabilities: {", ".join(capabilities)}')

        # Lanes: input → output mapping
        lanes = definition.get('lanes', {})
        if isinstance(lanes, dict) and lanes:
            for lane_in, lanes_out in lanes.items():
                if isinstance(lanes_out, list):
                    lines.append(f'  Lanes: {lane_in} → {", ".join(lanes_out)}')
                else:
                    lines.append(f'  Lanes: {lane_in} → {lanes_out}')

        # Input definitions (structured lane specs)
        input_defs = definition.get('input', [])
        if isinstance(input_defs, list) and input_defs and not lanes:
            for inp in input_defs:
                if not isinstance(inp, dict):
                    continue
                lane_in = inp.get('lane', '?')
                outputs = inp.get('output', [])
                out_names = [o.get('lane', '?') for o in outputs if isinstance(o, dict)]
                if out_names:
                    lines.append(f'  Lanes: {lane_in} → {", ".join(out_names)}')

        # Profiles from preconfig
        preconfig = definition.get('preconfig', {})
        if isinstance(preconfig, dict):
            default_profile = preconfig.get('default', '')
            profiles = preconfig.get('profiles', {})
            if isinstance(profiles, dict) and profiles:
                profile_entries: List[str] = []
                for pname, pdef in profiles.items():
                    label = pname
                    if isinstance(pdef, dict):
                        ptitle = pdef.get('title', '')
                        model = pdef.get('model', '')
                        tokens = pdef.get('modelTotalTokens', '')
                        suffix_parts: List[str] = []
                        if model:
                            suffix_parts.append(f'model={model}')
                        if tokens:
                            suffix_parts.append(f'tokens={tokens}')
                        if ptitle and ptitle != pname:
                            suffix_parts.insert(0, ptitle)
                        suffix = ', '.join(suffix_parts)
                        if pname == default_profile:
                            label = f'{pname} (default)'
                        if suffix:
                            label = f'{label} [{suffix}]'
                    elif pname == default_profile:
                        label = f'{pname} (default)'
                    profile_entries.append(label)
                lines.append(f'  Profiles: {"; ".join(profile_entries)}')

        # Config fields from fields definition
        fields = definition.get('fields', {})
        if isinstance(fields, dict) and fields:
            config_fields: List[str] = []
            for field_name, field_def in fields.items():
                if not isinstance(field_def, dict):
                    continue
                # Skip object/conditional groupings, only show actual fields
                if 'object' in field_def or field_name.count('.') > 1:
                    continue
                ftype = field_def.get('type', '')
                fdesc = field_def.get('description', field_def.get('title', ''))
                fdefault = field_def.get('default')
                parts = [field_name]
                if ftype:
                    parts.append(f'({ftype})')
                if fdesc:
                    parts.append(f': {fdesc}')
                if fdefault is not None:
                    parts.append(f' [default: {fdefault}]')
                config_fields.append(' '.join(parts))
            if config_fields:
                lines.append('  Config fields:')
                for cf in config_fields:
                    lines.append(f'    - {cf}')

        lines.append('')

    return '\n'.join(lines)
