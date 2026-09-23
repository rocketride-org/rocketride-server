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

"""
Guard the one place scan_cropper's Scan types are written down twice.

A Scan type's numbers live in ``preconfig.profiles`` — that is what actually reaches the node,
because ``Config.getNodeConfig`` merges the selected profile underneath the user's settings. The
same numbers appear a second time as ``default`` on the fields its "Show advanced settings" switch
reveals, which is what makes the switch open on that Scan type's real values instead of on a shared
set. Nothing in the engine ties the two together.

So they can drift, and drift is silent in the worst way: the form would show one number while the
node used another, and every crop would come out subtly wrong with no error anywhere. These tests
are the tie.
"""

import json
import os
import re
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICES = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'scan_cropper', 'services.json')

# The two settings every Scan type carries, which are not tunables and are never overridden.
_UNIVERSAL = ('scan_cropper.deskew', 'scan_cropper.quality')


def _load_services():
    """
    Parse the node descriptor, which is JSONC rather than JSON.

    Only whole-line ``//`` comments are stripped, so a ``//`` inside a description or a URL is
    left alone; trailing commas are then removed.

    Returns:
        dict: The parsed descriptor.
    """
    with open(_SERVICES, encoding='utf-8') as handle:
        text = handle.read()
    text = re.sub(r'(?m)^\s*//.*$', '', text)
    text = re.sub(r',(\s*[}\]])', r'\1', text)
    return json.loads(text)


def _bare(field_id):
    """
    Reduce a field ID to the key the node actually receives.

    The engine's ``getFieldName`` takes everything after the last dot, which is what lets
    ``scan_cropper.textured.texture`` and ``scan_cropper.texture`` both arrive as ``texture``.

    Args:
        field_id: A field ID as written in ``services.json``.

    Returns:
        str: The bare field name.
    """
    return field_id.rsplit('.', 1)[-1]


class TestScanTypes(unittest.TestCase):
    """The Scan type dropdown, its groups, and the profiles behind them agree."""

    @classmethod
    def setUpClass(cls):
        cls.services = _load_services()
        cls.fields = cls.services['fields']
        cls.profiles = cls.services['preconfig']['profiles']

    def test_every_profile_is_reachable(self):
        """A profile with no dropdown entry can never be selected, and one with no group loses every setting."""
        offered = {case['value'] for case in self.fields['scan_cropper.profile']['conditional']}
        self.assertEqual(offered, set(self.profiles))

        for name in self.profiles:
            group = self.fields.get(f'scan_cropper.{name}')
            self.assertIsNotNone(group, f'profile {name} has no group')
            # The group name is load-bearing: getNodeConfig reads the user's settings from
            # connConfig[profile], so a group named anything else delivers nothing.
            self.assertEqual(group['object'], name)

    def test_default_profile_exists(self):
        """The profile used when none is chosen has to be one that exists, or getNodeConfig raises."""
        self.assertIn(self.services['preconfig']['default'], self.profiles)

    def test_universal_settings_are_in_every_group(self):
        """Straighten and JPEG quality are dropped unless each group carries its own copy."""
        for name in self.profiles:
            props = self.fields[f'scan_cropper.{name}']['properties']
            for field_id in _UNIVERSAL:
                self.assertIn(field_id, props, f'{name} would silently ignore {field_id}')

    def test_every_conditional_covers_every_value(self):
        """
        A value with no branch leaves the form with nothing to resolve.

        ``getDependencies`` emits one ``oneOf`` entry per conditional and nothing more, so a
        controlling field whose current value matches no entry has no valid subschema. Listing
        only the interesting branch is the easy mistake — the switch works when it is on and
        the whole group vanishes when it is off.
        """
        for field_id, spec in self.fields.items():
            if 'conditional' not in spec:
                continue
            covered = {case['value'] for case in spec['conditional']}

            if spec['type'] == 'boolean':
                possible = {True, False}
            else:
                possible = {e[0] if isinstance(e, list) else e for e in spec['enum']}
                # The profile field's enum is a wildcard the engine expands from preconfig.
                if possible == {'*>preconfig.profiles.*.title'}:
                    possible = set(self.profiles)

            self.assertEqual(possible - covered, set(), f'{field_id} has values with no branch')

    def test_revealed_fields_are_not_also_listed_outright(self):
        """A field named both in a conditional and in a group renders unconditionally, ignoring the switch."""
        listed = {prop for fid, spec in self.fields.items() if 'object' in spec for prop in spec['properties']}
        listed |= set(self.services['shape'][0]['properties'])

        for field_id, spec in self.fields.items():
            for case in spec.get('conditional', []):
                for prop in case['properties']:
                    self.assertNotIn(prop, listed, f'{prop} is revealed by {field_id} but also always shown')

    def test_every_scan_type_offers_the_same_tunables(self):
        """Switching Scan type must not change which settings exist, only what they are set to."""
        seen = {}
        for name in self.profiles:
            revealed = self.fields[f'scan_cropper.{name}.tune']['conditional'][0]['properties']
            seen[name] = sorted(_bare(field_id) for field_id in revealed)

        first = seen[self.services['preconfig']['default']]
        for name, names in seen.items():
            self.assertEqual(names, first, f'{name} offers a different set of settings')


