# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Run-level policy enforcement for execution payload sanitization."""

from .models import HookAborted


class RunLevelPolicy:
    """Validates and sanitizes execution payloads against a configured JSON Schema.

    Strips unknown keys and validates conformance. Raises HookAborted on failure.
    """

    def __init__(self, jsonschema_available: bool = True):
        self._jsonschema_available = jsonschema_available

    def enforce(self, payload: dict, schema: dict = None, enable_run_policy: bool = True) -> dict:
        """Enforce run-level policy on initial execution payload.

        Returns the sanitized payload if valid.
        Raises HookAborted if payload fails validation.
        """
        if not enable_run_policy:
            return payload

        if schema is None:
            return payload

        if payload is None or (isinstance(payload, dict) and not payload):
            raise HookAborted(
                reason="Payload is missing or empty",
                source="TrustBoundaryEvaluationGate",
            )

        if not self._jsonschema_available:
            # Graceful degradation: pass through without validation
            return payload

        try:
            import jsonschema
        except ImportError:
            return payload

        # Validate the schema itself is well-formed
        try:
            jsonschema.Draft7Validator.check_schema(schema)
        except jsonschema.SchemaError as e:
            raise HookAborted(
                reason=f"Configured payload_schema is malformed: {e.message}",
                source="TrustBoundaryEvaluationGate",
            )

        # Strip unknown keys not in schema properties (recursive)
        sanitized = self._strip_unknown_keys(payload, schema)

        # Validate against schema
        try:
            jsonschema.validate(sanitized, schema)
        except jsonschema.ValidationError as e:
            path = '.'.join(str(p) for p in e.absolute_path) if e.absolute_path else '(root)'
            raise HookAborted(
                reason=f"Payload schema violation at '{path}': {e.message}",
                source="TrustBoundaryEvaluationGate",
            )

        return sanitized

    def _strip_unknown_keys(self, data, schema: dict):
        """Recursively strip keys not defined in schema properties.

        Handles nested objects, arrays of objects, and nested arrays recursively.
        Non-dict/scalar elements in arrays are preserved unchanged.
        """
        if not isinstance(data, dict):
            return data

        properties = schema.get('properties', {})
        if not properties:
            return data

        result = {}
        for key, value in data.items():
            if key in properties:
                prop_schema = properties[key]
                if isinstance(value, dict) and prop_schema.get('type') == 'object':
                    # Recurse into nested objects
                    result[key] = self._strip_unknown_keys(value, prop_schema)
                elif isinstance(value, list) and prop_schema.get('type') == 'array':
                    # Sanitize elements inside arrays
                    result[key] = self._strip_array_items(value, prop_schema.get('items', {}))
                else:
                    result[key] = value

        return result

    def _strip_array_items(self, items: list, items_schema: dict) -> list:
        """Recursively sanitize elements in an array per the items schema.

        Handles objects, nested arrays, and scalars.
        """
        if not items_schema:
            return items

        result = []
        for item in items:
            if isinstance(item, dict) and items_schema.get('type') == 'object' and 'properties' in items_schema:
                result.append(self._strip_unknown_keys(item, items_schema))
            elif isinstance(item, list) and items_schema.get('type') == 'array':
                result.append(self._strip_array_items(item, items_schema.get('items', {})))
            else:
                result.append(item)

        return result
