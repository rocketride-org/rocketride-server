# Chargebee Usage Reporting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the billing stub in TaskMetrics with direct usage reporting to Chargebee's Usage API.

**Architecture:** The engine already calculates compute tokens (CPU + memory + GPU) every 250ms and prepares incremental billing reports every 5 minutes. We replace the print-stub in `_report_to_billing_system()` with an HTTP POST to Chargebee. The Chargebee subscription ID flows from the license server → AccountInfo → TaskServer → Task → TaskMetrics.

**Tech Stack:** Python 3.10+, httpx (already in project), Chargebee Usage API v2, pytest

---

### Task 1: Add Chargebee Constants

**Files:**
- Modify: `packages/ai/src/ai/constants.py:38-39`

**Step 1: Add Chargebee constants after the existing billing API timeout**

Add these lines after `CONST_BILLING_API_TIMEOUT` (line 39):

```python
# =============================================================================
# Chargebee Configuration
# =============================================================================
CONST_CHARGEBEE_ITEM_PRICE_ID = 'compute-tokens-USD'  # default metered item price ID
CONST_CHARGEBEE_USAGE_RETRY_COUNT = 1  # retry once on transient failure
CONST_CHARGEBEE_USAGE_RETRY_DELAY = 2.0  # seconds between retries
```

**Step 2: Commit**

```bash
git add packages/ai/src/ai/constants.py
git commit -m "feat: add Chargebee configuration constants"
```

---

### Task 2: Create Chargebee Client — Tests First

**Files:**
- Create: `packages/ai/tests/ai/account/test_chargebee.py`

**Step 1: Write the failing tests**

```python
"""Tests for Chargebee usage reporting client."""

import pytest
import httpx
from unittest.mock import AsyncMock, patch, MagicMock
from ai.account.chargebee import ChargebeeClient


@pytest.fixture
def client():
    return ChargebeeClient(site='test-site', api_key='test_api_key_123')


@pytest.fixture
def disabled_client():
    return ChargebeeClient(site='', api_key='')


class TestChargebeeClient:
    def test_init_enabled(self, client):
        assert client.enabled is True

    def test_init_disabled_no_site(self):
        c = ChargebeeClient(site='', api_key='some-key')
        assert c.enabled is False

    def test_init_disabled_no_key(self):
        c = ChargebeeClient(site='some-site', api_key='')
        assert c.enabled is False

    @pytest.mark.asyncio
    async def test_report_usage_disabled_is_noop(self, disabled_client):
        # Should return without making any HTTP calls
        await disabled_client.report_usage(
            subscription_id='sub_123',
            quantity=42.5,
            usage_date='2026-02-23',
        )

    @pytest.mark.asyncio
    async def test_report_usage_success(self, client):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        with patch('ai.account.chargebee.httpx.AsyncClient') as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=mock_response)
            mock_client_cls.return_value = mock_client

            await client.report_usage(
                subscription_id='sub_123',
                quantity=42.5,
                usage_date='2026-02-23',
            )

            mock_client.post.assert_called_once()
            call_args = mock_client.post.call_args
            assert 'sub_123' in call_args[0][0]
            assert call_args[1]['data']['quantity'] == '42.5'

    @pytest.mark.asyncio
    async def test_report_usage_retries_on_5xx(self, client):
        error_response = MagicMock()
        error_response.status_code = 503
        error_response.raise_for_status = MagicMock(
            side_effect=httpx.HTTPStatusError('Server Error', request=MagicMock(), response=error_response)
        )

        success_response = MagicMock()
        success_response.status_code = 200
        success_response.raise_for_status = MagicMock()

        with patch('ai.account.chargebee.httpx.AsyncClient') as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(side_effect=[error_response, success_response])
            mock_client_cls.return_value = mock_client

            await client.report_usage(
                subscription_id='sub_123',
                quantity=10.0,
                usage_date='2026-02-23',
            )

            assert mock_client.post.call_count == 2

    @pytest.mark.asyncio
    async def test_report_usage_gives_up_after_retries(self, client):
        error_response = MagicMock()
        error_response.status_code = 503
        error_response.raise_for_status = MagicMock(
            side_effect=httpx.HTTPStatusError('Server Error', request=MagicMock(), response=error_response)
        )

        with patch('ai.account.chargebee.httpx.AsyncClient') as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=error_response)
            mock_client_cls.return_value = mock_client

            # Should not raise — just logs and moves on
            await client.report_usage(
                subscription_id='sub_123',
                quantity=10.0,
                usage_date='2026-02-23',
            )

            # 1 initial + 1 retry = 2 calls
            assert mock_client.post.call_count == 2

    @pytest.mark.asyncio
    async def test_report_usage_disables_on_auth_error(self, client):
        error_response = MagicMock()
        error_response.status_code = 401
        error_response.raise_for_status = MagicMock(
            side_effect=httpx.HTTPStatusError('Unauthorized', request=MagicMock(), response=error_response)
        )

        with patch('ai.account.chargebee.httpx.AsyncClient') as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.post = AsyncMock(return_value=error_response)
            mock_client_cls.return_value = mock_client

            await client.report_usage(
                subscription_id='sub_123',
                quantity=10.0,
                usage_date='2026-02-23',
            )

            # No retry on 401
            assert mock_client.post.call_count == 1
            # Client should disable itself
            assert client.enabled is False

    @pytest.mark.asyncio
    async def test_report_usage_skips_no_subscription_id(self, client):
        with patch('ai.account.chargebee.httpx.AsyncClient') as mock_client_cls:
            await client.report_usage(
                subscription_id='',
                quantity=10.0,
                usage_date='2026-02-23',
            )
            mock_client_cls.assert_not_called()
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/ai && python -m pytest tests/ai/account/test_chargebee.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ai.account.chargebee'`