class TestPresetValuesMatch(unittest.TestCase):
    """What the form shows for a Scan type is what the node will use."""

    @classmethod
    def setUpClass(cls):
        cls.services = _load_services()
        cls.fields = cls.services['fields']
        cls.profiles = cls.services['preconfig']['profiles']

    def _shown_for(self, profile):
        """
        Resolve what the form displays when a Scan type's advanced switch is opened.

        Args:
            profile: The profile name.

        Returns:
            dict: Bare field name -> the default the form would show.
        """
        revealed = self.fields[f'scan_cropper.{profile}.tune']['conditional'][0]['properties']
        return {_bare(field_id): self.fields[field_id]['default'] for field_id in revealed}

    def test_form_shows_what_the_node_will_use(self):
        """Every value a profile sets must be the value its own switch displays."""
        for name, profile in self.profiles.items():
            shown = self._shown_for(name)
            for key, value in profile.items():
                if key == 'title':
                    continue
                self.assertIn(key, shown, f'profile {name} sets {key}, which its switch never shows')
                self.assertEqual(
                    shown[key],
                    value,
                    f'profile {name} sets {key}={value} but the form shows {shown[key]}',
                )

    def test_overrides_are_only_where_a_profile_differs(self):
        """A per-profile copy that matches the shared default is dead weight - reference the shared field."""
        for field_id, spec in self.fields.items():
            parts = field_id.split('.')
            if len(parts) != 3 or parts[2] == 'tune':
                continue
            _, profile, name = parts
            shared = self.fields.get(f'scan_cropper.{name}')
            self.assertIsNotNone(shared, f'{field_id} overrides a field that does not exist')
            self.assertNotEqual(
                spec['default'],
                shared['default'],
                f'{field_id} repeats the shared default; reference scan_cropper.{name} instead',
            )
            self.assertEqual(self.profiles[profile].get(name), spec['default'])

    def test_bounds_are_carried_over_by_every_override(self):
        """An override that drops its range lets the UI offer a value the algorithm was never tried at."""
        for field_id, spec in self.fields.items():
            parts = field_id.split('.')
            if len(parts) != 3 or parts[2] == 'tune':
                continue
            shared = self.fields[f'scan_cropper.{parts[2]}']
            for bound in ('type', 'minimum', 'maximum'):
                self.assertEqual(spec.get(bound), shared.get(bound), f'{field_id} changed {bound}')
            self.assertGreaterEqual(spec['default'], spec['minimum'])
            self.assertLessEqual(spec['default'], spec['maximum'])


if __name__ == '__main__':
    unittest.main()
