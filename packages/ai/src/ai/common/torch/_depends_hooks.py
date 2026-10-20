import sys

_HOSTED_FLAG = '--hosted'
_FORBIDDEN = ('torch', 'torchvision', 'torchaudio')


def excludes(packages):
    """See depends.py's "Hook files" section for the stage contract."""
    if _HOSTED_FLAG not in sys.argv:
        return None

    present = sorted({p for p in packages if p.lower().replace('_', '-') in _FORBIDDEN})
    if present:
        raise RuntimeError(
            f'{", ".join(present)} would be installed, and torch is never installed on a hosted engine: '
            f'GPU inference runs on the model server.'
        )
    return list(_FORBIDDEN)