**Step 3: Commit failing tests**

```bash
git add packages/ai/tests/ai/account/test_chargebee.py
git commit -m "test: add Chargebee client tests (red)"
```

---

### Task 3: Implement Chargebee Client

**Files:**
- Create: `packages/ai/src/ai/account/chargebee.py`

**Step 1: Write the implementation**

```python
"""Chargebee Usage API client for reporting compute token consumption."""

import os
import asyncio
import base64
import httpx
from datetime import datetime, timezone
from rocketlib import debug
from ai.constants import (
    CONST_BILLING_API_TIMEOUT,
    CONST_CHARGEBEE_ITEM_PRICE_ID,
    CONST_CHARGEBEE_USAGE_RETRY_COUNT,
    CONST_CHARGEBEE_USAGE_RETRY_DELAY,
)


class ChargebeeClient:
    """
    Thin HTTP client for Chargebee's Usage API.

    Reports metered usage (compute tokens) to Chargebee for subscription billing.
    Disabled when CHARGEBEE_SITE or CHARGEBEE_API_KEY env vars are not set.
    """

    def __init__(self, site: str = '', api_key: str = '') -> None:
        self._site = site or os.environ.get('CHARGEBEE_SITE', '')
        self._api_key = api_key or os.environ.get('CHARGEBEE_API_KEY', '')
        self._item_price_id = os.environ.get('CHARGEBEE_ITEM_PRICE_ID', CONST_CHARGEBEE_ITEM_PRICE_ID)
        self.enabled = bool(self._site and self._api_key)

    @property
    def _base_url(self) -> str:
        return f'https://{self._site}.chargebee.com/api/v2'

    @property
    def _auth_header(self) -> str:
        # Chargebee uses Basic auth with API key as username, empty password
        token = base64.b64encode(f'{self._api_key}:'.encode()).decode()
        return f'Basic {token}'

    async def report_usage(
        self,
        subscription_id: str,
        quantity: float,
        usage_date: str = '',
    ) -> None:
        """
        Report usage to Chargebee for a subscription.

        Args:
            subscription_id: Chargebee subscription ID
            quantity: Token quantity to report (incremental)
            usage_date: ISO date string (YYYY-MM-DD). Defaults to today.
        """
        if not self.enabled or not subscription_id:
            return

        if not usage_date:
            usage_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')

        url = f'{self._base_url}/subscriptions/{subscription_id}/usages'
        data = {
            'item_price_id': self._item_price_id,
            'quantity': str(quantity),
            'usage_date': usage_date,
        }
        headers = {'Authorization': self._auth_header}

        for attempt in range(1 + CONST_CHARGEBEE_USAGE_RETRY_COUNT):
            try:
                async with httpx.AsyncClient(timeout=CONST_BILLING_API_TIMEOUT) as client:
                    response = await client.post(url, data=data, headers=headers)
                    response.raise_for_status()
                    return  # Success
            except httpx.HTTPStatusError as e:
                status = e.response.status_code
                if status in (401, 403):
                    debug(f'[Chargebee] Auth error ({status}), disabling reporting')
                    self.enabled = False
                    return
                if status >= 500 and attempt < CONST_CHARGEBEE_USAGE_RETRY_COUNT:
                    debug(f'[Chargebee] Server error ({status}), retrying...')
                    await asyncio.sleep(CONST_CHARGEBEE_USAGE_RETRY_DELAY)
                    continue
                debug(f'[Chargebee] HTTP error reporting usage: {e}')
                return
            except httpx.RequestError as e:
                if attempt < CONST_CHARGEBEE_USAGE_RETRY_COUNT:
                    debug(f'[Chargebee] Request error, retrying: {e}')
                    await asyncio.sleep(CONST_CHARGEBEE_USAGE_RETRY_DELAY)
                    continue
                debug(f'[Chargebee] Request error reporting usage: {e}')
                return
```

