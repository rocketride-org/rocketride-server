from __future__ import annotations

import json
import logging
import time


class _StructuredFormatter(logging.Formatter):
    _RESERVED = frozenset(logging.LogRecord(
        '', 0, '', 0, '', (), None
    ).__dict__.keys()) | {'message', 'asctime'}

    def format(self, record: logging.LogRecord) -> str:
        record.message = record.getMessage()

        payload = {
            'timestamp': time.strftime(
                '%Y-%m-%dT%H:%M:%SZ', time.gmtime(record.created)
            ),
            'level':   record.levelname,
            'logger':  record.name,
            'message': record.message,
        }

        for key, value in record.__dict__.items():
            if key not in self._RESERVED:
                payload[key] = value

        if record.exc_info:
            payload['exception'] = self.formatException(record.exc_info)

        def safe_default(obj):
            try:
                return str(obj)
            except Exception:
                return "<unserializable>"

        return json.dumps(payload, default=safe_default)


def get_task_logger(name: str = "task_engine") -> logging.Logger:
    logger = logging.getLogger(name)
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(_StructuredFormatter())
        logger.addHandler(handler)
    return logger
