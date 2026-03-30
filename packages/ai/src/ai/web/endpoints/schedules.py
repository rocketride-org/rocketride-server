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

# NOTE: These endpoints are protected by AuthMiddleware which checks
# all non-public routes. Do NOT register these as public routes.

import logging

from ai.web import Body, Request, Result, error, exception, response
from ai.web.scheduler.models import ScheduleCreate, ScheduleList

logger = logging.getLogger(__name__)


def _get_scheduler(request: Request):
    """Retrieve the PipelineScheduler from app state, or None if not initialised."""
    return getattr(request.app.state, 'scheduler', None)


async def create_schedule(request: Request, body: ScheduleCreate = Body(..., description='Schedule definition.')) -> Result:
    """
    Create Schedule Endpoint.

    Creates a new scheduled pipeline execution using a cron expression.

    Args:
        request: The incoming HTTP request.
        body: Schedule creation payload.

    Returns:
        Result: The newly created schedule details.
    """
    try:
        scheduler = _get_scheduler(request)
        if scheduler is None:
            return error(message='Scheduler is not initialised', httpStatus=503)

        schedule_id = scheduler.add_schedule(
            pipeline_id=body.pipeline_id,
            cron_expression=body.cron_expression,
            input_data=body.input_data,
            name=body.name,
        )

        if not body.enabled:
            scheduler.pause_schedule(schedule_id)

        schedule = scheduler.get_schedule(schedule_id)
        if schedule is None:
            return error(message='Failed to retrieve created schedule', httpStatus=500)

        return response(data=schedule.model_dump(mode='json'), httpStatus=201)

    except ValueError as ve:
        return error(message=str(ve), httpStatus=400)
    except Exception as e:
        return exception(e)


async def list_schedules(request: Request) -> Result:
    """
    List Schedules Endpoint.

    Returns all registered pipeline schedules.

    Args:
        request: The incoming HTTP request.

    Returns:
        Result: A list of all schedules with total count.
    """
    try:
        scheduler = _get_scheduler(request)
        if scheduler is None:
            return error(message='Scheduler is not initialised', httpStatus=503)

        schedules = scheduler.list_schedules()
        result = ScheduleList(schedules=schedules, total=len(schedules))
        return response(data=result.model_dump(mode='json'))

    except Exception as e:
        return exception(e)


async def get_schedule(request: Request, schedule_id: str) -> Result:
    """
    Get Schedule Endpoint.

    Retrieve details of a specific schedule by ID.

    Args:
        request: The incoming HTTP request.
        schedule_id: Unique identifier of the schedule.

    Returns:
        Result: Schedule details or 404 if not found.
    """
    try:
        scheduler = _get_scheduler(request)
        if scheduler is None:
            return error(message='Scheduler is not initialised', httpStatus=503)

        schedule = scheduler.get_schedule(schedule_id)
        if schedule is None:
            return error(message=f'Schedule {schedule_id!r} not found', httpStatus=404)

        return response(data=schedule.model_dump(mode='json'))

    except Exception as e:
        return exception(e)


async def delete_schedule(request: Request, schedule_id: str) -> Result:
    """
    Delete Schedule Endpoint.

    Remove a schedule by ID.

    Args:
        request: The incoming HTTP request.
        schedule_id: Unique identifier of the schedule to delete.

    Returns:
        Result: Success or 404 if the schedule was not found.
    """
    try:
        scheduler = _get_scheduler(request)
        if scheduler is None:
            return error(message='Scheduler is not initialised', httpStatus=503)

        removed = scheduler.remove_schedule(schedule_id)
        if not removed:
            return error(message=f'Schedule {schedule_id!r} not found', httpStatus=404)

        return response()

    except Exception as e:
        return exception(e)


async def pause_schedule(request: Request, schedule_id: str) -> Result:
    """
    Pause Schedule Endpoint.

    Pause a schedule so it no longer fires until resumed.

    Args:
        request: The incoming HTTP request.
        schedule_id: Unique identifier of the schedule to pause.

    Returns:
        Result: Success or 404 if the schedule was not found.
    """
    try:
        scheduler = _get_scheduler(request)
        if scheduler is None:
            return error(message='Scheduler is not initialised', httpStatus=503)

        paused = scheduler.pause_schedule(schedule_id)
        if not paused:
            return error(message=f'Schedule {schedule_id!r} not found', httpStatus=404)

        return response()

    except Exception as e:
        return exception(e)


async def resume_schedule(request: Request, schedule_id: str) -> Result:
    """
    Resume Schedule Endpoint.

    Resume a previously paused schedule.

    Args:
        request: The incoming HTTP request.
        schedule_id: Unique identifier of the schedule to resume.

    Returns:
        Result: Success or 404 if the schedule was not found.
    """
    try:
        scheduler = _get_scheduler(request)
        if scheduler is None:
            return error(message='Scheduler is not initialised', httpStatus=503)

        resumed = scheduler.resume_schedule(schedule_id)
        if not resumed:
            return error(message=f'Schedule {schedule_id!r} not found', httpStatus=404)

        return response()

    except Exception as e:
        return exception(e)
