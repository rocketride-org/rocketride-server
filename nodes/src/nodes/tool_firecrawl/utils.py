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

from typing import Callable, Any
import time
import re

from rocketlib import debug


def firecrawl_wrapper(fn: Callable[..., Any]) -> Any:
    """Wrap the FireCrawl functionality.

    Args:
        fn (Callable[..., Any]): lambda function to be wrapped.

    """
    retry_count = 0
    max_retries = 5
    base_delay = 5

    while True:
        try:
            return fn()
        except Exception as e:
            # FireCrawl uses different exceptions, like aiohttp.ClientError or requests.exceptions.HTTPError
            # Catch throttling errors and continue
            if hasattr(e, 'args'):
                msg = e.args[0]
                if 'Status code 429. Rate limit exceeded.' in msg:
                    debug('Rate limit exceeded, retrying after sleep')
                    time.sleep(base_delay)
                    continue
                elif re.search(r'Status code:?\s*5\d{2}', msg):
                    retry_count += 1
                    if retry_count <= max_retries:
                        debug(
                            f'Error `{msg}` encountered (attempt {retry_count} from {max_retries}), retrying after sleep'
                        )
                        time.sleep(base_delay)
                        continue
                    else:
                        debug(f'Error `{msg}` encountered, max retries ({max_retries}) exceeded')
                        raise
            debug(f'Error of type {type(e)} caught while executing FireCrawl: {e}')
            raise
