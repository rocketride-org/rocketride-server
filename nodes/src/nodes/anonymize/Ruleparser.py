# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

import re


class RuleParser:
    def __init__(self, file_path):
        """Load all idRef -> English name mappings once during initialization."""
        self.id_to_name = self._load_rules(file_path)

    def _load_rules(self, file_path):
        """Read the file once and stores all idRef -> English name mappings."""
        id_to_name = {}

        with open(file_path, 'r', encoding='utf-16') as f:
            content = f.read()

        # Find all <Resource idRef="..."> ... </Resource>
        resource_pattern = r'<Resource\s+idRef="([^"]+)">(.*?)</Resource>'
        resources = re.findall(resource_pattern, content, flags=re.DOTALL)

        for id_ref, resource_content in resources:
            # Find English name inside <Name langcode="en">...</Name>
            name_pattern = r'<Name\s+langcode="en"[^>]*>(.*?)</Name>'
            name_match = re.search(name_pattern, resource_content)

            if name_match:
                name = name_match.group(1).strip()
                if 'Placeholder' not in name:  # Ignore placeholders
                    id_to_name[id_ref] = name  # Store in dictionary

        return id_to_name

    def get_rules_names(self, unique_id_refs):
        """Return English names for the given unique_id_refs."""
        return [self.id_to_name[id_ref] for id_ref in unique_id_refs if id_ref in self.id_to_name]
