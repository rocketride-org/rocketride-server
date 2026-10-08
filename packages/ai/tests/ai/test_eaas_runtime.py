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


"""ai.eaas — which runtime tasks get when ``--runtime`` is not given."""

import pytest

from ai.eaas import create_parser, runtime_of


@pytest.mark.parametrize(
    'argv, expected',
    [
        ([], 'spawn'),
        (['--saas'], 'docker'),
        (['--saas', '--runtime=spawn'], 'spawn'),
        (['--runtime=docker'], 'docker'),
        (['--runtime=spawn'], 'spawn'),
    ],
)
def test_runtime_defaults_to_docker_with_saas_and_spawn_without(argv, expected):
    """A hosted engine runs tasks in containers unless told otherwise; any other keeps spawn."""
    assert runtime_of(create_parser().parse_args(argv)) == expected


def test_runtime_refuses_an_unknown_name():
    """--runtime takes only the runtimes that exist."""
    with pytest.raises(SystemExit):
        create_parser().parse_args(['--runtime=k8s'])
