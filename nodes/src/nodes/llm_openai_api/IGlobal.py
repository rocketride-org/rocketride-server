from rocketlib import IGlobalBase
from ai.common.chat import ChatBase


class IGlobal(IGlobalBase):
    chat: ChatBase | None = None

    def beginGlobal(self):
        from .openai_client import Chat

        bag = self.IEndpoint.endpoint.bag
        self._chat = Chat(self.glb.logicalType, self.config, bag)

    def endGlobal(self):
        self._chat = None
