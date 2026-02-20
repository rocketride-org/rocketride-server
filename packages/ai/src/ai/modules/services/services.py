from typing import Optional
from fastapi import Query
from rocketlib import getServiceDefinitions, getServiceDefinition
from ai.web import response, error, Result


# This endpoint supports optional filtering by a specific service name.
async def services_get(service: Optional[str] = Query(None)) -> Result:
    """
    Asynchronously retrieves service information.

    Args:
        service (str, optional): The name of a specific service to retrieve.

    Returns:
        Result: A response object containing the parsed JSON output or an error message.
    """
    # If a specific service name is provided via the query string (e.g. ?service=xyz)
    if service:
        # Check if the requested service exists in the definitions
        schema = getServiceDefinition(service)

        # If we couldn't find it, return an error message
        if not schema:
            return error(f"Service '{service}' not found. Please check the service name and try again.")
    else:
        # Get all available service schema definitions from the external engine
        schema = getServiceDefinitions()

    # If no specific service is requested, return all service definitions
    return response(schema)
