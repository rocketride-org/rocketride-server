# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

# ------------------------------------------------------------------------------
#
# Support for MSAL library and getting an access
# token from Azure
#
# ------------------------------------------------------------------------------
import msal

# ------------------------------------------------------------------------------
#
# Cache for app object
#
# ------------------------------------------------------------------------------
data = {'app': None}


def getClientToken(tenant, region, clientId, clientSecret, scopes):
    """
    Get an access token using clientId/clientSecret.

    https://docs.microsoft.com/en-us/azure/active-directory/develop/console-app-quickstart?pivots=devlang-python
    """
    # If we have not connecter the app yet, do so now
    if data['app'] is None:
        # Get a new app
        app = msal.ConfidentialClientApplication(client_id=clientId, authority='https://login.microsoftonline.com/' + tenant, client_credential=clientSecret, azure_region=region)

        # Save it
        data['app'] = app

    # Get the app
    app = data['app']

    # Setup the result
    result = None

    # Check the token cache
    result = app.acquire_token_silent(scopes, account=None)

    # If we didn't get it here, ask AAD for it
    if not result:
        result = app.acquire_token_for_client(scopes)

    # Return a token
    return result


def getPasswordToken(tenant, region, clientId, username, password, scopes):
    """
    Get an access token using username/password.

    https://github.com/AzureAD/microsoft-authentication-library-for-python/wiki/Username-Password-Authentication
    """
    # If we have not connecter the app yet, do so now
    if data['app'] is None:
        # Get a new app
        app = msal.ConfidentialClientApplication(client_id=clientId, authority='https://login.microsoftonline.com/' + tenant, azure_region=region)

        # Save it
        data['app'] = app

    # Get the app
    app = data['app']

    # The pattern to acquire a token looks like this.
    result = None

    # Firstly, check the cache to see if this end user has signed in before
    accounts = app.get_accounts(username)
    if accounts:
        result = app.acquire_token_silent(scopes, accounts[0])

    if not result:
        # See this page for constraints of Username Password Flow.
        # https://github.com/AzureAD/microsoft-authentication-library-for-python/wiki/Username-Password-Authentication
        result = app.acquire_token_by_username_password(username, password, scopes)

    # Return a token
    return result


def getAccessTokenByRefreshToken(clientId, clientSecret, refresh_token, scopes):
    """Get an access token using a refresh token."""
    # If we have not connecter the app yet, do so now
    if data['app'] is None:
        # Get a new app
        app = msal.ConfidentialClientApplication(client_id=clientId, authority='https://login.microsoftonline.com/common', client_credential=clientSecret)

        # Save it
        data['app'] = app

    # Get the app
    app = data['app']

    # Setup the result
    result = None

    # Check the token cache
    result = app.acquire_token_by_refresh_token(refresh_token, scopes)

    # Return a token
    return result


def getToken(service, scopes: list, refresh_token: str = '') -> str:
    """
    Get a token given the service configuration dict.

    Args:
        service (any): service object (engLib.IFilterEndpoint)
        scopes (list): list of scopes
        refresh_token (str): refresh token, default is empty string

    Raises:
        Exception: _description_

    Returns:
        str: Access token
    """
    # Get the parameters section
    parameters = service.parameters

    # if is personal account - get access token by refresh token
    if parameters.get('authType') == 'personal':
        return getAccessTokenByRefreshToken(clientId=parameters['clientId'], clientSecret=parameters['clientSecret'], refresh_token=refresh_token, scopes=scopes)

    if parameters['auth'] == 'password':
        return getPasswordToken(tenant=parameters['tenant'], region=parameters['region'], clientId=parameters['clientId'], username=parameters['accountName'], password=parameters['accountPassword'], scopes=scopes)

    if parameters['auth'] == 'secure':
        return getClientToken(tenant=parameters['tenant'], region=parameters['region'], clientId=parameters['clientId'], clientSecret=parameters['clientSecret'], scopes=scopes)

    raise Exception('Invalid auth mode: ' + parameters['auth'])
