# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
import threading

from rocketlib import IGlobalBase, OPEN_MODE, warning


# Logical-type / protocol prefixes that, if seen downstream of this node,
# would indicate face crops are being chained into a biometric template
# generator. The runtime check below uses these to block the pipeline.
_BIOMETRIC_DOWNSTREAM_PREFIXES = ('embedding_',)
_BIOMETRIC_DOWNSTREAM_PROTOCOLS = ('embedding',)

_BIOMETRIC_BLOCK_MESSAGE = (
    'Face Detection cannot be chained into an Embedding node — generating '
    'face templates from this output triggers biometric-identifier '
    'regulations (BIPA/GDPR). This node emits boxes only.'
)


class IGlobal(IGlobalBase):
    """
    IGlobal for the Face Detection node.

    Loads MediaPipe BlazeFace once at pipeline start and exposes a device
    lock for thread-safe inference across concurrent IInstance handlers.

    Privacy guard: refuses to start if any downstream node looks like a
    biometric template generator (see ``_check_no_biometric_downstream``).
    """

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        # Privacy guard — runs BEFORE any model is loaded so the pipeline
        # fails fast if mis-wired.
        self._check_no_biometric_downstream()

        from .face_detection import FaceDetector

        bag = self.IEndpoint.endpoint.bag

        self.detector = FaceDetector(self.glb.logicalType, self.glb.connConfig, bag)

        self.device_lock = threading.Lock()

    def endGlobal(self):
        detector = getattr(self, 'detector', None)
        if detector is not None:
            try:
                detector.close()
            except Exception:
                pass
        self.detector = None
        self.device_lock = None

    # -------------------------------------------------------------------------
    # Privacy guard — block chaining into biometric template generators.
    # -------------------------------------------------------------------------

    def _check_no_biometric_downstream(self) -> None:
        """
        Refuse to start if any downstream node is a biometric template
        generator. The rocketlib base class does not expose a documented
        downstream-node accessor, so we probe a handful of plausible names
        and fall back to a startup warning if none are present.
        """
        candidates = self._collect_downstream_nodes()

        if candidates is None:
            warning(
                'face_detection: rocketlib did not expose a downstream-node '
                'accessor; biometric-chain guard reduced to a startup warning. '
                'Do NOT wire this node into any embedding_* node — doing so '
                'would generate face templates and trigger BIPA/GDPR.'
            )
            return

        for node in candidates:
            if self._looks_biometric(node):
                raise RuntimeError(_BIOMETRIC_BLOCK_MESSAGE)

    def _collect_downstream_nodes(self):
        """
        Best-effort downstream-node discovery.

        Returns:
            A list of node descriptors (any shape rocketlib happens to use),
            or ``None`` if no downstream-node accessor could be found — in
            which case the caller falls back to a startup warning.
        """
        endpoint = getattr(getattr(self, 'IEndpoint', None), 'endpoint', None)
        if endpoint is None:
            return None

        for attr in (
            'downstreamNodes',
            'downstream_nodes',
            'downstreams',
            'outputNodes',
            'output_nodes',
            'nextNodes',
            'next_nodes',
            'childNodes',
            'child_nodes',
        ):
            value = getattr(endpoint, attr, None)
            if value is None:
                continue
            # Normalize without splitting a dict into its keys or a str into chars,
            # which would feed _looks_biometric the wrong objects.
            if isinstance(value, dict):
                return [value]
            if isinstance(value, (list, tuple, set)):
                return list(value)
            return [value]

        return None

    @staticmethod
    def _looks_biometric(node: object) -> bool:
        """True if ``node`` looks like a biometric template generator."""
        fields = []
        for attr in ('logicalType', 'logical_type', 'path', 'protocol', 'type', 'name'):
            val = getattr(node, attr, None)
            if val is None and isinstance(node, dict):
                val = node.get(attr)
            if isinstance(val, str):
                fields.append(val.lower())

        for value in fields:
            for prefix in _BIOMETRIC_DOWNSTREAM_PREFIXES:
                if value.startswith(prefix):
                    return True
            for proto in _BIOMETRIC_DOWNSTREAM_PROTOCOLS:
                if value.startswith(proto + '://') or value.startswith(proto + ':'):
                    return True
        return False