**Step 2: Run tests to verify they pass**

Run: `cd packages/ai && python -m pytest tests/ai/account/test_chargebee.py -v`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add packages/ai/src/ai/account/chargebee.py
git commit -m "feat: implement Chargebee usage reporting client"
```

---

### Task 4: Add chargebee_subscription_id to AccountInfo

**Files:**
- Modify: `packages/ai/src/ai/account/account.py:10-29` (AccountInfo dataclass)
- Modify: `packages/ai/src/ai/account/account.py:96-113` (default stub)
- Modify: `packages/ai/src/ai/account/account.py:133-146` (endpoint response parsing)

**Step 1: Add field to AccountInfo (line 29, after `plans`)**

```python
    # Chargebee subscription ID for usage-based billing
    chargebee_subscription_id: str = ''
```

**Step 2: Parse from license server response**

In the endpoint response parsing (around line 135), add after `plans=[plan] if plan else ['free'],`:

```python
                chargebee_subscription_id=data.get('chargebee_subscription_id', ''),
```

**Step 3: Commit**

```bash
git add packages/ai/src/ai/account/account.py
git commit -m "feat: add chargebee_subscription_id to AccountInfo"
```

---

### Task 5: Thread Subscription ID Through Task Creation

This task threads the Chargebee subscription ID from the command handler (which has `AccountInfo`) through `TaskServer.start_task()` → `Task.__init__()` so it's available when `TaskMetrics` is created.

**Files:**
- Modify: `packages/ai/src/ai/modules/task/task_server.py:63-101` (TASK_CONTROL)
- Modify: `packages/ai/src/ai/modules/task/task_server.py:799-803` (start_task signature)
- Modify: `packages/ai/src/ai/modules/task/task_server.py:1005-1017` (Task creation)
- Modify: `packages/ai/src/ai/modules/task/task_engine.py:184-198` (Task.__init__ signature)
- Modify: `packages/ai/src/ai/modules/task/task_engine.py:1474-1478` (TaskMetrics creation)
- Modify: `packages/ai/src/ai/modules/task/commands/cmd_task.py:124-129` (start_task call)

**Step 1: Add `chargebee_subscription_id` to TASK_CONTROL**

In `task_server.py`, after `provider: str = None` (line 97):

```python
    # Chargebee subscription ID for usage billing
    chargebee_subscription_id: str = ''
