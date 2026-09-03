import json5
import sys
import os
from typing import Dict, Any
from rocketlib import getServiceDefinition, IJson, warning


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

    @staticmethod
    def getNodeConfig(logicalType: str, connConfig: Dict):
        """
        Get the configuration for a connector.

        On entry, connConfig is of the following forms:

                {
                        "profile": "myProfile",     a profile from the services preconfig.profiles section
                                                                                any additional keys to override the section like:
                        "myProfile": {
                                "model": "myModel"
                        }
                }

        or
                {
                        the direct configuration like:
                        "model": "myModel"
                }

        * If a "profile" key is not specified, the default values are taken from
        preconfig.profiles[preconfig.default]. The defaults are then merged into
        the connConfig that is provided. If keys are in connConfig, they will not
        be overriden by the defaults

        * If a "profile" key is specified, the default values are taken from
        preconfig.profiles[profile]. The defaults are then merged into the
        connConfig that is provided. If keys are in connConfig, they will not
        be overriden by the defaults
        """

        def merge(userConfig: Dict[str, Any], defaultConfig: Dict[str, Any]) -> Dict[str, Any]:
            """
            Recursively merge userConfig with defaultConfig.

            - Unspecified or None values in userConfig are replaced with those in defaultConfig.
            - If both values are dictionaries, merge them recursively.
            """
            merged = defaultConfig.copy()

            for key, userValue in userConfig.items():
                defaultValue = defaultConfig.get(key)

                if isinstance(defaultValue, dict) or isinstance(defaultValue, IJson):
                    # Recursively merge nested dictionaries
                    merged[key] = merge(userValue, defaultValue)
                elif userValue is not None:
                    # Override with user value if it's not None
                    merged[key] = userValue

            return merged

        # Output the requested configuration
        service = getServiceDefinition(logicalType)

        # If we couldn't get it, error out
        if service is None:
            raise Exception(f'The service {logicalType} was not found')

        # Make sure it has a preconfig section
        if 'preconfig' not in service:
            raise Exception(f'The service {logicalType} does not have a preconfig section')

        # See if there is a profile key in the configuration
        profile = connConfig.get('profile', None)

        # Get the entire preconfig section
        preconfig = service['preconfig']

        if profile is None:
            # Get the default configuration
            profile = preconfig.get('default')

            if not profile or profile not in preconfig['profiles']:
                raise Exception(f'Default profile {profile} is not defined in {logicalType}')

            # Get the settings for this default name
            profileConfig = preconfig['profiles'].get(profile)

            # Check if default profile is deprecated
            if isinstance(profileConfig, (dict, IJson)) and profileConfig.get('deprecated'):
                migration_msg = profileConfig.get('migration', 'Please use a current profile instead.')
                warning(f'Default profile "{profile}" is deprecated. {migration_msg}')

            defaultConfig = profileConfig

            # Use the connConfig directly as it is not using profiles
            userConfig = connConfig

            # Some UIs nest a node's fields under a sub-object named after the default
            # profile (e.g. connConfig["default"] = {"instructions": [...]}) instead of at
            # the top level. That nesting is otherwise invisible here — merge() below never
            # descends into it — so agent nodes silently lose their instructions. Overlay the
            # nested object's keys as a lower-priority layer, with real top-level keys still
            # winning, so both shapes resolve. No-op unless such a sub-object exists.
            nested = connConfig.get(profile)
            if isinstance(nested, (dict, IJson)):
                combined = dict(IJson.toDict(nested) if isinstance(nested, IJson) else nested)
                for key, value in connConfig.items():
                    # Only real (non-None) top-level values override the nested block; a
                    # None placeholder must not clobber a populated nested value.
                    if key != profile and value is not None:
                        combined[key] = value
                userConfig = combined

            # Merge it
            config = merge(userConfig, defaultConfig)

        else:
            # Make sure it is a valid profile
            if profile not in preconfig['profiles']:
                raise Exception(f'Profile {profile} is not defined in {logicalType}')

            # Get the profile config
            profileConfig = preconfig['profiles'][profile]

            # Check if profile is deprecated
            if isinstance(profileConfig, (dict, IJson)) and profileConfig.get('deprecated'):
                migration_msg = profileConfig.get('migration', 'Please use a current profile instead.')
                warning(f'Profile "{profile}" is deprecated. {migration_msg}')

            # Get the default from the profile
            defaultConfig = profileConfig

            # Get the user specified profile
            userConfig = connConfig.get(profile, {})

            # If it is none, then set to empty
            if not userConfig:
                userConfig = {}

            # Merge defaultConfig into userConfig
            config = merge(userConfig, defaultConfig)

        # Output the computed configuration
        return config

    @staticmethod
    def resolve_node_param(conn: Dict, node_cfg: Dict, prefix: str, key: str, default=None):
        """
        Resolve a single node parameter across every place a UI/.pipe config may put it.

        Canvas/.pipe configs nest UI field values under a 'parameters' object with the
        field prefix KEPT (e.g. connConfig['parameters']['detect.threshold']).
        getNodeConfig neither merges that object nor strips prefixes — and its profile
        branch drops ALL top-level user keys — so resolved node configs never see those
        values. This helper applies the canonical fallback ladder, with explicit
        `is None` checks at each step so set-but-falsy values (0, 0.0, '') survive:

            1. conn['parameters']['<prefix>.<key>']   ('parameters' may be absent/None)
            2. conn['<prefix>.<key>']
            3. conn['<key>']
            4. node_cfg['<key>'], else `default`

        Args:
            conn: Raw connConfig for the node.
            node_cfg: Resolved node config (from getNodeConfig/resolve_node_config).
            prefix: The node's UI field prefix (e.g. 'detect').
            key: Parameter name without the prefix.
            default: Returned when no layer defines the key.

        Returns:
            The first non-None value found, else `default`.
        """
        params = conn.get('parameters')
        value = params.get(f'{prefix}.{key}') if params is not None else None
        if value is None:
            value = conn.get(f'{prefix}.{key}')
        if value is None:
            value = conn.get(key)
        if value is None:
            value = node_cfg.get(key, default)
        return value

    @staticmethod
    def resolve_node_config(logicalType: str, connConfig: Dict, prefix: str) -> Dict:
        """
        Resolve a node's config via getNodeConfig, surfacing a UI-selected profile first.

        The profile selector itself arrives nested under connConfig['parameters'] with
        the field prefix kept (e.g. parameters['detect.profile']), but getNodeConfig
        only looks at connConfig['profile']. If a UI profile is set and no top-level
        'profile' is present, copy connConfig to a plain dict (via IJson.toDict when it
        is an IJson), inject the profile, and resolve with that; otherwise resolve with
        connConfig unchanged.

        Args:
            logicalType: The node's logical service type.
            connConfig: Raw connConfig for the node.
            prefix: The node's UI field prefix (e.g. 'detect').

        Returns:
            The resolved node config (see getNodeConfig).
        """
        params = connConfig.get('parameters')
        ui_profile = params.get(f'{prefix}.profile') if params is not None else None
        if ui_profile is None:
            ui_profile = connConfig.get(f'{prefix}.profile')
        if ui_profile and not connConfig.get('profile'):
            effective = dict(IJson.toDict(connConfig) if isinstance(connConfig, IJson) else connConfig)
            effective['profile'] = str(ui_profile)
            return Config.getNodeConfig(logicalType, effective)
        return Config.getNodeConfig(logicalType, connConfig)

    @staticmethod
    def getProviderConfig(providerConfig: Dict[str, any]):
        """
        Get the provider and the configuration for the provider.

        {
                "provider": "embedding_transformer",
                "embedding_transformer": {
                        "model": "..."
                }
        }
        """
        # Get the provider
        provider = providerConfig.get('provider')
        if not provider:
            raise Exception('Provider config does not have a provider specified')

        # It may actually be None, but it needs to be there
        if provider in providerConfig:
            connConfig = providerConfig.get(provider)
        elif 'config' in providerConfig:
            connConfig = providerConfig.get('config')
        else:
            raise Exception(f'Config not specified for provider {provider}')

        # Return the provider and the configuration
        return provider, connConfig

    @staticmethod
    def getMultiProviderConfig(section: str, multiConfig: Dict[str, any]):
        """
        Get the provider and the configuration for the provider for the given section.

            "embedding": {
                    "provider": "embedding_transformer",
                    "embedding_transformer": {
                            "model": "..."
                    }
            },
            "preprocessor": {
                    "provider": "langchain",
                    "langchain": {
                            "profile": "string",
                            "tokens": 512
                    }
            }
        """
        # Get the driver we are looking for
        config = multiConfig.get(section)
        if not config:
            raise Exception(f'Multiconfig does not have the {section} section')

        # Get the provider from it
        return Config.getProviderConfig(config)
