import json5
import re
import sys
import os
from typing import Dict, Any
from rocketlib import warning

# A ${...} left in a config value means no variable had that name when the task
# started (ai.modules.task.pipeline.resolve_pipeline_env keeps unknown ones as-is).
_UNRESOLVED_PLACEHOLDER = re.compile(r'\$\{([^}]*)\}')
# What resolve_pipeline_env writes for a ${NAME} outside the ROCKETRIDE_* namespace.
_REDACTED_PLACEHOLDER = '<REDACTED>'


class UnresolvedCredentialError(ValueError):
    """A credential still holds a ``${...}`` or ``<REDACTED>`` placeholder that no variable filled."""


def check_credential_resolved(logicalType: str, field: str, value: Any) -> None:
    """Raise a clear error when a credential still holds a placeholder no variable filled.

    Without this the placeholder text is sent to the provider as the credential, and
    the user sees the provider's "invalid API key" reply instead of the missing name.
    Call it on the effective config value, right where the credential is used, so a
    node that a run never starts is not checked.

    Args:
        logicalType: The node's logical type, for the message (e.g. 'llm_openai').
        field: The config field that holds the credential (e.g. 'apikey').
        value: The resolved config value. Anything but a string passes.

    Raises:
        UnresolvedCredentialError: The value still contains ``${NAME}`` or ``<REDACTED>``.
    """
    if not isinstance(value, str):
        return
    unresolved = _UNRESOLVED_PLACEHOLDER.search(value)
    if unresolved:
        name = unresolved.group(1)
        raise UnresolvedCredentialError(
            f'{logicalType}: {field} is set to {unresolved.group(0)}, but no variable named {name} was found. '
            f'Add {name} to the org, team or user environment variables, or enter the key in the node settings.'
        )
    if _REDACTED_PLACEHOLDER in value:
        # No '*' in these messages: the engine splits error text on it.
        raise UnresolvedCredentialError(
            f'{logicalType}: {field} uses a variable whose name does not start with ROCKETRIDE_. '
            'Only variables named ROCKETRIDE_<name> resolve in a pipeline.'
        )


def warn_if_credential_unresolved(logicalType: str, field: str, value: Any) -> bool:
    """For a save-time check: warn and return True when the credential is an unfilled placeholder.

    The caller returns without its probe request, which would send the placeholder to
    the provider as the key. Arguments are those of ``check_credential_resolved``.
    """
    try:
        check_credential_resolved(logicalType, field, value)
    except UnresolvedCredentialError as e:
        warning(str(e))
        return True
    return False


class Config:
    """
    Loads and parses the aiconfig.json file (deprecated).
    """

    _config: Dict[str, Any] | None = None

    @staticmethod
    def getModelCacheFolder():
        """
        Get the model cache folder.

        This is where we will store the models.
        """
        # Get the base directory
        base = sys.base_exec_prefix

        # Get the models folder
        folder = base + '/' + 'models'

        # If it does not exist, create it
        if not os.path.exists(folder):
            # Create the directory
            os.makedirs(folder)

        # Return it
        return folder

    @staticmethod
    def getConfig(force_reload=False) -> Dict:
        """
        Read the aiconfig.json file and returns a dictionary with the values.

        Args:
                force_reload (bool, optional): If set to true,
                the config file will be read from disk even if
                it has already been loaded.

        Returns:
                Dict: Configuration dictionary
        """
        # If it is already loaded, return it
        if Config._config is not None and not force_reload:
            return Config._config

        # Get the path
        path = os.path.dirname(os.path.abspath(__file__))

        # Build the config file name
        configPath = os.path.join(path, '..', 'aiconfig.json')

        # Read the json file
        with open(configPath) as f:
            jsonStr = f.read()
            f.close()

        # parse JSON object as a dictionary
        Config._config = json5.loads(jsonStr)

        # Return the config
        return Config._config
