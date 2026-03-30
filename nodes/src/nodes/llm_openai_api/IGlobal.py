from rocketlib import IGlobalBase, OPEN_MODE, warning, debug
from ai.common.config import Config
from ai.common.chat import ChatBase
import os
import re


class IGlobal(IGlobalBase):
    chat: ChatBase | None = None

    def validateConfig(self):
        """
        Validate the configuration for OpenAI-compatible API LLM node.
        """
        try:
            # Load dependencies
            from depends import depends

            requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
            depends(requirements)

            from openai import OpenAI, APIStatusError, OpenAIError, AuthenticationError, RateLimitError, APIConnectionError

            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model')
            base_url = config.get('base_url') or None
            modelTotalTokens = config.get('modelTotalTokens')

            # Only validate tokens > 0 if provided
            if modelTotalTokens is not None and modelTotalTokens <= 0:
                warning('Token limit must be greater than 0')
                return

            # Simple API validation using provider-driven exceptions
            try:
                kwargs = dict(api_key=apikey)
                if base_url:
                    kwargs['base_url'] = base_url

                client = OpenAI(**kwargs)
                client.chat.completions.create(model=model, messages=[{'role': 'user', 'content': 'Hi'}], max_tokens=1)
            except APIStatusError as e:
                status = getattr(e, 'status_code', None) or getattr(e, 'status', None)
                message = str(e)
                try:
                    resp = getattr(e, 'response', None)
                    data = resp.json() if resp is not None else None
                    if isinstance(data, dict):
                        err = data.get('error')
                        etype = err.get('type') if isinstance(err, dict) else None
                        emsg = (err.get('message') if isinstance(err, dict) else None) or data.get('message')
                        parts = []
                        if status:
                            parts.append(f'Error {status}:')
                        if etype:
                            parts.append(etype)
                        if emsg:
                            if etype:
                                parts.append('-')
                            parts.append(emsg)
                        if parts:
                            message = ' '.join(parts)
                except Exception as exc:
                    debug(f'JSON parse failed while formatting API error: {exc}')
                message = re.sub(r'\s+', ' ', message).strip()
                if len(message) > 500:
                    message = message[:500].rstrip() + '…'
                warning(message)
                return
            except (AuthenticationError, RateLimitError, APIConnectionError, OpenAIError) as e:
                message = re.sub(r'\s+', ' ', str(e)).strip()
                if len(message) > 500:
                    message = message[:500].rstrip() + '…'
                warning(message)
                return

        except Exception as e:
            warning(str(e))
            return

    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            pass
        else:
            from .openai_client import Chat

            bag = self.IEndpoint.endpoint.bag
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        self._chat = None
