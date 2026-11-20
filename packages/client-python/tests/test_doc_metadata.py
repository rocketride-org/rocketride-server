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

"""Schema additions the vector store explorer relies on.

* ``DocMetadata(pInstance)`` records ``size`` and ``modifyTime`` from the object
  being processed and ``ingestedAt`` (UTC ISO-8601) as extras, and leaves out a
  value the object does not carry.
* ``DocFilter`` gains ``deleted`` (``'active'|'deleted'|'all'``) and ``minScore``.
* ``str(QuestionText)`` is the question text.

No server is needed: these are plain pydantic models.
"""

import math
import re
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from rocketride.schema import DocFilter, DocMetadata, QuestionText

_ISO_UTC = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')


def _instance(**entry_fields):
    """A stand-in for the pipeline instance DocMetadata(pInstance) reads."""
    entry = SimpleNamespace(objectId='obj-1', path='C:/demo/a.md', permissionId=7, componentId='chunk_1')
    for name, value in entry_fields.items():
        setattr(entry, name, value)
    return SimpleNamespace(
        instance=SimpleNamespace(currentObject=entry),
        IEndpoint=SimpleNamespace(endpoint=SimpleNamespace(jobConfig={'nodeId': 'node-9'})),
    )


# ---------------------------------------------------------------------------
# DocMetadata(pInstance) extras
# ---------------------------------------------------------------------------


def test_defaults_record_size_and_modify_time_from_the_entry():
    meta = DocMetadata(_instance(size=7419, modifyTime=1727000000, hasSize=True, hasModifyTime=True))
    dumped = meta.model_dump()
    assert dumped['size'] == 7419
    assert dumped['modifyTime'] == 1727000000


def test_defaults_record_ingested_at_as_utc_iso8601():
    meta = DocMetadata(_instance())
    assert _ISO_UTC.match(meta.model_dump()['ingestedAt'])


def test_defaults_leave_out_values_the_entry_does_not_carry():
    meta = DocMetadata(_instance())
    dumped = meta.model_dump()
    assert 'size' not in dumped
    assert 'modifyTime' not in dumped


def test_defaults_honour_the_has_flags_of_the_engine_entry():
    meta = DocMetadata(_instance(size=0, modifyTime=0, hasSize=False, hasModifyTime=False))
    dumped = meta.model_dump()
    assert 'size' not in dumped
    assert 'modifyTime' not in dumped


def test_defaults_ignore_non_integer_entry_values():
    meta = DocMetadata(_instance(size='big', modifyTime=None))
    dumped = meta.model_dump()
    assert 'size' not in dumped
    assert 'modifyTime' not in dumped


def test_explicit_overrides_win_over_the_new_defaults():
    meta = DocMetadata(_instance(size=10, hasSize=True), size=99, ingestedAt='2026-10-08T00:00:00Z', chunkId=3)
    dumped = meta.model_dump()
    assert dumped['size'] == 99
    assert dumped['ingestedAt'] == '2026-10-08T00:00:00Z'
    assert dumped['chunkId'] == 3


def test_existing_defaults_are_unchanged():
    meta = DocMetadata(_instance())
    assert meta.objectId == 'obj-1'
    assert meta.chunkId == 0
    assert meta.nodeId == 'node-9'
    assert meta.parent == 'C:/demo/a.md'
    assert meta.permissionId == 7
    assert meta.signature == 'chunk_1'
    assert meta.isDeleted is False
    assert meta.isTable is False
    assert meta.tableId == 0


def test_extras_survive_to_dict_and_round_trip():
    meta = DocMetadata(_instance(size=5, hasSize=True))
    again = DocMetadata(**meta.toDict())
    assert again.model_dump()['size'] == 5
    assert again.model_dump()['ingestedAt'] == meta.model_dump()['ingestedAt']


def test_model_dump_carries_the_ingest_extras_as_extra_keys():
    """size, modifyTime and ingestedAt are the only keys model_dump() adds beyond the declared fields.

    A store driver that turns model_dump() keys into table columns would see them;
    the store base leaves them out of addChunks for drivers that do not store them.
    """
    meta = DocMetadata(_instance(size=5, modifyTime=6, hasSize=True, hasModifyTime=True))
    assert set(meta.model_dump()) - set(DocMetadata.model_fields) == {'size', 'modifyTime', 'ingestedAt'}
    assert set(meta.model_extra) == {'size', 'modifyTime', 'ingestedAt'}


def test_metadata_without_instance_gains_no_extras():
    meta = DocMetadata(objectId='x', chunkId=0)
    dumped = meta.model_dump()
    for key in ('size', 'modifyTime', 'ingestedAt'):
        assert key not in dumped


# ---------------------------------------------------------------------------
# DocFilter.deleted / DocFilter.minScore
# ---------------------------------------------------------------------------


def test_doc_filter_new_fields_default_to_none():
    flt = DocFilter()
    assert flt.deleted is None
    assert flt.minScore is None


@pytest.mark.parametrize('value', ['active', 'deleted', 'all'])
def test_doc_filter_accepts_each_deleted_value(value):
    assert DocFilter(deleted=value).deleted == value


def test_doc_filter_rejects_an_unknown_deleted_value():
    with pytest.raises(ValidationError):
        DocFilter(deleted='purged')


def test_doc_filter_min_score_may_be_minus_infinity():
    flt = DocFilter(minScore=float('-inf'))
    assert math.isinf(flt.minScore) and flt.minScore < 0


def test_doc_filter_keeps_is_deleted_alongside_deleted():
    flt = DocFilter(isDeleted=True, deleted='all')
    assert flt.isDeleted is True
    assert flt.deleted == 'all'


# ---------------------------------------------------------------------------
# QuestionText.__str__
# ---------------------------------------------------------------------------


def test_question_text_str_is_the_text():
    qt = QuestionText(text='where do kestrels nest?', embedding_model='m', embedding=[0.1, 0.2])
    assert str(qt) == 'where do kestrels nest?'
    assert f'%{qt}%' == '%where do kestrels nest?%'
