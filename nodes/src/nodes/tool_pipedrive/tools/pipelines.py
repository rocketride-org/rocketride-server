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

"""Pipeline and stage tools, including the conversion and movement reports."""

from __future__ import annotations

from ..pipedrive_client import clean_deal, clean_pipeline, clean_stage
from ..tool_groups import pipedrive_tool
from ._base import (
    ARR,
    BOOL,
    INT,
    NUM,
    PAGING,
    STR,
    PipedriveToolsBase,
    args_of,
    body_from,
    params_from,
    require_id,
    require_text,
    schema,
)


class PipelinesMixin(PipedriveToolsBase):
    """Tools for the ``pipelines`` and ``stages`` groups."""

    # -- pipelines --------------------------------------------------------

    @pipedrive_tool(
        group='pipelines',
        input_schema=schema(),
        description='List all pipelines. Start here to find the pipeline_id and stage layout of the account.',
    )
    def pipeline_list(self, args):
        args_of(args)
        data = self._call('GET', '/pipelines')
        return {'items': [clean_pipeline(p) for p in (data or [])]}

    @pipedrive_tool(
        group='pipelines',
        input_schema=schema(
            required=['pipeline_id'],
            pipeline_id=INT('Pipeline id.'),
            totals_convert_currency=STR('Convert deal totals to this 3-letter currency code, or "default_currency".'),
        ),
        description='Get a single pipeline, including per-stage deal totals.',
    )
    def pipeline_get(self, args):
        args = args_of(args)
        pipeline_id = require_id(args, 'pipeline_id', 'pipeline_get')
        return self._get(
            f'/pipelines/{pipeline_id}', clean_pipeline, params=params_from(args, ('totals_convert_currency',))
        )

    @pipedrive_tool(
        group='pipelines',
        input_schema=schema(
            required=['name'],
            name=STR('Pipeline name.'),
            deal_probability=BOOL('Whether deal probability is enabled for this pipeline.'),
            order_nr=INT('Display position of the pipeline.'),
            active=BOOL('Whether the pipeline is active.'),
        ),
        description='Create a pipeline.',
    )
    def pipeline_create(self, args):
        args = args_of(args)
        require_text(args, 'name', 'pipeline_create')
        return self._write(
            'POST',
            '/pipelines',
            clean_pipeline,
            body=body_from(args, ('name', 'deal_probability', 'order_nr', 'active')),
        )

    @pipedrive_tool(
        group='pipelines',
        input_schema=schema(
            required=['pipeline_id'],
            pipeline_id=INT('Pipeline id to update.'),
            name=STR('New pipeline name.'),
            deal_probability=BOOL('Whether deal probability is enabled.'),
            order_nr=INT('New display position.'),
            active=BOOL('Whether the pipeline is active.'),
        ),
        description='Update a pipeline.',
    )
    def pipeline_update(self, args):
        args = args_of(args)
        pipeline_id = require_id(args, 'pipeline_id', 'pipeline_update')
        return self._write(
            'PUT',
            f'/pipelines/{pipeline_id}',
            clean_pipeline,
            body=body_from(args, ('name', 'deal_probability', 'order_nr', 'active')),
        )

    @pipedrive_tool(
        group='pipelines',
        input_schema=schema(required=['pipeline_id'], pipeline_id=INT('Pipeline id to delete.')),
        description='Delete a pipeline.',
    )
    def pipeline_delete(self, args):
        args = args_of(args)
        return self._delete(f'/pipelines/{require_id(args, "pipeline_id", "pipeline_delete")}')

    @pipedrive_tool(
        group='pipelines',
        input_schema=schema(
            required=['pipeline_id'],
            pipeline_id=INT('Pipeline id.'),
            filter_id=INT('Apply a saved filter by id.'),
            user_id=INT('Only deals owned by this user id.'),
            stage_id=INT('Only deals in this stage.'),
            everyone=INT('Set to 1 to include deals owned by everyone, not just the authenticated user.'),
            get_summary=INT('Set to 1 to include per-stage summary totals.'),
            totals_convert_currency=STR('Convert totals to this 3-letter currency code, or "default_currency".'),
            **PAGING(),
        ),
        description='List deals in a pipeline.',
    )
    def pipeline_deals_list(self, args):
        args = args_of(args)
        pipeline_id = require_id(args, 'pipeline_id', 'pipeline_deals_list')
        return self._list(
            f'/pipelines/{pipeline_id}/deals',
            args,
            clean_deal,
            extra=params_from(
                args, ('filter_id', 'user_id', 'stage_id', 'everyone', 'get_summary', 'totals_convert_currency')
            ),
        )

    @pipedrive_tool(
        group='pipelines',
        input_schema=schema(
            required=['pipeline_id', 'start_date', 'end_date'],
            pipeline_id=INT('Pipeline id.'),
            start_date=STR('Period start, YYYY-MM-DD.'),
            end_date=STR('Period end, YYYY-MM-DD.'),
            user_id=INT('Only deals owned by this user id.'),
        ),
        description='Get stage-to-stage conversion rates and win/lost rates for a pipeline over a date range.',
    )
    def pipeline_conversion_stats(self, args):
        args = args_of(args)
        pipeline_id = require_id(args, 'pipeline_id', 'pipeline_conversion_stats')
        params = {
            'start_date': require_text(args, 'start_date', 'pipeline_conversion_stats'),
            'end_date': require_text(args, 'end_date', 'pipeline_conversion_stats'),
        }
        params.update(params_from(args, ('user_id',)))
        return self._call('GET', f'/pipelines/{pipeline_id}/conversion_statistics', params=params)

    @pipedrive_tool(
        group='pipelines',
        input_schema=schema(
            required=['pipeline_id', 'start_date', 'end_date'],
            pipeline_id=INT('Pipeline id.'),
            start_date=STR('Period start, YYYY-MM-DD.'),
            end_date=STR('Period end, YYYY-MM-DD.'),
            user_id=INT('Only deals owned by this user id.'),
        ),
        description='Get how deals moved into, through and out of each stage of a pipeline over a date range.',
    )
    def pipeline_movement_stats(self, args):
        args = args_of(args)
        pipeline_id = require_id(args, 'pipeline_id', 'pipeline_movement_stats')
        params = {
            'start_date': require_text(args, 'start_date', 'pipeline_movement_stats'),
            'end_date': require_text(args, 'end_date', 'pipeline_movement_stats'),
        }
        params.update(params_from(args, ('user_id',)))
        return self._call('GET', f'/pipelines/{pipeline_id}/movement_statistics', params=params)

    # -- stages -----------------------------------------------------------

    @pipedrive_tool(
        group='stages',
        input_schema=schema(pipeline_id=INT('Only stages of this pipeline.'), **PAGING()),
        description='List stages, optionally restricted to a single pipeline.',
    )
    def stage_list(self, args):
        args = args_of(args)
        return self._list('/stages', args, clean_stage, extra=params_from(args, ('pipeline_id',)))

    @pipedrive_tool(
        group='stages',
        input_schema=schema(
            required=['stage_id'],
            stage_id=INT('Stage id.'),
            everyone=INT('Set to 1 to include deal counts for all users.'),
        ),
        description='Get a single stage.',
    )
    def stage_get(self, args):
        args = args_of(args)
        stage_id = require_id(args, 'stage_id', 'stage_get')
        return self._get(f'/stages/{stage_id}', clean_stage, params=params_from(args, ('everyone',)))

    @pipedrive_tool(
        group='stages',
        input_schema=schema(
            required=['name', 'pipeline_id'],
            name=STR('Stage name.'),
            pipeline_id=INT('Pipeline the stage belongs to.'),
            deal_probability=NUM('Success probability percentage for deals in this stage.'),
            rotten_flag=BOOL('Whether deals in this stage can go rotten.'),
            rotten_days=INT('Days of inactivity before a deal is marked rotten.'),
            order_nr=INT('Display position of the stage in the pipeline.'),
        ),
        description='Create a stage in a pipeline.',
    )
    def stage_create(self, args):
        args = args_of(args)
        require_text(args, 'name', 'stage_create')
        require_id(args, 'pipeline_id', 'stage_create')
        body = body_from(args, ('name', 'pipeline_id', 'deal_probability', 'rotten_flag', 'rotten_days', 'order_nr'))
        return self._write('POST', '/stages', clean_stage, body=body)

    @pipedrive_tool(
        group='stages',
        input_schema=schema(
            required=['stage_id'],
            stage_id=INT('Stage id to update.'),
            name=STR('New stage name.'),
            pipeline_id=INT('Move the stage to this pipeline.'),
            deal_probability=NUM('New success probability percentage.'),
            rotten_flag=BOOL('Whether deals in this stage can go rotten.'),
            rotten_days=INT('Days of inactivity before a deal is marked rotten.'),
            order_nr=INT('New display position.'),
        ),
        description='Update a stage.',
    )
    def stage_update(self, args):
        args = args_of(args)
        stage_id = require_id(args, 'stage_id', 'stage_update')
        body = body_from(args, ('name', 'pipeline_id', 'deal_probability', 'rotten_flag', 'rotten_days', 'order_nr'))
        return self._write('PUT', f'/stages/{stage_id}', clean_stage, body=body)

    @pipedrive_tool(
        group='stages',
        input_schema=schema(required=['stage_id'], stage_id=INT('Stage id to delete.')),
        description='Delete a stage.',
    )
    def stage_delete(self, args):
        args = args_of(args)
        return self._delete(f'/stages/{require_id(args, "stage_id", "stage_delete")}')

    @pipedrive_tool(
        group='stages',
        input_schema=schema(required=['ids'], ids=ARR('Stage ids to delete.', 'integer')),
        description='Delete multiple stages in one call.',
    )
    def stage_delete_bulk(self, args):
        return self._delete_bulk('/stages', args_of(args), 'stage_delete_bulk')

    @pipedrive_tool(
        group='stages',
        input_schema=schema(
            required=['stage_id'],
            stage_id=INT('Stage id.'),
            filter_id=INT('Apply a saved filter by id.'),
            user_id=INT('Only deals owned by this user id.'),
            everyone=INT('Set to 1 to include deals owned by everyone.'),
            **PAGING(),
        ),
        description='List deals sitting in a stage.',
    )
    def stage_deals_list(self, args):
        args = args_of(args)
        stage_id = require_id(args, 'stage_id', 'stage_deals_list')
        return self._list(
            f'/stages/{stage_id}/deals', args, clean_deal, extra=params_from(args, ('filter_id', 'user_id', 'everyone'))
        )
