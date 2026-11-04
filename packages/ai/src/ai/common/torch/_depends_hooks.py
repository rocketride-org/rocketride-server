from hosting import delegates_to_model_server, is_hosted, is_saas

_FORBIDDEN = ('torch', 'torchvision', 'torchaudio')


def _refuses_torch() -> bool:
    """The cloud front server, its tasks, and any process that does not run the model.

    ``--hosted`` covers a task. ``--saas`` is the engine process those tasks
    belong to: that is the pod whose disk filled with the CUDA wheels.
    ``--modelserver=<address>`` is the same rule for a process that sends the
    image to the GPU machine. A self-hosted engine with a graphics card has
    none of these flags and still installs torch.
    """
    return is_hosted() or is_saas() or delegates_to_model_server()


def excludes(packages):
    """See depends.py's "Hook files" section for the stage contract."""
    if not _refuses_torch():
        return None

    present = sorted({p for p in packages if p.lower().replace('_', '-') in _FORBIDDEN})
    if present:
        where = 'a hosted engine' if is_hosted() or is_saas() else 'a process that sends inference to the model server'
        raise RuntimeError(
            f'{", ".join(present)} would be installed, and torch is never installed on {where}: '
            f'GPU inference runs on the model server.'
        )
    return list(_FORBIDDEN)
