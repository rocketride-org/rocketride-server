# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Global lifecycle for the Trust Boundary Evaluation Gate node."""

from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config

from .models import PermissionScope, TrustBoundaryConfig


class IGlobal(IGlobalBase):
    config: TrustBoundaryConfig = None
    auth_engine = None
    run_level_policy = None
    audit_logger = None
    passthrough_mode: bool = False
    _jsonschema_available: bool = False
    _crewai_available: bool = False

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        import os
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        # Load configuration from .pipe JSON
        raw = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig) or {}

        config = TrustBoundaryConfig()
        config.enable_tool_interception = bool(raw.get('enable_tool_interception', True))
        config.enable_run_policy = bool(raw.get('enable_run_policy', False))
        config.abort_on_unauthorized = bool(raw.get('abort_on_unauthorized', True))
        config.audit_log = bool(raw.get('audit_log', True))
        config.payload_schema = raw.get('payload_schema', None)

        # Parse permission scopes
        raw_scopes = raw.get('permission_scopes', [])
        scopes = []
        for scope_def in raw_scopes[:50]:  # Max 50 scopes
            if not isinstance(scope_def, dict):
                continue
            scope = PermissionScope(
                scope_id=scope_def.get('scope_id', ''),
                allowed_tools=scope_def.get('allowed_tools', []),
                denied_tools=scope_def.get('denied_tools', []),
                allowed_agents=scope_def.get('allowed_agents', []),
                max_calls_per_run=int(scope_def.get('max_calls_per_run', 0)),
                require_args_schema=scope_def.get('require_args_schema', None),
                description=scope_def.get('description', ''),
            )
            # Validate max_calls_per_run
            if scope.max_calls_per_run < 0:
                warning(
                    f"[TrustBoundary] max_calls_per_run must be >= 0 for scope "
                    f"'{scope.scope_id}'; using 0"
                )
                scope.max_calls_per_run = 0
            scopes.append(scope)

        config.permission_scopes = scopes
        self.config = config

        # Check jsonschema availability
        try:
            import jsonschema  # noqa: F401
            self._jsonschema_available = True
        except ImportError:
            self._jsonschema_available = False
            if config.enable_run_policy and config.payload_schema:
                warning(
                    "[TrustBoundary] jsonschema library not available; "
                    "run-level payload schema enforcement disabled"
                )
                config.enable_run_policy = False

        # Check CrewAI availability
        try:
            from crewai.security import on, InterceptionPoint, HookAborted as CrewHookAborted  # noqa: F401
            self._crewai_available = True
        except (ImportError, AttributeError):
            self._crewai_available = False
            if config.enable_tool_interception:
                warning(
                    "[TrustBoundary] CrewAI framework not available or incompatible; "
                    "falling back to passthrough mode with audit-only logging"
                )
                self.passthrough_mode = True

        # Initialize authorization engine
        from .authorization_engine import AuthorizationEngine
        self.auth_engine = AuthorizationEngine(scopes)

        # Initialize run-level policy
        from .run_level_policy import RunLevelPolicy
        self.run_level_policy = RunLevelPolicy(jsonschema_available=self._jsonschema_available)

        # Initialize audit logger
        from .audit_logger import AuditLogger
        self.audit_logger = AuditLogger(enabled=config.audit_log)

        # Register TrustBoundaryHook when CrewAI is available
        self._hook_instance = None
        if self._crewai_available and config.enable_tool_interception:
            from .trust_boundary_hook import TrustBoundaryHook
            self._hook_instance = TrustBoundaryHook(instance=None)

    def get_hook(self):
        """Return the registered TrustBoundaryHook instance (or None)."""
        return self._hook_instance

    def endGlobal(self):
        self.auth_engine = None
        self.run_level_policy = None
        self.audit_logger = None
        self.config = None
