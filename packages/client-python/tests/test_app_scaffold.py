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

"""Regression tests for the scaffolded rsbuild config (#2455)."""

import re
import unittest

from rocketride._app_scaffold import TEMPLATE_NAMES, TemplateVars, render_template

VARS = TemplateVars(
    app_id='acme.brandy',
    app_name='Brand Studio',
    publisher='local',
    module_id='acme_brandy',
    port=3101,
    preview_url='http://localhost:5565/?appid=acme.brandy&rrdev=1',
)


class TestScaffoldRsbuildConfig(unittest.TestCase):
    def test_errored_builds_are_never_emitted(self) -> None:
        """An errored build's hot update must never reach the preview.

        It disposes every module only the broken file imported, and the
        next fix-apply then dies silently (the frozen-preview bug).
        """
        for template in TEMPLATE_NAMES:
            files = dict(render_template(template, VARS))
            # Inside tools.rspack: rsbuild ignores a top-level optimization key
            self.assertRegex(
                files['rsbuild.config.mts'],
                re.compile(r'rspack: \{[^}]*optimization: \{ emitOnErrors: false \}'),
                template,
            )
