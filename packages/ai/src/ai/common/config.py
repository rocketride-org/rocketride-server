import json5
import sys
import os
import difflib
from typing import Dict, Any
from rocketlib import getServiceDefinition, IJson, warning


# Fields the catalogue keeps about a profile, which a pipeline never sets. Kept out
# of the known-key set so a near-miss cannot be answered with one of them.
_CATALOGUE_METADATA = frozenset({'title', 'modelSource', 'deprecated', 'deprecatedBy', 'deprecatedSince', 'migration'})


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
    def getNodeProfiles(logicalType: str) -> Dict:
        """
        Get the preconfig.profiles mapping for a node, or {} if it has none.

        Lets callers look a model name up in the catalogue without going through
        profile resolution.
        """
        service = getServiceDefinition(logicalType)
        if service is None or 'preconfig' not in service:
            return {}
        return service['preconfig'].get('profiles') or {}

    @staticmethod
    def _knownConfigKeys(service: Dict) -> set:
        """
        Collect every config key this node legitimately accepts.

        Two sources, unioned: the keys declared across all of the node's profiles
        (so a key present on any profile counts, e.g. modelOutputTokens, which the
        "custom" placeholder omits), and the names in the node's "fields" block,
        with any "<prefix>." stripped.
        """
        keys: set = set()
        preconfig = service.get('preconfig') or {}
        for profile in (preconfig.get('profiles') or {}).values():
            if isinstance(profile, (dict, IJson)):
                keys.update(key for key in profile.keys() if key not in _CATALOGUE_METADATA)
        for field in service.get('fields') or {}:
            keys.add(field.split('.')[-1] if '.' in field else field)
        return keys

    @staticmethod
    def _suggestKey(unknown: str, knownKeys: set) -> str | None:
        """
        Return the key ``unknown`` was probably meant to be, or None.

        Deliberately narrow. A near-miss is reported only when it is nearly
        certain, because an unrecognised key is not proof of a mistake: several
        nodes read config keys their services.json never declares, and warning
        about those on every run would train people to ignore the message.

        Three signals qualify:
          - a key that matches except for casing. merge() keys off the exact
            spelling, so "MODELOUTPUTTOKENS" overrides nothing at all.
          - a known key that ENDS with the unknown one ("outputTokens" ->
            "modelOutputTokens"), the dropped-prefix mistake this exists for.
            Not the reverse, which fires on unrelated names sharing a suffix.
          - a very close spelling (difflib at 0.9), for a plain typo.
        """
        lowered = unknown.lower()
        if unknown in knownKeys:
            return None
        for key in sorted(knownKeys):
            if key.lower() == lowered:
                return key
        for key in sorted(knownKeys):
            candidate = key.lower()
            if len(candidate) > len(lowered) and candidate.endswith(lowered):
                return key
        matches = difflib.get_close_matches(unknown, [k for k in knownKeys if k.lower() != lowered], n=1, cutoff=0.9)
        return matches[0] if matches else None

    @staticmethod
    def _warnMisnamedKeys(logicalType: str, service: Dict, userConfig: Dict) -> None:
        """
        Warn about a config key that is almost, but not quite, a real one.

        Such a key is copied into the merged config and then never read, so the
        node runs with a default the author believes they overrode. Nothing else
        reports it: the pipeline publishes, runs, and produces output.
        """
        knownKeys = Config._knownConfigKeys(service)
        if not knownKeys:
            return
        for key in userConfig:
            suggestion = Config._suggestKey(key, knownKeys)
            if suggestion:
                warning(
                    f'{logicalType}: unknown config key "{key}" - did you mean "{suggestion}"? '
                    f'"{key}" is ignored, so the node runs with the default.'
                )

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

            Config._warnMisnamedKeys(logicalType, service, userConfig)

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

            Config._warnMisnamedKeys(logicalType, service, userConfig)

            # Merge defaultConfig into userConfig
            config = merge(userConfig, defaultConfig)

        # Output the computed configuration
        return config

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
