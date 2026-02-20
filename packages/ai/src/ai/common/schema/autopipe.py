from typing import Dict, Any, Optional
from pydantic import BaseModel, Field, model_validator


class AutopipeProfile(BaseModel):
    """
    Represents a provider profile.

    - `profile`: The profile name (e.g., `"custom"`).
    - `{profile}`: A section named after the profile, containing provider-specific settings.
    """

    profile: str = Field(..., description='Profile name (must match a section of the same name).')
    config: Dict[str, Any] = Field(..., description='Configuration for the specified profile. The section must be the same name as the specified profile name')

    @model_validator(mode='before')
    @classmethod
    def validate_profile(cls, values: Dict[str, Any]) -> Dict[str, Any]:
        profile = values.get('profile')
        if not isinstance(profile, str):
            raise ValueError('Profile must be a string.')

        if profile not in values:
            raise ValueError(f"Missing required profile configuration under key '{profile}'.")

        values['config'] = values[profile]  # Store profile-specific settings
        return values


class AutopipeProvider(BaseModel):
    """
    Represents an autopipe provider configuration.

    - `provider`: Specifies the provider name.
    - `{provider}`: A required section matching `provider`, containing provider-specific settings.
    """

    provider: str = Field(..., description='Provider name, which must also exist as a key in this object.')
    config: Dict[str, Any] = Field(..., description="Provider-specific configuration (must include 'profile'). The section must be the same name as the specified provider name")

    @model_validator(mode='before')
    @classmethod
    def validate_provider(cls, values: Dict[str, Any]) -> Dict[str, Any]:
        provider = values.get('provider')
        if not isinstance(provider, str):
            raise ValueError('Provider must be a string.')

        if provider not in values:
            raise ValueError(f"Missing required provider configuration under key '{provider}'.")

        # Validate the profile section inside the provider's config
        profile_data = values[provider]
        values['config'] = AutopipeProfile(**profile_data).model_dump()  # Validate profile using AutopipeProfile

        return values


class Autopipe(BaseModel):
    """
    Represents the main Autopipe configuration.
    """

    remote: Optional[AutopipeProvider] = None
    embedding: Optional[AutopipeProvider] = None
    store: Optional[AutopipeProvider] = None
    llm: Optional[AutopipeProvider] = None
