# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import json

from rocketlib import IInstanceBase, AVI_ACTION, warning
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeText(self, text: str):
        value = (text or '').strip()
        if not value:
            return

        try:
            payload = self.IGlobal.synthesize(value)
            self.IGlobal.notify_ws(payload)

            # Keep compatibility with downstream audio nodes.
            if self.instance.hasListener('audio'):
                with open(payload['path'], 'rb') as fin:
                    data = fin.read()
                self.instance.writeAudio(AVI_ACTION.BEGIN, payload.get('mime_type', 'audio/wav'))
                self.instance.writeAudio(AVI_ACTION.WRITE, payload.get('mime_type', 'audio/wav'), data)
                self.instance.writeAudio(AVI_ACTION.END, payload.get('mime_type', 'audio/wav'))

            if self.instance.hasListener('text'):
                self.instance.writeText(json.dumps(payload))
        except Exception as e:
            warning(f'TTS synthesis failed: {e}')
