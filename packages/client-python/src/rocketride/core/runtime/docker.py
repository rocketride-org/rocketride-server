"""
Docker container lifecycle manager for the RocketRide runtime.

Manages pulling images, creating containers, starting, stopping,
and removing Docker containers. Python equivalent of the VS Code
extension's docker-manager.ts using the ``docker`` PyPI package.
"""

import importlib
import platform as _platform
import subprocess
import sys
from typing import Callable, Dict, Optional

CONTAINER_NAME_PREFIX = 'rocketride-runtime'
IMAGE_BASE = 'ghcr.io/rocketride-org/rocketride-engine'
CONTAINER_PORT = 5565


def _container_name(instance_id: str) -> str:
    """Return the Docker container name for the given instance ID."""
    return f'{CONTAINER_NAME_PREFIX}-{instance_id}'


class DockerRuntime:
    """Manages Docker container lifecycle for RocketRide runtime instances."""

    def __init__(self):  # noqa: D107
        self._client = None

    def _ensure_client(self):
        """Lazily create the Docker client, auto-installing the package if needed."""
        if self._client is None:
            try:
                import docker
            except ImportError:
                print('Installing docker package...')
                subprocess.check_call(
                    [sys.executable, '-m', 'pip', 'install', 'docker>=7.0.0'],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                importlib.invalidate_caches()
                import docker

            self._client = docker.from_env()
        return self._client

    # ARM Macs need to pull amd64 images since GHCR may not have arm64 builds
    @staticmethod
    def _needs_platform_override() -> bool:
        return sys.platform == 'darwin' and _platform.machine() == 'arm64'

    def is_docker_available(self) -> bool:
        """Check whether the Docker daemon is reachable."""
        try:
            client = self._ensure_client()
            client.ping()
            return True
        except Exception:
            return False

    def check_docker_status(self) -> str | None:
        """Return None if Docker is ready, or an error message explaining why not."""
        try:
            client = self._ensure_client()
            client.ping()
            return None
        except Exception:
            return 'Docker daemon is not running or not reachable.'

    def install(
        self,
        image_tag: str,
        instance_id: str,
        port: int,
        on_progress: Optional[Callable[[str], None]] = None,
    ) -> str:
        """Pull image, create container, and start it.

        Args:
            image_tag: Docker image tag (e.g. ``'3.1.2'``, ``'latest'``).
            instance_id: Instance ID for container naming.
            port: Host port to map to the container's 5565.
            on_progress: Optional callback for progress messages.

        Returns:
            The container ID.
        """
        client = self._ensure_client()
        full_image = f'{IMAGE_BASE}:{image_tag}'
        name = _container_name(instance_id)

        # Pull image
        if on_progress:
            on_progress('Pulling image...')
        platform = 'linux/amd64' if self._needs_platform_override() else None
        client.images.pull(IMAGE_BASE, tag=image_tag, platform=platform)

        # Create container
        if on_progress:
            on_progress('Creating container...')
        container = client.containers.create(
            full_image,
            name=name,
            ports={f'{CONTAINER_PORT}/tcp': ('127.0.0.1', port)},
            restart_policy={'Name': 'unless-stopped'},
            platform=platform,
        )

        # Start container
        if on_progress:
            on_progress('Starting container...')
        container.start()

        return container.id

    def start(self, instance_id: str) -> None:
        """Start an existing stopped container."""
        client = self._ensure_client()
        name = _container_name(instance_id)
        container = client.containers.get(name)
        container.start()

    def stop(self, instance_id: str) -> None:
        """Stop a running container."""
        client = self._ensure_client()
        name = _container_name(instance_id)
        try:
            container = client.containers.get(name)
            container.stop()
        except Exception as e:
            # Ignore "container already stopped" or "container not found" errors
            err = str(e).lower()
            if '304' not in str(e) and 'not running' not in err and '404' not in str(e) and 'no such container' not in err:
                raise

    def remove(self, instance_id: str, remove_image: bool = False) -> None:
        """Stop and remove the container, optionally remove the image.

        When ``remove_image`` is True this mirrors the ``--purge`` flag
        behaviour for Docker instances.
        """
        client = self._ensure_client()
        name = _container_name(instance_id)

        image_name: Optional[str] = None
        try:
            container = client.containers.get(name)
            if remove_image:
                image_name = container.image.tags[0] if container.image.tags else None
            container.remove(force=True)
        except Exception as e:
            if '404' not in str(e):
                raise

        if remove_image and image_name:
            try:
                client.images.remove(image_name)
            except Exception:
                pass  # Best-effort image removal

    def get_status(self, instance_id: str) -> Dict:
        """Return the container state and image tag.

        Returns a dict with keys ``state`` and ``image_tag``.
        Possible states: ``'not-installed'``, ``'running'``, ``'starting'``,
        ``'stopped'``, ``'stopping'``.
        """
        client = self._ensure_client()
        name = _container_name(instance_id)

        try:
            container = client.containers.get(name)
            docker_state = container.status  # running, created, restarting, removing, paused, exited, dead
            image_tag = None
            if container.image and container.image.tags:
                tag_str = container.image.tags[0]
                if ':' in tag_str:
                    image_tag = tag_str.rsplit(':', 1)[1]

            state_map = {
                'running': 'running',
                'restarting': 'starting',
                'removing': 'stopping',
                'dead': 'stopping',
            }
            state = state_map.get(docker_state, 'stopped')

            return {'state': state, 'image_tag': image_tag}
        except Exception:
            return {'state': 'not-installed', 'image_tag': None}
