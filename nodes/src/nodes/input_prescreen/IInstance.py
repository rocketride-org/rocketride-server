# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Per-stream instance for the Static Input Pre-Screen node."""

from rocketlib import IInstanceBase, Entry, warning
from ai.common.schema import Question

from .IGlobal import IGlobal
from .nonce_fencer import SecurityError


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def open(self, entry: Entry):
        """Reset per-object state."""
        pass

    def writeQuestions(self, question: Question):
        """Main entry point: scan for injection, fence with nonces, forward or block.

        Phase 1: If block_ignore_instructions is enabled, run heuristic scan.
                 Apply policy_mode logic (block/warn/log).
        Phase 2: If enable_nonce_fencing is enabled, wrap question text and context
                 in cryptographic nonce fences and inject system addendum.
        """
        engine = self.IGlobal.heuristic_engine
        config = self.IGlobal.config
        nonce_fencer = self.IGlobal.nonce_fencer

        if engine is None or config is None:
            self.instance.writeQuestions(question)
            return

        # Extract all text for scanning
        text_parts = []
        if question.questions:
            text_parts.extend(q.text for q in question.questions if q.text)
        if question.context:
            text_parts.extend(question.context)

        full_text = ' '.join(text_parts)

        # Empty/whitespace input: forward without scanning
        if not full_text.strip():
            self.instance.writeQuestions(question)
            return

        # Enforce max_input_length before scanning
        if config.max_input_length > 0 and len(full_text) > config.max_input_length:
            warning(
                f'[PreScreen] Input length {len(full_text)} exceeds max_input_length '
                f'{config.max_input_length}; blocking'
            )
            self.preventDefault()
            return

        # Phase 1: Static heuristic scan
        if config.block_ignore_instructions:
            scan_result = engine.scan(full_text)

            if not scan_result.passed:
                policy = config.policy_mode

                if policy == 'block':
                    for match in scan_result.matches:
                        warning(
                            f'[PreScreen] Blocked: {match.category} \u2014 {match.matched_text[:60]}'
                        )
                    self.preventDefault()
                    return
                elif policy == 'warn':
                    for match in scan_result.matches:
                        warning(
                            f'[PreScreen] Warning: {match.category} \u2014 {match.matched_text[:60]}'
                        )
                elif policy == 'log':
                    import logging
                    logger = logging.getLogger('rocketride.input_prescreen')
                    for match in scan_result.matches:
                        logger.info(
                            '[PreScreen] Detected: category=%s, rule=%s, severity=%s, pos=%d',
                            match.category, match.rule_id, match.severity, match.position,
                        )

        # Phase 2: Nonce fencing
        if config.enable_nonce_fencing and nonce_fencer:
            try:
                nonce = nonce_fencer.new_cycle()
            except Exception:
                warning('[PreScreen] Nonce generation failed; rejecting question')
                self.preventDefault()
                return

            if not nonce:
                warning('[PreScreen] Nonce generation returned empty; rejecting question')
                self.preventDefault()
                return

            try:
                # Fence each question text individually
                if question.questions:
                    for q in question.questions:
                        if q.text:
                            q.text = nonce_fencer.fence(q.text, nonce)

                # Fence context/RAG documents
                if question.context:
                    question.context = [
                        nonce_fencer.fence(ctx, nonce) for ctx in question.context
                    ]

                # Inject system addendum
                addendum = nonce_fencer.build_system_addendum(nonce)
                if hasattr(question, 'system_addendum') and question.system_addendum:
                    question.system_addendum += '\n' + addendum
                else:
                    question.system_addendum = addendum

            except SecurityError as e:
                warning(f'[PreScreen] Nonce fencing failed: {e}; rejecting question')
                self.preventDefault()
                return

        self.instance.writeQuestions(question)

    def writeDocuments(self, documents):
        """Apply pre-screen enforcement to documents lane.

        Scans document content for injection, applies policy mode,
        and fences with nonces if enabled.
        """
        engine = self.IGlobal.heuristic_engine
        config = self.IGlobal.config
        nonce_fencer = self.IGlobal.nonce_fencer

        if engine is None or config is None:
            self.instance.writeDocuments(documents)
            return

        # Extract document text for scanning
        text_parts = []
        for doc in documents:
            content = None
            if hasattr(doc, 'page_content'):
                content = doc.page_content
            elif isinstance(doc, dict):
                content = doc.get('page_content', '')
            else:
                content = str(doc) if doc else ''
            if content and str(content).strip():
                text_parts.append(str(content))

        full_text = ' '.join(text_parts)

        if not full_text.strip():
            self.instance.writeDocuments(documents)
            return

        # Enforce max_input_length
        if config.max_input_length > 0 and len(full_text) > config.max_input_length:
            warning(
                f'[PreScreen] Document input length {len(full_text)} exceeds '
                f'max_input_length {config.max_input_length}; blocking'
            )
            self.preventDefault()
            return

        # Heuristic scan
        if config.block_ignore_instructions:
            scan_result = engine.scan(full_text)

            if not scan_result.passed:
                policy = config.policy_mode

                if policy == 'block':
                    for match in scan_result.matches:
                        warning(
                            f'[PreScreen] Document blocked: {match.category} '
                            f'\u2014 {match.matched_text[:60]}'
                        )
                    self.preventDefault()
                    return
                elif policy == 'warn':
                    for match in scan_result.matches:
                        warning(
                            f'[PreScreen] Document warning: {match.category} '
                            f'\u2014 {match.matched_text[:60]}'
                        )
                elif policy == 'log':
                    import logging
                    logger = logging.getLogger('rocketride.input_prescreen')
                    for match in scan_result.matches:
                        logger.info(
                            '[PreScreen] Document detected: category=%s, rule=%s, severity=%s, pos=%d',
                            match.category, match.rule_id, match.severity, match.position,
                        )

        # Nonce fencing on documents is handled when they appear as question context
        # (documents lane is typically collected and attached to questions by the engine)
        self.instance.writeDocuments(documents)

    def close(self):
        """Clean up per-object state."""
        pass
