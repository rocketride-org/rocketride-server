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
Text formats and option checks of ``rocketride profile``.

The format fixtures and expected lines are copied verbatim in the TypeScript
suite (client-typescript/tests/cli-profile-format.test.ts): both CLIs must
print the same text, so a change to either format has to change both.
"""

import asyncio
import signal

import pytest

from rocketride.cli.commands.profile import (
    _wait_for_stop,
    format_profile_list,
    format_threads,
    format_tree,
    run_profile,
)
from rocketride.cli.main import setup_parser

THREADS = [
    {'id': 3, 'name': 'MainThread', 'tid': 8812, 'ttot': 10.1234, 'sched_count': 5, 'functions': 10, 'calls': 100},
    {
        'id': 12,
        'name': 'ThreadPoolExecutor-0_0',
        'tid': 140234567890,
        'ttot': 5.0,
        'sched_count': 9,
        'functions': 4,
        'calls': 40,
    },
    {'id': 0, 'name': None, 'tid': 77, 'ttot': 0.0, 'sched_count': 1, 'functions': 0, 'calls': 0},
]


def leaf(name, file, line, ncalls, tottime, cumtime):
    return {
        'name': name,
        'file': file,
        'line': line,
        'ncalls': ncalls,
        'tottime': tottime,
        'cumtime': cumtime,
        'children': [],
    }


TREE = {
    'tree': {
        'name': '<root>',
        'file': '',
        'line': 0,
        'ncalls': 1234,
        'tottime': 0.0,
        'cumtime': 12.5,
        'children': [
            {
                'name': 'run',
                'file': 'ai/eaas.py',
                'line': 120,
                'ncalls': 1,
                'tottime': 0.001,
                'cumtime': 10.0,
                'children': [
                    {
                        'name': 'process',
                        'file': 'nodes/parse/parse.py',
                        'line': 88,
                        'ncalls': 1234,
                        'tottime': 0.25,
                        'cumtime': 8.75,
                        'children': [
                            leaf('extract', 'nodes/parse/extract.py', 40, 12, 7.5, 7.5),
                            leaf('process [cycle]', 'nodes/parse/parse.py', 88, 2, 0.0, 0.5),
                        ],
                    },
                    leaf("<method 'acquire' of '_thread.lock' objects>", '~', 0, 3, 1.0, 1.0),
                ],
            },
            leaf('idle', '', 0, 5, 2.5, 2.5),
        ],
    },
    'total_time': 12.5,
    'total_calls': 1234,
}


class TestThreadsFormat:
    def test_prints_an_aligned_table_with_each_threads_share_of_the_total(self):
        assert format_threads(THREADS) == [
            'ID  NAME                             TID     TIME  SHARE',
            ' 3  MainThread                      8812  10.123s  66.9%',
            '12  ThreadPoolExecutor-0_0  140234567890   5.000s  33.1%',
            ' 0  -                                 77   0.000s   0.0%',
            '3 thread(s), 15.123s total',
        ]

    def test_says_so_when_no_thread_was_recorded(self):
        assert format_threads([]) == ['No threads recorded']


class TestTreeFormat:
    def test_draws_the_tree_under_the_root_totals_without_the_root_itself(self):
        assert format_tree(TREE) == [
            'Call tree, all threads: 12.500s, 1,234 calls',
            '',
            '  CUM%     CUMTIME     TOTTIME      NCALLS  FUNCTION',
            ' 80.0%     10.000s      0.001s           1  run  (ai/eaas.py:120)',
            ' 70.0%      8.750s      0.250s       1,234  +-- process  (nodes/parse/parse.py:88)',
            ' 60.0%      7.500s      7.500s          12  |   +-- extract  (nodes/parse/extract.py:40)',
            '  4.0%      0.500s      0.000s           2  |   `-- process [cycle]  (nodes/parse/parse.py:88)',
            "  8.0%      1.000s      1.000s           3  `-- <method 'acquire' of '_thread.lock' objects>  (~)",
            ' 20.0%      2.500s      2.500s           5  idle',
        ]

    def test_names_the_thread_the_tree_was_built_for(self):
        assert format_tree(TREE, 3)[0] == 'Call tree, thread 3: 12.500s, 1,234 calls'

    def test_says_so_when_the_tree_has_no_calls(self):
        result = {'tree': None, 'total_time': 0, 'total_calls': 0}

        assert format_tree(result) == ['Call tree, all threads: 0.000s, 0 calls', 'No calls to show']

    def test_prints_no_share_when_the_total_time_is_zero(self):
        root = {'name': '<root>', 'file': '', 'line': 0, 'ncalls': 1, 'tottime': 0.0, 'cumtime': 0.0}
        result = {'tree': {**root, 'children': [leaf('f', 'a.py', 1, 1, 0.0, 0.0)]}, 'total_time': 0, 'total_calls': 1}

        assert format_tree(result)[3] == '     -      0.000s      0.000s           1  f  (a.py:1)'


PROCESSES = [
    {
        'token': None,
        'name': None,
        'status': {'active': False, 'owner': None, 'session': None, 'runtime': None, 'has_report': True},
    },
    {
        'token': 'PROFILE-DEMO',
        'name': 'webhook_1',
        'status': {'active': True, 'owner': 'data:1503252257136', 'session': 'session_1789717993', 'runtime': 46.3241},
    },
    {
        'token': 'DEMO-B',
        'name': 'ingest',
        'status': {'active': False, 'owner': None, 'session': None, 'runtime': None, 'has_report': False},
    },
    {'token': 'DEMO-C', 'name': 'webhook_1', 'error': 'no answer within 10s'},
]


class TestProfileListFormat:
    def test_lists_every_process_then_the_ones_it_could_not_read(self):
        assert format_profile_list(PROCESSES) == [
            'TOKEN         NAME       STATE     RUNNING  REPORT  SESSION',
            '(server)      -          inactive        -  yes     -',
            'PROFILE-DEMO  webhook_1  active    46.324s  -       session_1789717993',
            'DEMO-B        ingest     inactive        -  no      -',
            'DEMO-C: no answer within 10s',
            '4 process(es), 1 profiling, 1 unreadable',
        ]

    def test_keeps_only_the_processes_being_profiled_when_asked(self):
        assert format_profile_list(PROCESSES, True) == [
            'TOKEN         NAME       STATE   RUNNING  REPORT  SESSION',
            'PROFILE-DEMO  webhook_1  active  46.324s  -       session_1789717993',
            'DEMO-C: no answer within 10s',
            '4 process(es), 1 profiling, 1 unreadable',
        ]

    def test_says_so_when_nothing_is_being_profiled(self):
        assert format_profile_list(PROCESSES[:1], True) == [
            'No active profiling sessions',
            '1 process(es), 0 profiling',
        ]


class TestRunWaiting:
    @pytest.mark.asyncio
    async def test_ends_the_wait_on_the_first_ctrl_c_and_restores_the_usual_handling(self):
        before = signal.getsignal(signal.SIGINT)
        # Without the wait's own handler this raises KeyboardInterrupt instead
        asyncio.get_running_loop().call_later(0.1, signal.raise_signal, signal.SIGINT)

        await asyncio.wait_for(_wait_for_stop(None), 10)

        assert signal.getsignal(signal.SIGINT) is before

    @pytest.mark.asyncio
    async def test_ends_the_wait_after_the_duration_and_restores_the_usual_handling(self):
        before = signal.getsignal(signal.SIGINT)

        await _wait_for_stop(0.05)

        assert signal.getsignal(signal.SIGINT) is before


class TestOptionChecks:
    """Bad options are refused before connecting, with the TypeScript CLI's messages and exit code."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        'argv, message',
        [
            (['start'], 'profile start needs --token'),
            (['stop'], 'profile stop needs --token'),
            (['run', '--duration', '0'], '--duration must be a positive number of seconds'),
            (['run', '--duration', '1e3'], '--duration must be a positive number of seconds'),
            # Digits alone are not a number: this many overflow to infinity
            (['run', '--duration', '9' * 400], '--duration must be a positive number of seconds'),
            (['tree', '--thread', 'main'], "--thread must be a thread id from 'rocketride profile threads'"),
            (['tree', '--thread', '-1'], "--thread must be a thread id from 'rocketride profile threads'"),
            (['tree', '--min-pct', 'abc'], '--min-pct must be a number from 0 to 100'),
            (['tree', '--min-pct', '100.5'], '--min-pct must be a number from 0 to 100'),
            (['tree', '--max-depth', '0'], '--max-depth must be a positive integer'),
            (['tree', '--max-depth', '2.5'], '--max-depth must be a positive integer'),
            # Past 2^53 the TypeScript CLI cannot hold the digits; both refuse it
            (['tree', '--max-depth', '9007199254740993'], '--max-depth must be a positive integer'),
            (
                ['tree', '--thread', '9007199254740993'],
                "--thread must be a thread id from 'rocketride profile threads'",
            ),
        ],
    )
    async def test_refuses_a_bad_option_without_connecting(self, argv, message, capsys):
        # Nothing listens on port 9: a connection attempt would fail with a different message
        args = setup_parser().parse_args(['profile', *argv, '--uri', 'http://127.0.0.1:9'])

        assert await run_profile(args) == 1
        assert message in capsys.readouterr().err
