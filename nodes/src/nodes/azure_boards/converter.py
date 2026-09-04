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

"""Pure conversion helpers for Azure DevOps work items.

Kept free of any engine/rocketlib imports so it can be unit tested in
isolation, without standing up the pipeline engine.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple


def build_doc_fields(work_item: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """Convert an Azure DevOps work item into (page_content, metadata_extras).

    page_content is a human-readable summary (title, type, state, assignee,
    iteration, tags, description) suitable for embedding/semantic search.
    metadata_extras carries the same structured fields individually, meant to
    be folded into DocMetadata (which allows extra fields) for filtering.

    System.Description arrives as HTML; it's stripped to plain text the same
    way confluence/converter.py handles Confluence's storage format.
    """
    fields = work_item.get('fields', {}) or {}

    title = fields.get('System.Title') or ''
    work_item_type = fields.get('System.WorkItemType') or ''
    state = fields.get('System.State') or ''
    iteration_path = fields.get('System.IterationPath') or ''
    assigned_to = _extract_display_name(fields.get('System.AssignedTo'))
    tags = _split_tags(fields.get('System.Tags') or '')
    description = _strip_html(fields.get('System.Description') or '')

    lines = [f'Title: {title}', f'Type: {work_item_type}', f'State: {state}']
    if assigned_to:
        lines.append(f'Assigned to: {assigned_to}')
    if iteration_path:
        lines.append(f'Iteration: {iteration_path}')
    if tags:
        lines.append(f'Tags: {", ".join(tags)}')
    if description:
        lines.append('')
        lines.append(description)

    page_content = '\n'.join(lines)

    extras = {
        'workItemId': work_item.get('id'),
        'workItemType': work_item_type,
        'state': state,
        'assignedTo': assigned_to,
        'iterationPath': iteration_path,
        'tags': tags,
    }
    return page_content, extras


def _extract_display_name(assigned_to: Any) -> str:
    """Azure DevOps returns AssignedTo as either a bare string or an identity object."""
    if isinstance(assigned_to, dict):
        return assigned_to.get('displayName') or ''
    if isinstance(assigned_to, str):
        return assigned_to
    return ''


def _split_tags(tags_raw: str) -> List[str]:
    """Azure DevOps stores tags as a single semicolon-delimited string."""
    return [tag.strip() for tag in tags_raw.split(';') if tag.strip()]


def _strip_html(html: str) -> str:
    """Convert Azure DevOps' HTML-formatted description field into plain text."""
    if not html or not html.strip():
        return ''

    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, 'html.parser')
    text = soup.get_text(separator='\n')
    text = re.sub(r'[ \t]+\n', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    return text
