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

"""Tests for the bound per-app reporters (:mod:`rocketride.analytics`)."""

from rocketride.analytics import create_reporter


def test_stamps_bound_app_id_on_every_event():
    seen = []
    report = create_reporter('test-app', lambda event, props, options: seen.append((event, props)))
    report('pipeline:run', {'node_count': 4})
    assert seen == [('pipeline:run', {'app': 'test-app', 'node_count': 4})]


def test_two_reporters_stamp_independently():
    seen = []
    sink = lambda event, props, options: seen.append(props)  # noqa: E731
    home_report = create_reporter('home-ui', sink)
    sql_report = create_reporter('sql-ui', sink)
    # sql-ui is the active app; a straggling home-ui caller fires late.
    sql_report('query:run')
    home_report('page:engagement')
    assert seen == [{'app': 'sql-ui'}, {'app': 'home-ui'}]


def test_accepts_any_string_event_name():
    seen = []
    report = create_reporter('test-app', lambda event, props, options: seen.append(event))
    report('made:up_on_the_spot')
    assert seen == ['made:up_on_the_spot']


def test_caller_props_cannot_overwrite_app_stamp():
    seen = []
    report = create_reporter('test-app', lambda event, props, options: seen.append(props))
    report('store:app_view', {'app': 'spoofed', 'app_id': 'some.catalog.app'})
    assert seen == [{'app': 'test-app', 'app_id': 'some.catalog.app'}]


def test_passes_options_through_untouched():
    seen = []
    report = create_reporter('test-app', lambda event, props, options: seen.append(options))
    report('cta:click', {'intent': 'register'}, {'transport': 'sendBeacon', 'uuid': 'fact-1a2b'})
    report('nav:click')
    assert seen == [{'transport': 'sendBeacon', 'uuid': 'fact-1a2b'}, None]


def test_drops_non_string_and_empty_event_names():
    seen = []
    report = create_reporter('test-app', lambda event, props, options: seen.append(event))
    report('')
    report(42)  # type: ignore[arg-type]
    assert seen == []


def test_never_raises_even_when_sink_does():
    def exploding_sink(event, props, options):
        raise RuntimeError('sink exploded')

    report = create_reporter('test-app', exploding_sink)
    report('pipeline:run')  # must not raise
