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
Guard the shape of scan_cropper's Scan types in services.json.

A Scan type is a branch of the ``profile`` selector. A value a scan type decides
is an alias of the shared definition with its own default (``scan_cropper.loose.maxDepth``
on ``scan_cropper.maxDepth``); everything else is referenced identically by every
scan type and shared. One resolution pass feeds the form and the node, so the two
cannot disagree; what these tests tie down is the authoring: every scan type offers
the same tunables, an alias changes only the default, and the shared default is never
repeated as an alias.
"""

import json
import os
import re
import unittest

import rocketlib
from rocketlib.config import resolveConfig

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICES = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'scan_cropper', 'services.json')

# The two settings every Scan type carries, which are not tunables and are never aliased.
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
    Reduce a definition name to the key the node receives.

    The engine takes everything after the last dot, which is what lets
    ``scan_cropper.textured.texture`` and ``scan_cropper.texture`` both arrive as ``texture``.

    Args:
        field_id: A definition name as written in ``services.json``.

    Returns:
        str: The bare field name.
    """
    return field_id.rsplit('.', 1)[-1]


class TestScanTypes(unittest.TestCase):
    """The Scan type selector, its branches, and the aliases behind them agree."""

    @classmethod
    def setUpClass(cls):
        cls.services = _load_services()
        cls.definitions = cls.services['propertyDefinitions']
        selector = cls.services['properties'][0]
        cls.selector = selector
        cls.branches = selector['enum']

    def test_the_default_scan_type_exists(self):
        """The scan type used when none is chosen has to be one that exists."""
        self.assertIn(self.selector['default'], self.branches)

    def test_universal_settings_are_in_every_branch(self):
        """Straighten and JPEG quality are shared: referenced identically by every scan type."""
        for name, branch in self.branches.items():
            for field_id in _UNIVERSAL:
                self.assertIn(field_id, branch['properties'], f'{name} would silently drop {field_id}')

    def test_every_scan_type_offers_the_same_tunables(self):
        """Switching Scan type must not change which settings exist, only what they are set to."""
        seen = {
            name: sorted(_bare(field_id) for field_id in branch['properties']) for name, branch in self.branches.items()
        }
        first = seen[self.selector['default']]
        for name, names in seen.items():
            self.assertEqual(names, first, f'{name} offers a different set of settings')

    def test_aliases_change_only_the_default(self):
        """An alias is a scan type's own value of a shared tunable: same type and range, another default."""
        for field_id, spec in self.definitions.items():
            parts = field_id.split('.')
            if len(parts) != 3:
                continue
            _, scan_type, name = parts
            self.assertIn(scan_type, self.branches, f'{field_id} aliases for a scan type that does not exist')
            self.assertEqual(spec.get('base'), f'scan_cropper.{name}', f'{field_id} must alias scan_cropper.{name}')
            self.assertEqual(set(spec) - {'base', 'default'}, set(), f'{field_id} overrides more than the default')
            shared = self.definitions[f'scan_cropper.{name}']
            self.assertNotEqual(spec['default'], shared['default'], f'{field_id} repeats the shared default')
            self.assertGreaterEqual(spec['default'], shared['minimum'])
            self.assertLessEqual(spec['default'], shared['maximum'])
            self.assertIn(field_id, self.branches[scan_type]['properties'], f'{scan_type} does not use {field_id}')

    def test_a_branch_references_its_own_aliases_only(self):
        """A scan type that listed another scan type's alias would store that type's value under its own name."""
        for name, branch in self.branches.items():
            for field_id in branch['properties']:
                parts = field_id.split('.')
                if len(parts) == 3:
                    self.assertEqual(parts[1], name, f'{name} references {field_id}')


class TestResolvedValues(unittest.TestCase):
    """What the node receives for each Scan type is the scan type's own numbers."""

    @classmethod
    def setUpClass(cls):
        cls.schema = rocketlib.getServiceSchema('scan_cropper')
        cls.services = _load_services()

    def _resolve(self, conn_config):
        return resolveConfig(self.schema, conn_config)

    def test_each_scan_type_resolves_to_its_aliases(self):
        definitions = self.services['propertyDefinitions']
        for scan_type in self.services['properties'][0]['enum']:
            config = self._resolve({'profile': scan_type})
            for field_id, spec in definitions.items():
                parts = field_id.split('.')
                if len(parts) == 3 and parts[1] == scan_type:
                    self.assertEqual(config[parts[2]], spec['default'], f'{scan_type} resolves {parts[2]} wrongly')

    def test_the_shared_default_reaches_a_scan_type_without_an_alias(self):
        config = self._resolve({'profile': 'textured'})
        self.assertEqual((config['texture'], config['detectSize'], config['maxDepth']), (9.0, 3000, 4))


if __name__ == '__main__':
    unittest.main()
