# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Multi-agent orchestrator using the supervisor pattern.

The orchestrator decomposes a user question into sub-tasks, assigns each to
a named worker agent, executes them (sequentially or in parallel depending
on the configuration profile), and merges the results into a single unified
answer.

Communication protocols
-----------------------
- **blackboard** — a shared dict all agents can read/write (thread-safe).
- **message_passing** — agents send messages to specific other agents via a
  thread-safe queue.
- **delegation** — the supervisor assigns tasks; workers report back.

Execution modes
---------------
- *sequential* — agents execute one after another in definition order.
- *parallel* — independent agents execute concurrently using threads.
- *supervisor* (default) — the supervisor plans tasks, then dispatches them
  to workers using whichever execution mode is appropriate for the plan.
"""

from __future__ import annotations

import json
import queue
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .agent_definition import AgentDefinition, parse_agent_definitions
from .blackboard import SharedBlackboard


# -------------------------------------------------------------------------
# Data structures
# -------------------------------------------------------------------------


@dataclass
class SubTask:
    """A single sub-task produced by the supervisor's planning step.

    Attributes:
        id: Unique identifier within the plan.
        description: What this sub-task should accomplish.
        assigned_agent: Name of the agent assigned to execute it.
        depends_on: IDs of sub-tasks that must complete first.
    """

    id: str
    description: str
    assigned_agent: str
    depends_on: List[str] = field(default_factory=list)


@dataclass
class AgentResult:
    """The outcome of a single agent executing its sub-task.

    Attributes:
        agent_name: Name of the agent.
        task_id: The sub-task ID that was executed.
        output: The agent's textual output.
        error: Error message if execution failed, else ``None``.
        duration_s: Wall-clock seconds the agent spent.
    """

    agent_name: str
    task_id: str
    output: str = ''
    error: Optional[str] = None
    duration_s: float = 0.0


# -------------------------------------------------------------------------
# Orchestrator
# -------------------------------------------------------------------------


class MultiAgentOrchestrator:
    """Supervisor-pattern multi-agent orchestrator.

    Parameters:
        config: The node configuration dict.  Expected keys:

            - ``agents_json`` — JSON array of agent definitions.
            - ``communication_protocol`` — ``'blackboard'``, ``'message_passing'``,
              or ``'delegation'`` (default ``'delegation'``).
            - ``max_rounds`` — hard cap on orchestration rounds (default 10).
            - ``merge_strategy`` — ``'concatenate'``, ``'summarize'``, or
              ``'vote'`` (default ``'concatenate'``).
            - ``execution_mode`` — ``'sequential'``, ``'parallel'``, or
              ``'supervisor'`` (default ``'supervisor'``).

        call_llm: A callable ``(system_prompt, user_prompt) -> str`` used
            to invoke the LLM for planning, agent execution, and merging.
    """

    def __init__(self, config: Dict[str, Any], call_llm: Callable[..., str]) -> None:  # noqa: D107
        self._config = config
        self._call_llm = call_llm

        # Parse and validate agent definitions.
        self._agents: List[AgentDefinition] = parse_agent_definitions(
            config.get('agents_json'),
        )
        self._agents_by_name: Dict[str, AgentDefinition] = {a.name: a for a in self._agents}

        self._protocol: str = config.get('communication_protocol', 'delegation')
        if self._protocol not in ('blackboard', 'message_passing', 'delegation'):
            raise ValueError(f'Unknown communication_protocol: {self._protocol!r}')

        self._max_rounds: int = int(config.get('max_rounds', 10))
        if self._max_rounds < 1:
            raise ValueError('max_rounds must be >= 1')

        self._merge_strategy: str = config.get('merge_strategy', 'concatenate')
        if self._merge_strategy not in ('concatenate', 'summarize', 'vote'):
            raise ValueError(f'Unknown merge_strategy: {self._merge_strategy!r}')

        self._execution_mode: str = config.get('execution_mode', 'supervisor')
        if self._execution_mode not in ('sequential', 'parallel', 'supervisor'):
            raise ValueError(f'Unknown execution_mode: {self._execution_mode!r}')

        # Shared communication channels
        self._blackboard = SharedBlackboard()
        self._message_queues: Dict[str, queue.Queue] = {a.name: queue.Queue() for a in self._agents}

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def agents(self) -> List[AgentDefinition]:
        return list(self._agents)

    @property
    def blackboard(self) -> SharedBlackboard:
        return self._blackboard

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(self, question: str) -> Dict[str, Any]:
        """End-to-end orchestration: plan, execute, merge.

        Returns a dict with keys:
            - ``answer`` — the merged final answer.
            - ``agent_results`` — per-agent :class:`AgentResult` list.
            - ``plan`` — the list of :class:`SubTask` objects.
            - ``blackboard`` — final blackboard state (if applicable).
        """
        if not self._agents:
            return {
                'answer': '',
                'agent_results': [],
                'plan': [],
                'blackboard': {},
            }

        # Single-agent passthrough — no planning needed.
        if len(self._agents) == 1:
            agent = self._agents[0]
            result = self._execute_agent(agent, question, task_id='single')
            return {
                'answer': result.output if not result.error else f'Error: {result.error}',
                'agent_results': [result],
                'plan': [SubTask(id='single', description=question, assigned_agent=agent.name)],
                'blackboard': self._blackboard.read_all(),
            }

        plan = self.plan(question)
        results = self.execute(plan)
        answer = self.merge_results(results)

        return {
            'answer': answer,
            'agent_results': results,
            'plan': plan,
            'blackboard': self._blackboard.read_all(),
        }

    # ------------------------------------------------------------------
    # Plan
    # ------------------------------------------------------------------

    def plan(self, question: str) -> List[SubTask]:
        """Ask the supervisor LLM to decompose *question* into sub-tasks.

        The supervisor is given the list of available agents and their roles,
        and produces a JSON array of sub-tasks.  Each sub-task names the
        agent to handle it and optionally lists dependencies.

        Returns:
            A list of :class:`SubTask` objects.
        """
        agent_descriptions = '\n'.join(f'- {a.name} (role: {a.role}): {a.instructions[:200]}' for a in self._agents)

        system_prompt = (
            'You are a supervisor coordinating a team of specialist agents.\n'
            'Available agents:\n'
            f'{agent_descriptions}\n\n'
            "Decompose the user's request into sub-tasks.  Assign each sub-task "
            'to the best-suited agent.  If a sub-task depends on another, list '
            'the dependency.\n\n'
            'Respond ONLY with a JSON array.  Each element must have:\n'
            '  {"id": "<unique_id>", "description": "<what to do>", '
            '"assigned_agent": "<agent_name>", "depends_on": ["<id>", ...]}\n'
        )

        raw = self._call_llm(system_prompt, question)
        return self._parse_plan(raw, original_question=question)

    def _parse_plan(self, raw: str, original_question: str = '') -> List[SubTask]:
        """Parse the supervisor's JSON plan into SubTask objects.

        Gracefully handles markdown fences and malformed JSON by falling
        back to a single catch-all task assigned to the first agent.
        """
        text = raw.strip()
        # Strip markdown code fences
        if text.startswith('```'):
            lines = text.splitlines()
            lines = [line for line in lines if not line.strip().startswith('```')]
            text = '\n'.join(lines)

        try:
            items = json.loads(text)
        except json.JSONDecodeError:
            # Fallback: one task per agent, sequentially.
            # Preserve the original question so agents receive the user's
            # intent rather than the LLM's malformed planning output.
            fallback_description = original_question if original_question else raw[:500]
            return [
                SubTask(
                    id=f'task-{i}',
                    description=f'Handle your part of: {fallback_description}',
                    assigned_agent=a.name,
                    depends_on=[f'task-{i - 1}'] if i > 0 else [],
                )
                for i, a in enumerate(self._agents)
            ]

        if not isinstance(items, list):
            items = [items]

        tasks: List[SubTask] = []
        seen_ids: set = set()
        for item in items:
            if not isinstance(item, dict):
                continue
            agent_name = item.get('assigned_agent', '')
            # Validate agent exists — skip unknown agents.
            if agent_name not in self._agents_by_name:
                if self._agents:
                    agent_name = self._agents[0].name
                else:
                    continue
            # Normalize depends_on to always be a list (LLM may return
            # None, a single string, or a scalar instead of a list).
            raw_deps = item.get('depends_on')
            if raw_deps is None:
                deps: List[str] = []
            elif isinstance(raw_deps, list):
                deps = [str(d) for d in raw_deps if d]
            else:
                deps = [str(raw_deps)] if raw_deps else []

            # Validate task ID — generate a fallback for blank/null/duplicate IDs.
            task_id = str(item.get('id') or '')
            if not task_id or task_id in seen_ids:
                task_id = f'task-{len(tasks)}'
            seen_ids.add(task_id)

            tasks.append(
                SubTask(
                    id=task_id,
                    description=str(item.get('description', '')),
                    assigned_agent=agent_name,
                    depends_on=deps,
                )
            )

        return tasks

    # ------------------------------------------------------------------
    # Execute
    # ------------------------------------------------------------------

    def execute(self, plan: List[SubTask]) -> List[AgentResult]:
        """Execute the plan respecting the configured execution mode.

        - ``sequential``: one-by-one in plan order.
        - ``parallel``: all tasks concurrently (dependencies ignored).
        - ``supervisor``: dependency-aware — ready tasks run in parallel,
          blocked tasks wait.
        """
        if self._execution_mode == 'sequential':
            return self._execute_sequential(plan)
        elif self._execution_mode == 'parallel':
            return self._execute_parallel(plan)
        else:
            return self._execute_supervisor(plan)

    def _execute_sequential(self, plan: List[SubTask]) -> List[AgentResult]:
        results: List[AgentResult] = []
        round_count = 0
        for task in plan:
            if round_count >= self._max_rounds:
                results.append(
                    AgentResult(
                        agent_name=task.assigned_agent,
                        task_id=task.id,
                        error='Max rounds exceeded',
                    )
                )
                continue
            agent = self._agents_by_name.get(task.assigned_agent)
            if agent is None:
                results.append(
                    AgentResult(
                        agent_name=task.assigned_agent,
                        task_id=task.id,
                        error=f'Unknown agent: {task.assigned_agent}',
                    )
                )
                continue
            result = self._execute_agent(agent, task.description, task_id=task.id)
            results.append(result)
            round_count += 1
        return results

    # Maximum number of concurrent tasks in parallel mode to prevent
    # resource exhaustion from extremely large plans.
    MAX_PARALLEL_TASKS = 50

    def _execute_parallel(self, plan: List[SubTask]) -> List[AgentResult]:
        if not plan:
            return []

        # Cap at both max_rounds and MAX_PARALLEL_TASKS to prevent overflow.
        cap = min(self._max_rounds, self.MAX_PARALLEL_TASKS)
        tasks_to_run = plan[:cap]

        # Index results by task ID so we can return them in plan order.
        results_by_id: Dict[str, AgentResult] = {}

        with ThreadPoolExecutor(max_workers=min(len(tasks_to_run), 8)) as pool:
            futures = {}
            for task in tasks_to_run:
                agent = self._agents_by_name.get(task.assigned_agent)
                if agent is None:
                    results_by_id[task.id] = AgentResult(
                        agent_name=task.assigned_agent,
                        task_id=task.id,
                        error=f'Unknown agent: {task.assigned_agent}',
                    )
                    continue
                future = pool.submit(self._execute_agent, agent, task.description, task.id)
                futures[future] = task

            for future in as_completed(futures):
                task = futures[future]
                try:
                    results_by_id[task.id] = future.result()
                except Exception as exc:
                    results_by_id[task.id] = AgentResult(
                        agent_name=task.assigned_agent,
                        task_id=task.id,
                        error=str(exc),
                    )

        # Return results in original plan order for determinism.
        return [results_by_id[t.id] for t in tasks_to_run if t.id in results_by_id]

    def _execute_supervisor(self, plan: List[SubTask]) -> List[AgentResult]:
        """Dependency-aware execution: run ready tasks in parallel waves."""
        completed: Dict[str, AgentResult] = {}
        failed_ids: set = set()  # Track failed task IDs so dependents are skipped.
        remaining = list(plan)
        round_count = 0

        while remaining and round_count < self._max_rounds:
            # Skip tasks that depend on a failed prerequisite.
            newly_skipped = []
            for t in remaining:
                if any(d in failed_ids for d in t.depends_on):
                    failed_deps = [d for d in t.depends_on if d in failed_ids]
                    completed[t.id] = AgentResult(
                        agent_name=t.assigned_agent,
                        task_id=t.id,
                        error=f'Skipped: prerequisite(s) {failed_deps} failed',
                    )
                    failed_ids.add(t.id)
                    newly_skipped.append(t.id)
            if newly_skipped:
                remaining = [t for t in remaining if t.id not in completed]
                continue  # Re-evaluate remaining after skipping.

            # Find tasks whose dependencies are all satisfied.
            ready = [t for t in remaining if all(d in completed for d in t.depends_on)]
            if not ready:
                # Deadlock — dependencies can never be satisfied.
                for t in remaining:
                    completed[t.id] = AgentResult(
                        agent_name=t.assigned_agent,
                        task_id=t.id,
                        error='Dependency deadlock',
                    )
                remaining = []
                break

            # Execute ready tasks in parallel.
            with ThreadPoolExecutor(max_workers=min(len(ready), 8)) as pool:
                futures = {}
                for task in ready:
                    agent = self._agents_by_name.get(task.assigned_agent)
                    if agent is None:
                        completed[task.id] = AgentResult(
                            agent_name=task.assigned_agent,
                            task_id=task.id,
                            error=f'Unknown agent: {task.assigned_agent}',
                        )
                        failed_ids.add(task.id)
                        continue
                    future = pool.submit(self._execute_agent, agent, task.description, task.id)
                    futures[future] = task

                for future in as_completed(futures):
                    task = futures[future]
                    try:
                        result = future.result()
                    except Exception as exc:
                        result = AgentResult(
                            agent_name=task.assigned_agent,
                            task_id=task.id,
                            error=str(exc),
                        )
                    if result.error:
                        failed_ids.add(task.id)
                    completed[task.id] = result

            remaining = [t for t in remaining if t.id not in completed]
            round_count += 1

        # Anything still remaining after max_rounds.
        for t in remaining:
            completed[t.id] = AgentResult(
                agent_name=t.assigned_agent,
                task_id=t.id,
                error='Max rounds exceeded',
            )

        # Return in original plan order.
        return [completed[t.id] for t in plan if t.id in completed]

    # ------------------------------------------------------------------
    # Single agent execution
    # ------------------------------------------------------------------

    def _execute_agent(self, agent: AgentDefinition, task: str, task_id: str) -> AgentResult:
        """Execute a single agent against a task description.

        The agent receives its own system instructions, the task, and
        — depending on the communication protocol — context from the
        blackboard or message queue.
        """
        start = time.time()
        try:
            # Build context from communication protocol.
            context_parts: List[str] = []
            if self._protocol == 'blackboard':
                bb_state = self._blackboard.read_all()
                if bb_state:
                    context_parts.append('Shared blackboard state:\n' + json.dumps(bb_state, default=str))
            elif self._protocol == 'message_passing':
                messages: List[str] = []
                q = self._message_queues.get(agent.name)
                if q:
                    while not q.empty():
                        try:
                            messages.append(str(q.get_nowait()))
                        except queue.Empty:
                            break
                if messages:
                    context_parts.append('Messages received:\n' + '\n'.join(messages))

            context_str = '\n\n'.join(context_parts)
            system_prompt = agent.instructions or f'You are a {agent.role} agent.'
            user_prompt = task
            if context_str:
                user_prompt = f'{context_str}\n\nTask: {task}'

            output = self._call_llm(system_prompt, user_prompt)

            # Post-execution: write result to blackboard if using blackboard protocol.
            # Use step-indexed key to avoid overwrites when the same agent
            # handles multiple tasks (e.g. 'researcher_result_t1').
            if self._protocol == 'blackboard':
                bb_key = f'{agent.name}_result_{task_id}'
                self._blackboard.write(agent.name, bb_key, output)

            duration = time.time() - start
            return AgentResult(
                agent_name=agent.name,
                task_id=task_id,
                output=output,
                duration_s=duration,
            )
        except Exception as exc:
            duration = time.time() - start
            return AgentResult(
                agent_name=agent.name,
                task_id=task_id,
                error=str(exc),
                duration_s=duration,
            )

    # ------------------------------------------------------------------
    # Message passing helpers
    # ------------------------------------------------------------------

    def send_message(self, from_agent: str, to_agent: str, message: str) -> None:
        """Send a message from one agent to another (message_passing protocol)."""
        q = self._message_queues.get(to_agent)
        if q is None:
            raise ValueError(f'Unknown target agent: {to_agent!r}')
        q.put(f'[from {from_agent}]: {message}')

    # ------------------------------------------------------------------
    # Merge
    # ------------------------------------------------------------------

    def merge_results(self, results: List[AgentResult]) -> str:
        """Combine per-agent outputs into a single unified answer.

        Strategy is governed by ``merge_strategy`` in the config:

        - ``concatenate``: Join outputs with agent attribution headers.
        - ``summarize``: Ask the LLM to synthesize a coherent summary.
        - ``vote``: Ask the LLM to pick the best answer (majority-style).
        """
        if not results:
            return ''

        # Filter to successful results for merging.
        successful = [r for r in results if not r.error]
        errors = [r for r in results if r.error]

        if not successful:
            error_lines = [f'- {r.agent_name}: {r.error}' for r in errors]
            return 'All agents failed:\n' + '\n'.join(error_lines)

        if self._merge_strategy == 'concatenate':
            return self._merge_concatenate(successful, errors)
        elif self._merge_strategy == 'summarize':
            return self._merge_summarize(successful, errors)
        elif self._merge_strategy == 'vote':
            return self._merge_vote(successful, errors)
        else:
            return self._merge_concatenate(successful, errors)

    def _merge_concatenate(self, successful: List[AgentResult], errors: List[AgentResult]) -> str:
        parts: List[str] = []
        for r in successful:
            parts.append(f'## {r.agent_name}\n{r.output}')
        if errors:
            parts.append('## Errors')
            for r in errors:
                parts.append(f'- {r.agent_name}: {r.error}')
        return '\n\n'.join(parts)

    def _merge_summarize(self, successful: List[AgentResult], errors: List[AgentResult]) -> str:
        agent_outputs = '\n\n'.join(f'Agent "{r.agent_name}" (task {r.task_id}):\n{r.output}' for r in successful)
        system_prompt = 'You are a synthesis agent.  Combine the following agent outputs into a single coherent, well-structured answer.  Preserve all important information and resolve any contradictions.'
        try:
            return self._call_llm(system_prompt, agent_outputs)
        except Exception:
            # Fallback to concatenation on LLM failure.
            return self._merge_concatenate(successful, errors)

    def _merge_vote(self, successful: List[AgentResult], errors: List[AgentResult]) -> str:
        if len(successful) == 1:
            return successful[0].output

        agent_outputs = '\n\n'.join(f'Option {i + 1} (from {r.agent_name}):\n{r.output}' for i, r in enumerate(successful))
        system_prompt = 'You are a judge.  Review the following candidate answers from different agents.  Select the best one or synthesize the best parts into a single superior answer.  Explain your choice briefly, then give the final answer.'
        try:
            return self._call_llm(system_prompt, agent_outputs)
        except Exception:
            return self._merge_concatenate(successful, errors)
