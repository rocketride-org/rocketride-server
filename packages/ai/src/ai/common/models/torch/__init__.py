"""
ai.common.models.torch — PyTorch model loader with automatic local/remote detection.

Usage (replaces bare ``import torch`` for model loading):

    import ai.common.models.torch as torch

    model = torch.load('path/to/model.pt')   # returns _TorchWrapper
    output = model(inputs)                    # runs locally or via model server

    # Control gradient tracking — works in both local and server mode:
    with torch.no_grad():
        output = model(inputs)

In local mode ``no_grad`` delegates to the real ``torch.no_grad()``.
In server mode it passes ``no_grad=True`` as a per-request parameter so the
server applies ``torch.no_grad()`` on its side during that inference call.
No persistent server state is involved.
"""

import threading
from typing import Any, Optional

from ..base import get_model_server_address, ModelClient
from .torch_loader import TorchLoader


# ---------------------------------------------------------------------------
# Thread-local gradient context tracking
# ---------------------------------------------------------------------------

_ctx = threading.local()


def _is_no_grad() -> bool:
    return getattr(_ctx, 'no_grad', False)


class no_grad:
    """
    Context manager that disables gradient computation.

    - **Local mode**: equals the real ``torch.no_grad()`` — delegates entirely.
    - **Server mode**: only sets a thread-local flag (no local torch ops);
      ``_TorchWrapper.__call__`` reads it and passes ``no_grad=True`` in the
      inference request so the server applies ``torch.no_grad()`` on its side.

    Usage::

        with torch.no_grad():
            output = model(inputs)
    """

    def __init__(self):
        """Select behaviour based on whether a model server is present."""
        self._server_mode = bool(get_model_server_address())
        if not self._server_mode:
            from ai.common.torch import torch  # pylint: disable=import-outside-toplevel
            self._real = torch.no_grad()
        else:
            self._real = None

    def __enter__(self):
        """Disable gradients: set flag (server) or enter real context (local)."""
        _ctx.no_grad = True
        if self._real is not None:
            self._real.__enter__()
        return self

    def __exit__(self, *args):
        """Re-enable gradients: clear flag (server) or exit real context (local)."""
        _ctx.no_grad = False
        if self._real is not None:
            return self._real.__exit__(*args)
        return False


# ---------------------------------------------------------------------------
# Model wrapper
# ---------------------------------------------------------------------------


class _TorchWrapper:
    """
    Callable wrapper returned by ``torch.load()``.

    In local mode the underlying ``nn.Module`` (or any callable) is held
    directly and called on ``__call__``.

    In server mode inference is routed through ``ModelClient``.
    """

    def __init__(
        self,
        model_path: str,
        device: Optional[str] = None,
    ):
        """
        Load a PyTorch model and set up local or remote routing.

        Args:
            model_path: Path to the ``.pt`` file (torch.save format)
            device: Force device: ``'cpu'``, ``'cuda'``, ``'cuda:N'``,
                    ``'server'`` (force remote), or ``None`` (auto-detect)
        """
        self.model_path = model_path
        self.device = device

        server_addr = get_model_server_address()
        should_proxy = server_addr and (device is None or device == 'server')

        if should_proxy:
            # === REMOTE MODE ===
            self._proxy_mode = True
            host, port = server_addr
            self._client = ModelClient(port, host)
            self._model = None
            self._metadata: dict = {}
            self._init_proxy()
        else:
            # === LOCAL MODE ===
            self._proxy_mode = False
            self._client = None
            self._model, self._metadata, _ = TorchLoader.load(
                model_path,
                device=device if device != 'server' else None,
            )

    def _init_proxy(self) -> None:
        """Load model on server and store metadata."""
        self._client.load_model(
            model_name=self.model_path,
            model_type='torch',
        )
        self._metadata = self._client.metadata

    def __call__(self, inputs: Any) -> Any:
        """
        Run inference.

        Respects the active ``torch.no_grad()`` context in both local and
        server mode — see module docstring for details.

        Args:
            inputs: A single input tensor / list.

        Returns:
            Model output as Python-native lists (JSON-serialisable).
        """
        if self._proxy_mode:
            return self._call_remote(inputs)
        else:
            return self._call_local(inputs)

    def _call_local(self, inputs: Any) -> Any:
        """Run inference locally by calling the model directly."""
        from ai.common.torch import torch

        device = self._metadata.get('device', 'cpu')

        if isinstance(inputs, torch.Tensor):
            tensor = inputs.to(device)
        else:
            tensor = torch.tensor(inputs, dtype=torch.float32, device=device)

        output = self._model(tensor)

        if isinstance(output, torch.Tensor):
            return output.cpu().tolist()
        if isinstance(output, (tuple, list)):
            return [r.cpu().tolist() if isinstance(r, torch.Tensor) else r for r in output]
        return output

    def _call_remote(self, inputs: Any) -> Any:
        """Route inference to the model server, forwarding the no_grad flag."""
        payload = {
            'inputs': [inputs],
            'output_fields': ['output'],
        }
        if _is_no_grad():
            payload['no_grad'] = True

        result = self._client.send_command('inference', payload)
        results = result.get('result', [])
        if results:
            item = results[0]
            if isinstance(item, dict):
                return item.get('output')
            return item
        return None

    def to(self, device: str) -> '_TorchWrapper':
        """Move model to device (local mode only)."""
        if not self._proxy_mode and self._model is not None and hasattr(self._model, 'to'):
            self._model.to(device)
            self._metadata['device'] = device
        return self

    @property
    def metadata(self) -> dict:
        """Return model metadata dict."""
        return self._metadata


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def load(model_path: str, device: Optional[str] = None) -> _TorchWrapper:
    """
    Load a PyTorch model from *model_path* and return a callable wrapper.

    Example::

        import ai.common.models.torch as torch

        model = torch.load('weights/classifier.pt')

        with torch.no_grad():
            output = model(input_data)

    Args:
        model_path: Path to the ``.pt`` file produced by ``torch.save``.
        device: Target device, or ``None`` for auto-detection.

    Returns:
        :class:`_TorchWrapper` that can be called like the original model.
    """
    return _TorchWrapper(model_path, device=device)


__all__ = ['load', 'no_grad', 'TorchLoader', '_TorchWrapper']
