# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Small helpers shared by the ffmpeg-pipe wrappers (MediaPublisher, video_composer)."""


def close_stdin(proc) -> None:
    """Close a subprocess's stdin if it is still open — best effort, never raises.

    Shared so a Windows / ``ValueError``-on-closed-pipe fix lands in one place instead of
    drifting between the two byte-identical copies it used to live in.
    """
    if proc is not None and proc.stdin and not proc.stdin.closed:
        try:
            proc.stdin.close()
        except OSError:
            pass
