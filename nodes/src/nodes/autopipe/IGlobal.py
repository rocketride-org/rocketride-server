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

from rocketlib import IGlobalBase, debug, OPEN_MODE
from typing import Dict, Any, Optional
from ai.common.config import Config


class IGlobal(IGlobalBase):
    def beginGlobal(self):
        """
        Node autopipe works in conjuction with the vectorizer, indexer, parse filters and figures out the right configuration of the stack.
        """
        # Define our pipeline we are building and default to local
        pipeline = []
        remote = []

        # Push a locally run filter
        def pushLocal(filter: Dict[str, Any]):
            pipeline.append(filter)
            debug('    Local', filter['provider'])

        # Push a remotely run filter
        def pushRemote(filter: Dict[str, Any]):
            remote.append(filter)
            debug('    Remote', filter['provider'])

        # Create a filter for the given provider
        def getFilter(id: str, provider: str, config: Optional[Dict] = None):
            if config is None:
                config = {}
            filter = {}
            filter['id'] = id
            filter['provider'] = provider
            filter[provider] = config
            return filter

        # Add an input lane to the filter
        def addInputLane(filter: Dict, lane: str, source: str):
            if 'input' not in filter:
                filter['input'] = []
            filter['input'].append({'lane': lane, 'from': source})
            return filter

        # Add an output lane to the filter
        def addOutputLane(filter: Dict, lane: str, source: str):
            if 'output' not in filter:
                filter['output'] = []
            filter['output'].append({'lane': lane, 'from': source})
            return filter

        # Determines if a key is set in the include paths
        def isSet(key: str):
            # Make sure we have a service section
            if section not in self.IEndpoint.endpoint.taskConfig:
                return False

            # Make sure it has incudes
            if 'include' not in self.IEndpoint.endpoint.taskConfig[section]:
                return False

            # Sure if it is enabled on any of the includes
            for include in self.IEndpoint.endpoint.taskConfig[section]['include']:
                if include.get(key, False):
                    return True
            return False

        # Are we running a config task?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass

        # If we are running in source index mode, we don't add anything
        # else since it is supposed to deliver it directly from
        # the source
        elif self.IEndpoint.endpoint.openMode == OPEN_MODE.SOURCE_INDEX:
            pass

        # If we are running an index task, we grab from the index and
        # vectorizer
        elif self.IEndpoint.endpoint.openMode == OPEN_MODE.INDEX:
            # This is directly in the task configuration
            config = self.IEndpoint.endpoint.taskConfig.get('autopipe', {})

            # Get our configuration
            autopipeConfig = Config.getNodeConfig('autopipe', config)

            # If our autopipe has a store, use it as well
            if 'store' in autopipeConfig:
                providerStore, configStore = Config.getMultiProviderConfig('store', autopipeConfig)
                pushLocal(getFilter('vector_1', providerStore, configStore))

            # Push the indexer
            pushLocal(getFilter('indexer_1', 'indexer'))
            pass

        # If we are running a transform or instance task, we basically
        # bring in the parser, ocr if needed and vectorizer, but we
        # configure for local or remote operation here
        elif self.IEndpoint.endpoint.openMode == OPEN_MODE.INSTANCE or self.IEndpoint.endpoint.openMode == OPEN_MODE.TRANSFORM:
            # Where we go to for our isSet functions
            if self.IEndpoint.endpoint.openMode == OPEN_MODE.INSTANCE:
                # This is a instance task, look in the service section for flags
                # and get the parameters
                isTransform = False
                section = 'service'

                # This is directly in the task configuration
                config = self.IEndpoint.endpoint.taskConfig.get('autopipe', {})
            else:
                # This is a transform task, look in the endpoints configuration
                # for autopipe
                isTransform = True
                section = 'source'

                # The configuration of what we need is in the serviceConfig parameters
                parameters = self.IEndpoint.endpoint.serviceConfig['parameters']

                # Get our configuration
                config = parameters.get('autopipe', {})

            # Fill in anything missing
            autopipeConfig = Config.getNodeConfig('autopipe', config)

            # In local mode, we essintially create this stack:
            #   parse -> ocr -> index
            pushLocal(getFilter('parse_1', 'parse'))

            # If OCR is enabled
            if isSet('ocr'):
                pushLocal(getFilter('ocr_1', 'ocr'))

            # If indexer is enabled
            if isSet('index') and not isTransform:
                pushLocal(getFilter('indexer_1', 'indexer'))

            # If autopipe has a preprocessor, push it to chunk the text
            if 'preprocessor' in autopipeConfig:
                providerPreprocessor, configPreprocessor = Config.getMultiProviderConfig('preprocessor', autopipeConfig)
                pushLocal(getFilter('preprocessor_1', providerPreprocessor, configPreprocessor))

            # If autopipe has an embedding, push it to vectorize the chunks
            if 'embedding' in autopipeConfig:
                providerEmbedding, configEmbedding = Config.getMultiProviderConfig('embedding', autopipeConfig)
                pushLocal(getFilter('embedding_1', providerEmbedding, configEmbedding))

            # If autopipe has a store, push it to save to the vector db
            if 'store' in autopipeConfig:
                providerStore, configStore = Config.getMultiProviderConfig('store', autopipeConfig)
                pushLocal(getFilter('vector_1', providerStore, configStore))

            pass

        # Now, add all the filters we figured out
        for pipe in pipeline:
            provider, config = Config.getProviderConfig(pipe)
            self.IEndpoint.endpoint.insertFilter(provider, config)
        return

    def endGlobal(self):
        pass

        # # Push a locally run filter
        # def pushLocal(provider: str, config: Dict = {}):
        #     lanes.append({'provider': provider, 'config': config})
        #     debug('    Local', provider)

        # # Push a remotely run filter
        # def pushRemote(provider: str, config: Dict = {}):
        #     debug('    Remote', provider)
        #     pipeline.append({'provider': provider, 'config': config})

        # # Get the remote config
        # remoteConfig = Config.getNodeConfig('remote', autopipeConfig.get('remote', {}))

        # # Determine if we are local or remote
        # isLocal = remoteConfig.get('mode', 'local') == 'local'
        # # If we are not running locally, we have to build up the
        # # remote pipeline with all its parameters
        # if not isLocal and len(pipeline):
        #     # Get the host, port and apikey
        #     host = remoteConfig.get('host', 'localhost')
        #     port = remoteConfig.get('port', 5565)
        #     apikey = remoteConfig.get('apikey', '')

        #     # Create the config - since we know exactly what we want and
        #     # need as this is a fixed pipe that parsing, preprocessing and
        #     # embedding, we can put the input/output tags directly here. In
        #     # a normal pipeline, these would be computed
        #     remoteConfig = {
        #         'host': host,
        #         'port': port,
        #         'apikey': apikey,
        #         'pipeline': {
        #             'pipeline': pipeline
        #         }
        #     }

        #     # Push our remoter
        #     pushLocal('remote', remoteConfig)
