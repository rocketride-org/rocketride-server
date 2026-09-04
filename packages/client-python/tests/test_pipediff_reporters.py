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
Tests for rocketride.pipediff.reporters.

Fixtures are built from the production ``rocketride.pipediff`` model classes, so
a change to the model (a new field, a renamed attribute) surfaces here instead of
being masked by a local mirror that drifts out of sync.

Coverage:
    - empty diff, layout-only diff, and a mixed diff for each renderer
    - human color on/off (ANSI escape presence)
    - control-character escaping in the human renderer
    - JSON document shape and summary contents
    - Markdown table escaping of ``|`` and backticks, and of the title/version
    - viewport enumeration under include_layout
    - deterministic ordering independent of engine emission order
"""

import json
import unittest

from rocketride.pipediff import EdgeChange, FieldChange, NodeChange, PipeDiff
from rocketride.pipediff.reporters import render_human, render_json, render_markdown


def _mixed_diff() -> PipeDiff:
    """Build a representative diff touching every section."""
    return PipeDiff(
        node_changes=[
            NodeChange(id='qdrant_3', kind='added', provider_new='qdrant'),
            NodeChange(id='webhook_1', kind='removed', provider_old='webhook'),
            NodeChange(id='chat_1', kind='provider', provider_old='chat', provider_new='chat_v2'),
            NodeChange(
                id='preprocessor_langchain_1',
                kind='config',
                field_changes=[
                    FieldChange(path='config.default.strlen', kind='changed', old=512, new=1024),
                    FieldChange(path='config.parameters.top_p', kind='added', new=0.9),
                    FieldChange(path='config.mode', kind='removed', old='Source'),
                ],
            ),
        ],
        edge_changes=[
            EdgeChange(from_id='parse_1', lane='text', to_id='preprocessor_langchain_1', kind='added'),
            EdgeChange(from_id='webhook_1', lane='tags', to_id='parse_1', kind='removed'),
        ],
        version_change=(3, 4),
        layout_changed=False,
    )


class TestRenderHuman(unittest.TestCase):
    def test_empty_diff_reports_no_changes(self) -> None:
        self.assertEqual(render_human(PipeDiff(), use_color=False), 'No semantic changes.')

    def test_layout_only_is_not_no_changes(self) -> None:
        out = render_human(PipeDiff(layout_changed=True), use_color=False)
        self.assertNotEqual(out, 'No semantic changes.')
        self.assertIn('Layout', out)

    def test_mixed_sections_present(self) -> None:
        out = render_human(_mixed_diff(), use_color=False)
        self.assertIn('Nodes', out)
        self.assertIn('Edges', out)
        self.assertIn('Config', out)
        # Added / removed / provider-change / config markers.
        self.assertIn('+ qdrant_3 (qdrant)', out)
        self.assertIn('- webhook_1 (webhook)', out)
        self.assertIn('chat_1 provider: chat -> chat_v2', out)
        self.assertIn('+ parse_1 --text--> preprocessor_langchain_1', out)
        self.assertIn('- webhook_1 --tags--> parse_1', out)
        self.assertIn('~ config.default.strlen: 512 -> 1024', out)
        self.assertIn('Version: 3 -> 4', out)

    def test_no_color_has_no_ansi(self) -> None:
        out = render_human(_mixed_diff(), use_color=False)
        self.assertNotIn('\033', out)

    def test_color_emits_ansi(self) -> None:
        out = render_human(_mixed_diff(), use_color=True)
        self.assertIn('\033[', out)

    def test_no_trailing_newline(self) -> None:
        out = render_human(_mixed_diff(), use_color=False)
        self.assertFalse(out.endswith('\n'))

    def test_control_characters_in_values_are_escaped(self) -> None:
        # A .pipe file under review is untrusted input: a config value carrying
        # ANSI escapes could recolor or rewrite the report the reviewer reads.
        diff = PipeDiff(
            node_changes=[
                NodeChange(
                    id='n1\r\nfake line',
                    kind='config',
                    field_changes=[
                        FieldChange(path='config.msg', kind='changed', old='a', new='\x1b[31mred\x1b[0m'),
                    ],
                )
            ]
        )
        out = render_human(diff, use_color=False)
        self.assertNotIn('\x1b', out)
        self.assertNotIn('\r', out)
        self.assertIn('\\x1b', out)
        self.assertIn('\\x0d\\x0afake line', out)

    def test_control_characters_escaped_in_ids_lanes_and_version(self) -> None:
        diff = PipeDiff(
            node_changes=[NodeChange(id='a\x1b[2J', kind='added', provider_new='p\x1b[2J')],
            edge_changes=[EdgeChange(from_id='f\x1b[2J', lane='l\x1b[2J', to_id='t', kind='added')],
            version_change=('1', '2\x1b[2J'),
        )
        out = render_human(diff, use_color=False)
        self.assertNotIn('\x1b', out)
        self.assertIn('\\x1b[2J', out)

    def test_viewport_changes_render_as_layout_block(self) -> None:
        diff = PipeDiff(
            layout_changed=True,
            viewport_changes=[FieldChange(path='viewport.x', kind='changed', old=0, new=120)],
        )
        out = render_human(diff, use_color=False)
        self.assertIn('Layout', out)
        self.assertIn('viewport', out)
        self.assertIn('~ viewport.x: 0 -> 120', out)
        self.assertIn('1 viewport field changed', out)


class TestRenderJson(unittest.TestCase):
    def test_empty_diff_shape(self) -> None:
        doc = render_json(PipeDiff())
        self.assertEqual(set(doc.keys()), {'nodes', 'edges', 'viewport', 'summary'})
        self.assertEqual(set(doc['nodes'].keys()), {'added', 'removed', 'changed'})
        self.assertEqual(set(doc['edges'].keys()), {'added', 'removed'})
        self.assertEqual(doc['nodes']['added'], [])
        self.assertEqual(doc['edges']['removed'], [])
        self.assertEqual(doc['viewport'], [])
        self.assertFalse(doc['summary']['has_semantic_changes'])
        self.assertIsNone(doc['summary']['version_change'])
        self.assertFalse(doc['summary']['layout_changed'])
        self.assertEqual(doc['summary']['viewport_changes'], 0)

    def test_layout_only_summary(self) -> None:
        doc = render_json(PipeDiff(layout_changed=True))
        self.assertTrue(doc['summary']['layout_changed'])
        self.assertFalse(doc['summary']['has_semantic_changes'])

    def test_mixed_structure(self) -> None:
        doc = render_json(_mixed_diff())
        self.assertEqual(doc['nodes']['added'], [{'id': 'qdrant_3', 'provider': 'qdrant'}])
        self.assertEqual(doc['nodes']['removed'], [{'id': 'webhook_1', 'provider': 'webhook'}])

        # Two changed nodes: chat_1 (provider) and preprocessor (config).
        changed_by_id = {entry['id']: entry for entry in doc['nodes']['changed']}
        self.assertEqual(changed_by_id['chat_1']['provider_change'], {'old': 'chat', 'new': 'chat_v2'})
        self.assertEqual(changed_by_id['chat_1']['config_changes'], [])

        preprocessor = changed_by_id['preprocessor_langchain_1']
        self.assertIsNone(preprocessor['provider_change'])
        # config_changes deterministically sorted by (path, kind).
        paths = [fc['path'] for fc in preprocessor['config_changes']]
        self.assertEqual(paths, sorted(paths))
        for fc in preprocessor['config_changes']:
            self.assertEqual(set(fc.keys()), {'path', 'kind', 'old', 'new'})

        self.assertEqual(
            doc['edges']['added'],
            [{'from': 'parse_1', 'lane': 'text', 'to': 'preprocessor_langchain_1'}],
        )
        self.assertEqual(
            doc['edges']['removed'],
            [{'from': 'webhook_1', 'lane': 'tags', 'to': 'parse_1'}],
        )

        summary = doc['summary']
        self.assertEqual(summary['nodes_added'], 1)
        self.assertEqual(summary['nodes_removed'], 1)
        self.assertEqual(summary['nodes_changed'], 2)
        self.assertEqual(summary['edges_added'], 1)
        self.assertEqual(summary['edges_removed'], 1)
        self.assertEqual(summary['config_changes'], 3)
        self.assertEqual(summary['provider_changes'], 1)
        self.assertEqual(summary['version_change'], [3, 4])
        self.assertTrue(summary['has_semantic_changes'])

    def test_provider_and_config_on_same_id_merge(self) -> None:
        # Engine may emit provider + config as separate NodeChange records for the
        # same id; they must collapse into a single 'changed' entry.
        diff = PipeDiff(
            node_changes=[
                NodeChange(id='n1', kind='provider', provider_old='a', provider_new='b'),
                NodeChange(
                    id='n1',
                    kind='config',
                    field_changes=[FieldChange(path='config.x', kind='changed', old=1, new=2)],
                ),
            ]
        )
        doc = render_json(diff)
        self.assertEqual(len(doc['nodes']['changed']), 1)
        entry = doc['nodes']['changed'][0]
        self.assertEqual(entry['provider_change'], {'old': 'a', 'new': 'b'})
        self.assertEqual(len(entry['config_changes']), 1)

    def test_viewport_changes_are_enumerated_and_counted(self) -> None:
        diff = PipeDiff(
            layout_changed=True,
            viewport_changes=[
                FieldChange(path='viewport.zoom', kind='changed', old=1, new=2),
                FieldChange(path='viewport.x', kind='changed', old=0, new=120),
            ],
        )
        doc = render_json(diff)
        self.assertEqual([fc['path'] for fc in doc['viewport']], ['viewport.x', 'viewport.zoom'])
        self.assertEqual(doc['summary']['viewport_changes'], 2)
        self.assertTrue(doc['summary']['has_semantic_changes'])

    def test_json_serializable(self) -> None:
        # The document must round-trip through the json module unchanged.
        doc = render_json(_mixed_diff())
        self.assertEqual(json.loads(json.dumps(doc)), doc)


class TestRenderMarkdown(unittest.TestCase):
    def test_empty_diff_summary(self) -> None:
        out = render_markdown(PipeDiff())
        self.assertIn('no semantic changes', out)
        self.assertNotIn('**Nodes**', out)
        self.assertNotIn('**Edges**', out)

    def test_title_heading(self) -> None:
        out = render_markdown(PipeDiff(), title='pipeline.pipe')
        self.assertTrue(out.startswith('## `pipeline.pipe`'))

    def test_title_with_newline_cannot_inject_markdown(self) -> None:
        # The action passes a repository file path as the title; a path is
        # attacker-controlled content in a fork PR.
        out = render_markdown(PipeDiff(), title='a.pipe\n\n## INJECTED\n\n@everyone')
        for line in out.splitlines():
            self.assertFalse(line.lstrip().startswith('## INJECTED'), line)
            self.assertFalse(line.lstrip().startswith('@everyone'), line)

    def test_version_in_summary_line_is_code_spanned(self) -> None:
        # The summary line interpolates the two `version` values; in Markdown they
        # must be code-spanned or a crafted version breaks out of the comment.
        out = render_markdown(PipeDiff(version_change=('1', '2`\n\n# pwned')))
        summary_line = out.splitlines()[0]
        self.assertIn('**Pipeline diff:**', summary_line)
        self.assertNotIn('\n\n#', out)
        for line in out.splitlines():
            self.assertFalse(line.lstrip().startswith('# pwned'), line)

    def test_viewport_changes_render_as_layout_table(self) -> None:
        diff = PipeDiff(
            layout_changed=True,
            viewport_changes=[FieldChange(path='viewport.x', kind='changed', old=0, new=120)],
        )
        out = render_markdown(diff)
        self.assertIn('**Layout**', out)
        self.assertIn('| Field | Change |', out)
        self.assertIn('`viewport.x`', out)

    def test_mixed_sections(self) -> None:
        out = render_markdown(_mixed_diff())
        self.assertIn('**Pipeline diff:**', out)
        self.assertIn('**Nodes**', out)
        self.assertIn('**Edges**', out)
        self.assertIn('**Config**', out)
        self.assertIn('| Node | Field | Change |', out)
        self.assertIn('`qdrant_3`', out)
        self.assertIn('**Version:**', out)

    def test_layout_only(self) -> None:
        out = render_markdown(PipeDiff(layout_changed=True))
        self.assertIn('Layout', out)

    def test_newlines_in_untrusted_values_cannot_break_out(self) -> None:
        # A .pipe file is untrusted PR content, and render_markdown output is
        # dumped verbatim into an auto-posted sticky PR comment. A newline in a
        # provider/lane/id/config value must not terminate its code span and let
        # the trailing text render as real Markdown (headings, @-mentions, etc.).
        payload = 'x\n\n## INJECTED HEADING\n\n@everyone please approve'
        diff = PipeDiff(
            node_changes=[
                NodeChange(id='n1', kind='added', provider_new=payload),
                NodeChange(
                    id='n2\n\n### id-inject',
                    kind='config',
                    field_changes=[
                        FieldChange(path='config.p\n\n### path-inject', kind='changed', old='a\r\nb', new=payload),
                    ],
                ),
            ],
            edge_changes=[
                EdgeChange(from_id='a', lane='l\n\n### lane-inject', to_id='b', kind='added'),
            ],
        )
        out = render_markdown(diff, title='rag.pipe')
        # The injected content must never break out of its code span onto its own
        # line — that is what would make '## INJECTED HEADING' render as a real
        # heading. Every injected marker must survive only inline inside a span,
        # never at the start of a line, and no attacker-introduced blank line may
        # appear before a heading.
        self.assertNotIn('\n\n#', out)
        for line in out.splitlines():
            self.assertFalse(line.lstrip().startswith('## INJECTED'), line)
            self.assertFalse(line.lstrip().startswith('### '), line)
            self.assertFalse(line.lstrip().startswith('@everyone'), line)
        # Carriage returns are neutralized too (a lone \r can also break rows).
        self.assertNotIn('\r', out)

    def test_table_escapes_pipe_and_backtick(self) -> None:
        diff = PipeDiff(
            node_changes=[
                NodeChange(
                    id='n1',
                    kind='config',
                    field_changes=[
                        FieldChange(path='config.template', kind='changed', old='a|b', new='x`y'),
                    ],
                )
            ]
        )
        out = render_markdown(diff)
        # The literal pipe from the value must be escaped inside the table cell.
        self.assertIn('\\|', out)
        self.assertNotIn('a|b', out)
        # A backtick inside a value forces a longer code fence.
        self.assertIn('``', out)
        # Every table body row must have balanced, escaped columns (no stray bar).
        table_rows = [ln for ln in out.splitlines() if ln.startswith('| ') and '---' not in ln]
        for row in table_rows:
            # Unescaped pipes only appear as the 4 column delimiters.
            unescaped = row.replace('\\|', '')
            self.assertEqual(unescaped.count('|'), 4, row)


class TestDeterminism(unittest.TestCase):
    def _scrambled_diff(self) -> PipeDiff:
        """Same logical changes as _mixed_diff but emitted in a different order."""
        return PipeDiff(
            node_changes=[
                NodeChange(
                    id='preprocessor_langchain_1',
                    kind='config',
                    field_changes=[
                        FieldChange(path='config.mode', kind='removed', old='Source'),
                        FieldChange(path='config.parameters.top_p', kind='added', new=0.9),
                        FieldChange(path='config.default.strlen', kind='changed', old=512, new=1024),
                    ],
                ),
                NodeChange(id='chat_1', kind='provider', provider_old='chat', provider_new='chat_v2'),
                NodeChange(id='webhook_1', kind='removed', provider_old='webhook'),
                NodeChange(id='qdrant_3', kind='added', provider_new='qdrant'),
            ],
            edge_changes=[
                EdgeChange(from_id='webhook_1', lane='tags', to_id='parse_1', kind='removed'),
                EdgeChange(from_id='parse_1', lane='text', to_id='preprocessor_langchain_1', kind='added'),
            ],
            version_change=(3, 4),
            layout_changed=False,
        )

    def test_human_is_order_independent(self) -> None:
        self.assertEqual(
            render_human(_mixed_diff(), use_color=False),
            render_human(self._scrambled_diff(), use_color=False),
        )

    def test_json_is_order_independent(self) -> None:
        self.assertEqual(render_json(_mixed_diff()), render_json(self._scrambled_diff()))

    def test_markdown_is_order_independent(self) -> None:
        self.assertEqual(render_markdown(_mixed_diff()), render_markdown(self._scrambled_diff()))


if __name__ == '__main__':
    unittest.main()