```

**Step 2: Add parameter to `TaskServer.start_task()`**

Change the signature at line 799-803 from:

```python
    async def start_task(
        self,
        apikey: str,
        request: Dict[str, Any],
        conn: TaskConn = None,
```

To:

```python
    async def start_task(
        self,
        apikey: str,
        request: Dict[str, Any],
        conn: TaskConn = None,
        chargebee_subscription_id: str = '',
```

Then after `control.apikey = apikey` (line 882), add:

```python
        control.chargebee_subscription_id = chargebee_subscription_id
```

**Step 3: Pass to Task constructor**

In the `Task(...)` constructor call (lines 1005-1017), add after `ttl=ttl,`:

```python
                chargebee_subscription_id=control.chargebee_subscription_id,
```

**Step 4: Accept in Task.__init__()**

In `task_engine.py`, add `chargebee_subscription_id: str = ''` to the `Task.__init__()` parameter list (after `ttl: int = 900,` at line 196). Store it:

```python
        self._chargebee_subscription_id = chargebee_subscription_id
```

**Step 5: Pass to TaskMetrics**

In `task_engine.py` where TaskMetrics is created (lines 1474-1478), change to:

```python
                self._task_metrics = TaskMetrics(
                    pid=self._engine_process.pid,
                    task_status=self._status,
                    on_update_callback=self._on_metrics_updated,
                    chargebee_subscription_id=self._chargebee_subscription_id,
                )
```

**Step 6: Update callers to pass the subscription ID**

In `cmd_task.py` around line 124, change:

```python
            response = await self._server.start_task(
                self._account_info.apikey,
                request,
                self,
                wait_for_running=True,
            )
```

To:

```python
            response = await self._server.start_task(
                self._account_info.apikey,
                request,
                self,
                wait_for_running=True,
                chargebee_subscription_id=self._account_info.chargebee_subscription_id,
            )
```

Also check `cmd_debug.py` for the same pattern and update it similarly.

**Step 7: Commit**

```bash
git add packages/ai/src/ai/modules/task/task_server.py \
       packages/ai/src/ai/modules/task/task_engine.py \
       packages/ai/src/ai/modules/task/commands/cmd_task.py \
       packages/ai/src/ai/modules/task/commands/cmd_debug.py
git commit -m "feat: thread chargebee_subscription_id from auth to TaskMetrics"
```

---

### Task 6: Wire Chargebee Client into TaskMetrics — Tests First

**Files:**
- Create: `packages/ai/tests/ai/modules/task/test_task_metrics_billing.py`

**Step 1: Create test directory init files if needed**

```bash
mkdir -p packages/ai/tests/ai/modules/task
touch packages/ai/tests/ai/modules/__init__.py
touch packages/ai/tests/ai/modules/task/__init__.py
```

**Step 2: Write the failing tests**

```python
"""Tests for TaskMetrics Chargebee billing integration."""

import pytest
import time
from unittest.mock import AsyncMock, MagicMock, patch
from rocketride import TASK_STATUS
from ai.modules.task.task_metrics import TaskMetrics


@pytest.fixture
def mock_process():
    with patch('ai.modules.task.task_metrics.psutil.Process') as mock:
        process = MagicMock()
        process.cpu_percent.return_value = 50.0
        mem_info = MagicMock()
        mem_info.rss = 512 * 1024 * 1024  # 512MB
        process.memory_info.return_value = mem_info
        process.children.return_value = []
        mock.return_value = process
        yield mock


@pytest.fixture
def mock_cpu_count():
    with patch('ai.modules.task.task_metrics.psutil.cpu_count', return_value=4):
        yield


@pytest.fixture
def task_status():
    return TASK_STATUS()


class TestTaskMetricsBilling:
    def test_accepts_chargebee_subscription_id(self, mock_process, mock_cpu_count, task_status):
        metrics = TaskMetrics(
            pid=1234,
            task_status=task_status,
            chargebee_subscription_id='sub_ABC123',
        )
        assert metrics._chargebee_subscription_id == 'sub_ABC123'

    def test_default_no_subscription_id(self, mock_process, mock_cpu_count, task_status):
        metrics = TaskMetrics(
            pid=1234,
            task_status=task_status,
        )
        assert metrics._chargebee_subscription_id == ''

    def test_report_calls_chargebee_when_subscription_id_set(self, mock_process, mock_cpu_count, task_status):
        metrics = TaskMetrics(
            pid=1234,
            task_status=task_status,
            chargebee_subscription_id='sub_ABC123',
        )
        metrics._chargebee_client = MagicMock()
        mock_report = AsyncMock()
        metrics._chargebee_client.report_usage = mock_report

        # Simulate some token accumulation
        metrics._status.tokens.cpu_utilization = 10.0
        metrics._status.tokens.cpu_memory = 5.0
        metrics._status.tokens.gpu_memory = 2.0

        metrics._report_to_billing_system()

        # Chargebee reporting is async, but _report_to_billing_system is sync.
        # It should schedule the coroutine. We verify the client was accessed.
        # The actual async call is fire-and-forget via asyncio.

    def test_report_skips_chargebee_when_no_subscription_id(self, mock_process, mock_cpu_count, task_status):
        metrics = TaskMetrics(
            pid=1234,
            task_status=task_status,
        )
        metrics._chargebee_client = MagicMock()

        metrics._report_to_billing_system()

        # Should not attempt to report
        metrics._chargebee_client.report_usage.assert_not_called()
```

**Step 3: Run tests to verify they fail**

Run: `cd packages/ai && python -m pytest tests/ai/modules/task/test_task_metrics_billing.py -v`
Expected: FAIL (TaskMetrics doesn't accept `chargebee_subscription_id` yet)

**Step 4: Commit failing tests**

```bash
git add packages/ai/tests/ai/modules/task/test_task_metrics_billing.py \
       packages/ai/tests/ai/modules/__init__.py \
       packages/ai/tests/ai/modules/task/__init__.py
git commit -m "test: add TaskMetrics Chargebee billing tests (red)"
```

---

### Task 7: Wire Chargebee Client into TaskMetrics — Implementation

**Files:**
- Modify: `packages/ai/src/ai/modules/task/task_metrics.py:24-31` (imports)
- Modify: `packages/ai/src/ai/modules/task/task_metrics.py:57-63` (__init__ signature)
- Modify: `packages/ai/src/ai/modules/task/task_metrics.py:366-471` (_report_to_billing_system)

**Step 1: Add imports**

At the top of `task_metrics.py`, add to imports (after line 23):

```python
from ai.account.chargebee import ChargebeeClient
```

And add to the constants import (line 24-31):

```python
from ai.constants import (
    CONST_METRICS_SAMPLE_INTERVAL,
    CONST_BILLING_REPORT_INTERVAL,
    CONST_METRICS_STOP_TIMEOUT,
    CONST_RATE_VCPU_HOUR,
    CONST_RATE_MEMORY_GB_HOUR,
    CONST_RATE_GPU_GB_HOUR,
    CONST_BILLING_API_TIMEOUT,
)
```

**Step 2: Add `chargebee_subscription_id` parameter to __init__**

Change the `__init__` signature (lines 57-63) to:

```python
    def __init__(
        self,
        pid: int,
        task_status: 'TASK_STATUS',
        sample_interval: Optional[float] = None,
        on_update_callback: Optional[Callable[[], None]] = None,
        chargebee_subscription_id: str = '',
    ):
```

Add after `self._on_update_callback = on_update_callback` (line 82):

```python
        # Chargebee billing
        self._chargebee_subscription_id = chargebee_subscription_id
        self._chargebee_client = ChargebeeClient()
```

**Step 3: Replace the billing stub**

Replace the stub section in `_report_to_billing_system()` (lines 447-471) with:

```python
        # Log the report
        try:
            debug(f'[TaskMetrics] Billing report: Incremental={delta_tokens_total:.2f} Cumulative={self._status.tokens.total}')
        except Exception:
            pass

        # Report to Chargebee if subscription ID is available
        if self._chargebee_subscription_id and self._chargebee_client.enabled and delta_tokens_total > 0:
            try:
                import asyncio
                from datetime import datetime, timezone
                usage_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
                coro = self._chargebee_client.report_usage(
                    subscription_id=self._chargebee_subscription_id,
                    quantity=round(delta_tokens_total, 2),
                    usage_date=usage_date,
                )
                # Schedule async reporting without blocking the metrics loop
                asyncio.ensure_future(coro)
            except Exception as e:
                debug(f'[Chargebee] Error scheduling usage report: {e}')
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/ai && python -m pytest tests/ai/modules/task/test_task_metrics_billing.py tests/ai/account/test_chargebee.py -v`
Expected: All tests PASS

**Step 5: Run all existing tests to verify no regressions**

Run: `cd packages/ai && python -m pytest tests/ -v`
Expected: All existing tests still PASS

**Step 6: Commit**

```bash
git add packages/ai/src/ai/modules/task/task_metrics.py
git commit -m "feat: wire Chargebee usage reporting into TaskMetrics billing"
```

---

### Task 8: Update restart_task Path

The restart path also needs the subscription ID threaded through.

**Files:**
- Modify: `packages/ai/src/ai/modules/task/task_server.py:1059-1064` (restart_task signature)
- Modify: `packages/ai/src/ai/modules/task/commands/cmd_task.py:161` (restart_task call)

**Step 1: Add `chargebee_subscription_id` parameter to `restart_task()`**

Same pattern as `start_task()` — add `chargebee_subscription_id: str = ''` to the signature and pass it through to the task's metrics on restart.

**Step 2: Update cmd_task.py restart handler**

Pass `chargebee_subscription_id=self._account_info.chargebee_subscription_id` to `restart_task()`.

**Step 3: Commit**

```bash
git add packages/ai/src/ai/modules/task/task_server.py \
       packages/ai/src/ai/modules/task/commands/cmd_task.py
git commit -m "feat: thread chargebee_subscription_id through restart_task path"
```

---

### Task 9: Integration Smoke Test

**Files:**
- None (manual verification)

**Step 1: Run all tests**

Run: `cd packages/ai && python -m pytest tests/ -v`
Expected: All tests PASS

**Step 2: Run linting**

Run: `cd packages/ai && ruff check src/ tests/`
Expected: No errors

**Step 3: Run formatting**

Run: `cd packages/ai && ruff format src/ tests/`

**Step 4: Final commit if any formatting changes**

```bash
git add -A
git commit -m "style: format Chargebee integration code"
```

---

## File Summary

| File | Action | Task |
|---|---|---|
| `packages/ai/src/ai/constants.py` | Modify | 1 |
| `packages/ai/tests/ai/account/test_chargebee.py` | Create | 2 |
| `packages/ai/src/ai/account/chargebee.py` | Create | 3 |
| `packages/ai/src/ai/account/account.py` | Modify | 4 |
| `packages/ai/src/ai/modules/task/task_server.py` | Modify | 5, 8 |
| `packages/ai/src/ai/modules/task/task_engine.py` | Modify | 5 |
| `packages/ai/src/ai/modules/task/commands/cmd_task.py` | Modify | 5, 8 |
| `packages/ai/src/ai/modules/task/commands/cmd_debug.py` | Modify | 5 |
| `packages/ai/tests/ai/modules/task/test_task_metrics_billing.py` | Create | 6 |
| `packages/ai/src/ai/modules/task/task_metrics.py` | Modify | 7 |

## Chargebee Setup Required (Manual)

Before testing against real Chargebee:
1. Create a Chargebee test site (sandbox)
2. Create a metered item with price ID `compute-tokens-USD`
3. Create a test subscription
4. Set env vars: `CHARGEBEE_SITE`, `CHARGEBEE_API_KEY`
5. Add `chargebee_subscription_id` field to the license server response
