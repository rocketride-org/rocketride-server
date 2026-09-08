# =============================================================================
# RocketRide Engine
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

"""Pipeline tools: the pipelines opportunities move through, and the lost reasons a closed one can cite."""

from __future__ import annotations

from ..tool_groups import gohighlevel_tool
from ._base import (
    BOOL,
    LIST_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    bool_params,
    params_from,
    passthrough,
    schema,
)

#: Both tools here return their records untouched, which is a deliberate exception to the
#: projection every other read in this node does.
#:
#: A pipeline carries seven declared fields and a lost reason five, so there is nothing to trim
#: for readability. More to the point, the pipeline ``stages`` array is declared
#: ``{"type": "array", "items": {"type": "array"}}`` in the spec and ``any[][]`` in the official
#: SDK, which names no field at all, and no live capture of one exists yet. A projection would
#: therefore have to guess at the stage shape, and the stage id is the single value
#: opportunity_create and opportunity_update need most. Passing the records through cannot drop
#: it.
_PIPELINE_ITEMS = (
    'The pipelines on the sub-account, as GoHighLevel returns them: id, name, the stages array, '
    'showInFunnel, showInPieChart, locationId and colorRenderMode.'
)

_LOST_REASON_ITEMS = 'The lost reasons on the sub-account, as GoHighLevel returns them.'

_NO_NEXT_PAGE = 'Always null: this endpoint answers in one response, so there is no next page.'


class PipelinesMixin(GoHighLevelToolsBase):
    """Tools for the ``pipelines`` group."""

    @gohighlevel_tool(
        group='pipelines',
        input_schema=schema(),
        description=(
            'List the opportunity pipelines on the configured sub-account, each with its stages. Call this '
            'before opportunity_create or opportunity_update: those need a pipelineId, and a pipelineStageId '
            'that belongs to the same pipeline, and this is the only place either id can be found. It is also '
            'what turns the pipelineId and pipelineStageId on an opportunity back into names. Every pipeline '
            'comes back in one response, so there is no cursor. Pipelines are read-only over the API: there is '
            'no way to create, rename or delete one, and no endpoint that returns a single pipeline or its '
            'stages on their own. GoHighLevel publishes no schema for the objects inside the stages array, so '
            'read the ids out of it as they arrive rather than expecting particular field names.'
        ),
        output_schema=LIST_OUTPUT(_NO_NEXT_PAGE, items=_PIPELINE_ITEMS),
    )
    def pipeline_list(self, args):
        args = self._args(args, 'pipeline_list')
        # camelCase here, unlike GET /opportunities/search on the same resource, which takes
        # location_id and rejects this spelling.
        params = {'locationId': self._location()}
        return self._list('/opportunities/pipelines', key='pipelines', cleaner=passthrough, params=params)

    @gohighlevel_tool(
        group='pipelines',
        input_schema=schema(
            name=STR('Return only the lost reason with this exact name.'),
            query=STR('Free-text search across the lost reason names.'),
            deleted=BOOL('Whether to return deleted lost reasons instead of live ones. Defaults to false.'),
        ),
        description=(
            'List the reasons this sub-account records for a lost deal. Call it before marking an opportunity '
            'lost: opportunity_status_update and opportunity_upsert take a lostReasonId, and this is the only '
            'place those ids come from. A sub-account may have none configured, in which case a deal can still '
            'be marked lost without one. The whole list comes back in one response, capped at the 100 '
            'GoHighLevel returns by default, and total reports how many exist when GoHighLevel sends a count.'
        ),
        output_schema=LIST_OUTPUT(_NO_NEXT_PAGE, items=_LOST_REASON_ITEMS),
    )
    def lost_reason_list(self, args):
        args = self._args(args, 'lost_reason_list')
        params = params_from(args, ('name', 'query'))
        params.update(bool_params(args, ('deleted',)))
        params['locationId'] = self._location()
        # The path is singular. /opportunities/lost-reasons does not exist.
        return self._list(
            '/opportunities/lost-reason',
            key='lostReasons',
            cleaner=passthrough,
            params=params,
            total_key='total',
        )
