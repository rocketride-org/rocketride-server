import sys

_FORBIDDEN = ('torch', 'torchvision', 'torchaudio')


def _model_server_configured():
    """True when ``--modelserver=<address>`` is on the command line, as ai.common.models.base reads it.

    Parsed here because a hook file may import only the standard library:
    importing ``ai`` or ``ai.common`` would run ``depends()``.
    """
    return any(arg.startswith('--modelserver=') and arg.split('=', 1)[1] for arg in sys.argv)


def excludes(packages):
    """See depends.py's "Hook files" section for the stage contract.

    Torch is never installed when a model server is configured: GPU inference runs there. Without one,
    a locally hosted SaaS server included, torch installs as usual.
    """
    if not _model_server_configured():
        return None

    present = sorted({p for p in packages if p.lower().replace('_', '-') in _FORBIDDEN})
    if present:
        raise RuntimeError(
            f'{", ".join(present)} would be installed, and torch is never installed when a model server is '
            f'configured (--modelserver): GPU inference runs on the model server.'
        )
    return list(_FORBIDDEN)
