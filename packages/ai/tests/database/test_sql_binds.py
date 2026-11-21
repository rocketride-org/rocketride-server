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

"""Tests for ``sql_binds``: the ``$n`` placeholder rewrite and the result shape of the raw ``execute`` path.

Both helpers are pure; the transaction that runs a statement is opened and
closed by the caller inside one tool call (plan 4.1 rule 3).
"""

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from ai.common.database.sql_binds import shape_execute_result, to_sqlalchemy_text


def _engine_shared():
    """In-memory SQLite engine whose one connection every thread shares."""
    e = create_engine(
        'sqlite://',
        connect_args={'check_same_thread': False},
        poolclass=StaticPool,
    )
    with e.begin() as c:
        c.execute(text('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'))
    return e


def test_to_sqlalchemy_text_maps_placeholders():
    clause, binds = to_sqlalchemy_text('INSERT INTO t (a,b) VALUES ($1,$2)', ['p', 7])
    assert binds == {'b1': 'p', 'b2': 7}
    assert ':b1' in str(clause) and ':b2' in str(clause)

    # Multi-digit placeholders ($1..$11) must each map to their own bind and not
    # collapse $1 into $10/$11 (greedy \\d+ handles this — regression guard).
    params = list(range(1, 12))  # 11 values -> $1..$11
    cols = ', '.join(f'c{i}' for i in range(1, 12))
    vals = ', '.join(f'${i}' for i in range(1, 12))
    clause2, binds2 = to_sqlalchemy_text(f'INSERT INTO t ({cols}) VALUES ({vals})', params)
    assert binds2 == {f'b{i}': i for i in range(1, 12)}
    rendered = str(clause2)
    for i in range(1, 12):
        assert f':b{i}' in rendered
    # $1 keeps value 1; $10/$11 are distinct binds, not swallowed.
    assert binds2['b1'] == 1 and binds2['b10'] == 10 and binds2['b11'] == 11


@pytest.mark.parametrize(
    'sql,params,expected_sql,expected_binds',
    [
        ('select $1', [5], 'select :b1', {'b1': 5}),
        (
            "update t set note = 'costs $1 per unit' where id = $1",
            [7],
            "update t set note = 'costs $1 per unit' where id = :b1",
            {'b1': 7},
        ),
        ("select 'it''s $1' , $1", [3], "select 'it''s $1' , :b1", {'b1': 3}),
        ('select $$body $1$$, $1', [2], 'select $$body $1$$, :b1', {'b1': 2}),
        ('select $tag$x $1$tag$, $1', [2], 'select $tag$x $1$tag$, :b1', {'b1': 2}),
        ('select $1 -- not $2\n', [1], 'select :b1 -- not $2\n', {'b1': 1}),
        ('select /* $2 /* $3 */ */ $1', [1], 'select /* $2 /* $3 */ */ :b1', {'b1': 1}),
        ('select "col$1", $1', [4], 'select "col$1", :b1', {'b1': 4}),
        ("select E'\\' $1' , $1", [9], "select E'\\' $1' , :b1", {'b1': 9}),
    ],
)
def test_placeholder_rewrite_skips_quoted_regions(sql, params, expected_sql, expected_binds):
    clause, binds = to_sqlalchemy_text(sql, params)
    assert str(clause) == str(text(expected_sql)) or clause.text == expected_sql
    assert binds == expected_binds


def test_placeholder_out_of_range_raises():
    with pytest.raises(ValueError, match=r'\$3'):
        to_sqlalchemy_text('select $3', [1])


def _engine_with_rows():
    e = _engine_shared()
    with e.begin() as c:
        c.execute(text("INSERT INTO t (id, v) VALUES (1, 'x'), (2, 'y')"))
    return e


def test_shape_execute_result_array_mode():
    engine = _engine_with_rows()
    with engine.connect() as conn:
        result = conn.execute(text('SELECT id, v FROM t ORDER BY id'))
        shaped = shape_execute_result(result, 10, row_mode='array')
    assert shaped == {'rows': [[1, 'x'], [2, 'y']], 'affected_rows': 0}


def test_shape_execute_result_default_stays_object():
    engine = _engine_with_rows()
    with engine.connect() as conn:
        result = conn.execute(text('SELECT id, v FROM t ORDER BY id'))
        shaped = shape_execute_result(result, 10)
    assert shaped == {'rows': [{'id': 1, 'v': 'x'}, {'id': 2, 'v': 'y'}], 'affected_rows': 0}
