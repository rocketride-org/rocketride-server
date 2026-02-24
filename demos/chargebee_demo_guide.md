# Chargebee Usage Reporting Demo Guide

## Quick Start

```bash
pip install httpx
python3 demos/chargebee_usage_demo.py
```

Open https://rocketride-test.chargebee.com alongside and navigate to:
**Subscriptions > AzqPJwVCADv4b1ozZ > Usage tab**

Watch usage records appear in real time as the demo runs.

## What It Demonstrates

### 1. Live Metrics Sampling (same as engine)
- CPU, memory, and GPU are sampled every 250ms
- Token formula: `(vCPU-hours x 1020) + (memory GB-hours x 100) + (GPU GB-hours x 2140)`
- 100 tokens = $1.00

### 2. Periodic Billing Reports
- Every 10 seconds (5 minutes in production), incremental tokens are POSTed to Chargebee
- Each report returns a `usage_id` confirming Chargebee received it
- Chargebee aggregates all reports via `sum_of_usages` for monthly invoicing

### 3. Final Shutdown Report
- When the task ends, any remaining tokens are reported with `await` (not fire-and-forget)
- This prevents token loss on task completion

### 4. Workload Phases
The demo simulates 4 phases over 2 minutes to show how different workloads produce different costs:

| Phase | Time | CPU | Memory | GPU | Token Rate |
|-------|------|-----|--------|-----|------------|
| Data Ingestion | 0-30s | 15-35% | 200-400 MB | none | low |
| ML Inference | 30-70s | 60-95% | 800-1500 MB | 2-4 GB | high |
| Post-Processing | 70-100s | 30-60% | 400-800 MB | 0.5-1 GB | medium |
| Cleanup | 100-120s | 5-15% | 100-200 MB | none | minimal |

## Architecture (What the Demo Mirrors)

```
Engine task runs
  -> TaskMetrics samples every 250ms
  -> Every 5 min: _report_to_billing_system() calculates incremental tokens
  -> POST https://{site}.chargebee.com/api/v2/subscriptions/{id}/usages
  -> Chargebee aggregates for monthly invoice
```

### Key behaviors built in

- **No credentials = silent no-op.** Dev and self-hosted deployments work without Chargebee config
- **Auth errors (401/403) disable reporting immediately.** Circuit breaker prevents hammering with bad keys
- **Server errors (5xx) retry once** before giving up. Transient failures don't crash the task
- **Counters advance before reporting.** Prevents double-billing if the API call fails

## Chargebee Test Environment

| Resource | Value |
|----------|-------|
| Site | `rocketride-test.chargebee.com` |
| Subscription | `AzqPJwVCADv4b1ozZ` |
| Customer | `test-customer-01` (test@rocketride.ai) |
| Plan | `rocketride-plan-USD-monthly` ($0/mo base) |
| Metered Addon | `compute-tokens-metered` (sum_of_usages) |
| Item Price | `compute-tokens-USD-monthly` ($0.01/token) |

## Environment Variables (Production)

```bash
CHARGEBEE_SITE=rocketride          # or rocketride-test for staging
CHARGEBEE_API_KEY=live_...         # from Chargebee > Settings > API Keys
# CHARGEBEE_ITEM_PRICE_ID=compute-tokens-USD-monthly  # optional override
```

The license server returns `chargebee_subscription_id` per customer. The engine threads it through:
`AccountInfo -> TASK_CONTROL -> Task -> TaskMetrics -> ChargebeeClient`

## Files

| File | Purpose |
|------|---------|
| `packages/ai/src/ai/account/chargebee.py` | HTTP client (httpx, async, retry, circuit breaker) |
| `packages/ai/src/ai/constants.py` | `CONST_CHARGEBEE_*` configuration |
| `packages/ai/src/ai/modules/task/task_metrics.py` | Billing pipeline (samples, accumulates, reports) |
| `packages/ai/src/ai/account/account.py` | `AccountInfo.chargebee_subscription_id` field |
| `packages/ai/tests/ai/account/test_chargebee.py` | Unit tests (11 tests) |
| `demos/chargebee_usage_demo.py` | This demo script |

## PR

https://github.com/rocketride-org/rocketride-server/pull/26
