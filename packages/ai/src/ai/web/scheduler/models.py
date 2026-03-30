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

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator


class ScheduleCreate(BaseModel):
    """Request model for creating a new pipeline schedule."""

    pipeline_id: str = Field(..., min_length=1, max_length=256, description='The pipeline to schedule.')
    cron_expression: str = Field(..., min_length=9, max_length=256, description='Cron expression (5-field format: minute hour day month weekday).')
    input_data: Optional[Dict[str, Any]] = Field(default=None, description='Optional input data passed to the pipeline on each run.')
    name: str = Field(..., min_length=1, max_length=256, description='Human-readable name for this schedule.')
    enabled: bool = Field(default=True, description='Whether the schedule should be active immediately.')

    @field_validator('cron_expression')
    @classmethod
    def validate_cron_expression(cls, v: str) -> str:
        """Validate that the cron expression has exactly 5 fields."""
        parts = v.strip().split()
        if len(parts) != 5:
            raise ValueError('Cron expression must have exactly 5 fields (minute hour day month weekday)')
        return v.strip()


class ScheduleResponse(BaseModel):
    """Response model for a single schedule."""

    id: str = Field(..., description='Unique schedule identifier.')
    pipeline_id: str = Field(..., description='The pipeline this schedule triggers.')
    cron_expression: str = Field(..., description='Cron expression for the schedule.')
    name: str = Field(..., description='Human-readable name for this schedule.')
    enabled: bool = Field(..., description='Whether the schedule is currently active.')
    next_run_time: Optional[datetime] = Field(default=None, description='Next scheduled execution time.')
    created_at: datetime = Field(..., description='When the schedule was created.')


class ScheduleList(BaseModel):
    """Response model for listing schedules."""

    schedules: List[ScheduleResponse] = Field(default_factory=list, description='List of schedules.')
    total: int = Field(..., description='Total number of schedules.')


class WebhookResponse(BaseModel):
    """Response model for a webhook-triggered pipeline execution."""

    token: str = Field(..., description='Task token for tracking execution status.')
    pipeline_id: str = Field(..., description='The pipeline that was triggered.')
    status: str = Field(default='accepted', description='Current execution status.')
    created_at: datetime = Field(..., description='When the webhook was received.')
