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

# ------------------------------------------------------------------------------
# This class controls the data shared between all threads for the task
# ------------------------------------------------------------------------------
import threading

from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config
import os


class IGlobal(IGlobalBase):
    _stats_lock = threading.Lock()

    def validateConfig(self):
        """Validate the configuration for the LLM Cache node."""
        try:
            # Load dependencies
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            backend = config.get('backend', 'memory')

            # Validate Redis connectivity if using redis backend
            if backend == 'redis':
                try:
                    import redis

                    host = config.get('host', 'localhost')
                    port = int(config.get('port', 6379))
                    db = int(config.get('db', 0))
                    password = config.get('password', None)
                    if password == '':
                        password = None

                    client = redis.Redis(
                        host=host,
                        port=port,
                        db=db,
                        password=password,
                        decode_responses=True,
                        socket_connect_timeout=5,
                    )
                    client.ping()
                    client.close()
                except Exception as e:
                    warning(f'Redis connection failed: {e}')
                    return

            # Validate TTL
            ttl = config.get('ttl', 3600)
            if ttl is not None and int(ttl) <= 0:
                warning('TTL must be greater than 0')
                return

            # Validate max_size for memory backend
            if backend == 'memory':
                max_size = config.get('max_size', 1000)
                if max_size is not None and int(max_size) <= 0:
                    warning('Max size must be greater than 0')
                    return

        except Exception as e:
            warning(str(e))
            return

    def beginGlobal(self):
        # Initialize instance attributes (avoid class-level mutable state)
        self.cache = None
        self.cache_hits = 0
        self.cache_misses = 0

        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Import the cache client
            from .cache_client import CacheClient

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            # Create the cache client
            self.cache = CacheClient(config, bag)

    def endGlobal(self):
        # Release the cache client
        self.cache = None
