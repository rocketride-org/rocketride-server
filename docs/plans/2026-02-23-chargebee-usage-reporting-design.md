# Chargebee Usage Reporting Integration

## Context

RocketRide's SaaS offering needs usage-based billing. The engine already has a complete metering system that calculates compute tokens (CPU + memory + GPU) every 250ms and prepares billing reports every 5 minutes. The `_report_to_billing_system()` method in `TaskMetrics` is currently a stub. This design replaces that stub with direct reporting to Chargebee's Usage API.

## Scope

Usage reporting only. No subscription management, no customer-facing billing UI, no webhook handling. Chargebee handles invoicing, plan management, and payment collection through its own dashboard.

## Architecture

### Data Flow

```
Engine task runs
  -> TaskMetrics samples every 250ms (existing)
  -> Every 5 min: _report_to_billing_system() calculates incremental tokens (existing)
  -> POST to Chargebee Usage API: subscriptions/{id}/usages (new)
```

### Customer Mapping Flow

```
Client connects with auth header
  -> Account.authenticate() calls LS_APIKEY endpoint (existing)
  -> License server response includes new field: chargebee_subscription_id (new)
  -> Stored in AccountInfo, passed to TaskMetrics (new)
```

### Billing Metric

Existing compute token formula (100 tokens = $1.00):

```
tokens = (vCPU-hours x 1020) + (memory GB-hours x 100) + (GPU GB-hours x 2140)
```

Incremental token delta is reported to Chargebee every 5 minutes. Chargebee aggregates these into invoice-period totals.

## Implementation

### New File: `ai/account/chargebee.py`

Thin HTTP client (~80 lines) using existing `httpx`. Single method:

```python
async def report_usage(subscription_id: str, quantity: float, usage_date: str) -> None
```

- POST to `https://{site}.chargebee.com/api/v2/subscriptions/{id}/usages`
- Basic auth (API key as username, empty password)
- Body: `item_price_id`, `quantity`, `usage_date`
- 1 retry on transient failure (5xx, timeout), then log and move on
- Billing never blocks pipeline execution

### Changed: `ai/account/account.py`

- Add `chargebee_subscription_id: str` field to `AccountInfo`
- Parse from license server response in `authenticate()`

### Changed: `ai/modules/task/task_metrics.py`

- Accept `chargebee_subscription_id` in `__init__()`
- Replace stub in `_report_to_billing_system()` with Chargebee client call:
  - If subscription ID present: report usage to Chargebee
  - If absent (dev/self-hosted): skip silently (current behavior)

### Changed: `ai/constants.py`

```python
CONST_CHARGEBEE_ITEM_PRICE_ID = "compute-tokens-USD"
CONST_CHARGEBEE_USAGE_RETRY_COUNT = 1
CONST_CHARGEBEE_USAGE_RETRY_DELAY = 2.0
```

### New Tests

- Unit test Chargebee client: success, 5xx retry, auth failure (mocked HTTP)
- Unit test `_report_to_billing_system()` with mock Chargebee client

## Configuration

| Variable | Required | Description |
|---|---|---|
| `CHARGEBEE_SITE` | Yes (for billing) | Chargebee site name (e.g., `rocketride`) |
| `CHARGEBEE_API_KEY` | Yes (for billing) | API key with usage write permission |
| `CHARGEBEE_ITEM_PRICE_ID` | No | Override default item price ID |

When `CHARGEBEE_SITE` and `CHARGEBEE_API_KEY` are not set, Chargebee reporting is disabled. Dev and self-hosted deployments are unaffected.

## Failure Handling

- Chargebee API down: log warning, continue. Each report sends its own delta.
- No subscription ID: skip silently.
- Invalid API key: log error once, disable further attempts for the task's lifetime.

## Out of Scope

- Subscription management (create/cancel/change plans)
- Customer-facing billing portal
- Chargebee webhook handling
- Balance enforcement (handled by existing `token_balance` in `AccountInfo`)

## Files Changed

| File | Change |
|---|---|
| `ai/account/chargebee.py` | New - Chargebee HTTP client |
| `ai/account/account.py` | Add `chargebee_subscription_id` to `AccountInfo` |
| `ai/modules/task/task_metrics.py` | Wire subscription ID, replace stub |
| `ai/constants.py` | Add Chargebee constants |
| `tests/` | New + updated tests |

Estimated ~200 lines new/changed code.
