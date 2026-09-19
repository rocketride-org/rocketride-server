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

"""Shared ``${VAR}`` placeholder resolution for RocketRide configs.

Kept dependency-free (stdlib only) so it can be imported from both the task
orchestration layer (``ai.modules.task.pipeline``) and low-level node config
loading (``ai.common.config``) without pulling in the web server stack.
"""

import json
import re
from typing import Any, Dict

# Only environment variables with this prefix are permitted to resolve.
# All other env vars are blocked to prevent exfiltration of secrets via ${VAR} expansion.
ALLOWED_ENV_PREFIX = 'ROCKETRIDE_'


def resolve_env_placeholders(value: Dict[str, Any], env: Dict[str, str]) -> Dict[str, Any]:
    """Replace ``${KEY}`` placeholders in a dict with environment values.

    Only variables whose names start with :data:`ALLOWED_ENV_PREFIX` are
    resolved. All other references are replaced with ``<REDACTED>`` to
    prevent secret exfiltration.

    Args:
        value: Dictionary that may contain ``${KEY}`` placeholders anywhere
            in its (possibly nested) string values.
        env: Environment dict to resolve placeholders against.

    Returns:
        New dictionary with resolved environment variables.
    """
    value_str = json.dumps(value)

    def replacer(match: re.Match) -> str:
        env_var = match.group(1)
        if env_var.startswith(ALLOWED_ENV_PREFIX):
            resolved = env.get(env_var, match.group(0))
            if resolved == match.group(0):
                return resolved  # placeholder not found — keep as-is
            return json.dumps(resolved)[1:-1]  # escape but strip outer quotes
        return '<REDACTED>'

    resolved_str = re.sub(r'\$\{([^}]+)\}', replacer, value_str)
    return json.loads(resolved_str)
