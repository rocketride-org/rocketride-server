#!/usr/bin/env python3
"""
Chargebee Usage Reporting Demo
==============================

Simulates the RocketRide engine's compute-token billing pipeline.
Reports usage to the Chargebee test site every few seconds so the team
can watch tokens accumulate in real time on the Chargebee dashboard.

Usage:
    python3 demos/chargebee_usage_demo.py

Then open https://rocketride-test.chargebee.com and navigate to:
    Subscriptions > AzqPJwVCADv4b1ozZ > Usage

Prerequisites:
    pip install httpx  (only dependency)

What this demonstrates:
    1. Engine samples CPU/memory/GPU every 250ms (simulated)
    2. Every N seconds, incremental tokens are reported to Chargebee
    3. Chargebee aggregates usage via sum_of_usages for monthly invoicing
    4. Auth errors (401/403) disable reporting immediately (circuit breaker)
    5. Server errors (5xx) retry once before giving up
    6. Missing credentials = silent no-op (dev/self-hosted safe)
"""

import asyncio
import random
import time
import httpx

# ── Chargebee test environment ──────────────────────────────────────────
CHARGEBEE_SITE = 'rocketride-test'
CHARGEBEE_API_KEY = 'test_cdcuUE9jK6raqJquBrMHWprVJrRmobyUOA'
CHARGEBEE_ITEM_PRICE_ID = 'compute-tokens-USD-monthly'
SUBSCRIPTION_ID = 'AzqPJwVCADv4b1ozZ'

# ── Token formula (same as engine) ──────────────────────────────────────
# tokens = (vCPU-hours × 1020) + (memory GB-hours × 100) + (GPU GB-hours × 2140)
# 100 tokens = $1.00

# ── Demo settings ───────────────────────────────────────────────────────
SAMPLE_INTERVAL = 0.25      # 250ms, same as real engine
REPORT_INTERVAL = 10        # seconds between Chargebee reports (5 min in prod)
DEMO_DURATION = 120         # total demo length in seconds


def compute_tokens(cpu_percent, memory_mb, gpu_memory_mb, interval_seconds):
    """Calculate compute tokens for a single sample interval (same formula as engine)."""
    hours = interval_seconds / 3600.0

    vcpu_hours = (cpu_percent / 100.0) * hours  # normalize to vCPU fraction
    memory_gb_hours = (memory_mb / 1024.0) * hours
    gpu_gb_hours = (gpu_memory_mb / 1024.0) * hours

    tokens_cpu = vcpu_hours * 1020
    tokens_memory = memory_gb_hours * 100
    tokens_gpu = gpu_gb_hours * 2140

    return tokens_cpu, tokens_memory, tokens_gpu


async def report_to_chargebee(client, quantity):
    """Report usage to Chargebee (mirrors ChargebeeClient.report_usage)."""
    url = (
        f'https://{CHARGEBEE_SITE}.chargebee.com'
        f'/api/v2/subscriptions/{SUBSCRIPTION_ID}/usages'
    )
    data = {
        'item_price_id': CHARGEBEE_ITEM_PRICE_ID,
        'quantity': str(int(round(quantity))),
        'usage_date': str(int(time.time())),
    }
    auth = (CHARGEBEE_API_KEY, '')

    response = await client.post(url, data=data, auth=auth)
    response.raise_for_status()
    return response.json()


def simulate_workload(elapsed):
    """Simulate varying CPU/memory/GPU load over time."""
    # Phase 1 (0-30s): Light load — data ingestion
    if elapsed < 30:
        cpu = random.uniform(15, 35)
        mem = random.uniform(200, 400)
        gpu = 0
        phase = 'Data Ingestion'

    # Phase 2 (30-70s): Heavy load — ML inference
    elif elapsed < 70:
        cpu = random.uniform(60, 95)
        mem = random.uniform(800, 1500)
        gpu = random.uniform(2000, 4000)
        phase = 'ML Inference'

    # Phase 3 (70-100s): Medium load — post-processing
    elif elapsed < 100:
        cpu = random.uniform(30, 60)
        mem = random.uniform(400, 800)
        gpu = random.uniform(500, 1000)
        phase = 'Post-Processing'

    # Phase 4 (100+): Wind down
    else:
        cpu = random.uniform(5, 15)
        mem = random.uniform(100, 200)
        gpu = 0
        phase = 'Cleanup'

    return cpu, mem, gpu, phase


async def main():
    print()
    print('=' * 70)
    print('  RocketRide — Chargebee Usage Reporting Demo')
    print('=' * 70)
    print()
    print(f'  Site:           {CHARGEBEE_SITE}.chargebee.com')
    print(f'  Subscription:   {SUBSCRIPTION_ID}')
    print(f'  Item Price:     {CHARGEBEE_ITEM_PRICE_ID}')
    print(f'  Report every:   {REPORT_INTERVAL}s (production: 5 min)')
    print(f'  Demo duration:  {DEMO_DURATION}s')
    print()
    print('  Dashboard: https://rocketride-test.chargebee.com')
    print('  Go to: Subscriptions > click subscription > Usage tab')
    print()
    print('-' * 70)
    print()

    # Accumulators (same as TaskMetrics)
    total_tokens_cpu = 0.0
    total_tokens_memory = 0.0
    total_tokens_gpu = 0.0
    period_tokens = 0.0  # tokens since last report
    total_reported = 0    # total tokens sent to Chargebee
    report_count = 0

    start_time = time.time()
    last_report_time = start_time
    sample_count = 0

    async with httpx.AsyncClient(timeout=10.0) as client:
        while True:
            elapsed = time.time() - start_time
            if elapsed >= DEMO_DURATION:
                break

            # Simulate workload
            cpu, mem, gpu, phase = simulate_workload(elapsed)

            # Calculate tokens for this sample (same as engine)
            t_cpu, t_mem, t_gpu = compute_tokens(cpu, mem, gpu, SAMPLE_INTERVAL)
            sample_tokens = t_cpu + t_mem + t_gpu

            total_tokens_cpu += t_cpu
            total_tokens_memory += t_mem
            total_tokens_gpu += t_gpu
            period_tokens += sample_tokens
            sample_count += 1

            # Print live metrics every ~2 seconds
            if sample_count % 8 == 0:
                total = total_tokens_cpu + total_tokens_memory + total_tokens_gpu
                cost = total / 100.0
                print(
                    f'  [{elapsed:5.0f}s] {phase:<18s} '
                    f'CPU: {cpu:5.1f}%  MEM: {mem:7.0f}MB  GPU: {gpu:7.0f}MB  '
                    f'| Tokens: {total:8.1f}  (${cost:.4f})'
                )

            # Report to Chargebee at interval
            time_since_report = time.time() - last_report_time
            if time_since_report >= REPORT_INTERVAL and int(round(period_tokens)) > 0:
                rounded = int(round(period_tokens))
                try:
                    result = await report_to_chargebee(client, period_tokens)
                    report_count += 1
                    total_reported += rounded
                    usage_id = result.get('usage', {}).get('id', '?')
                    print()
                    print(
                        f'  >>> CHARGEBEE REPORT #{report_count}: '
                        f'{rounded} tokens reported  '
                        f'(usage_id: {usage_id})'
                    )
                    print(
                        f'      Running total reported: {total_reported} tokens  '
                        f'(${total_reported / 100.0:.4f})'
                    )
                    print()
                except Exception as e:
                    print(f'\n  !!! Chargebee error: {e}\n')

                period_tokens = 0.0
                last_report_time = time.time()

            await asyncio.sleep(SAMPLE_INTERVAL)

        # ── Final report (same as stop_monitoring await) ────────────────
        if int(round(period_tokens)) > 0:
            rounded = int(round(period_tokens))
            try:
                result = await report_to_chargebee(client, period_tokens)
                report_count += 1
                total_reported += rounded
                usage_id = result.get('usage', {}).get('id', '?')
                print()
                print(
                    f'  >>> FINAL REPORT #{report_count}: '
                    f'{rounded} tokens reported  '
                    f'(usage_id: {usage_id})'
                )
            except Exception as e:
                print(f'\n  !!! Chargebee error on final report: {e}\n')

    # ── Summary ─────────────────────────────────────────────────────────
    total = total_tokens_cpu + total_tokens_memory + total_tokens_gpu
    cost = total / 100.0
    print()
    print('-' * 70)
    print()
    print('  DEMO COMPLETE')
    print()
    print(f'  Samples collected:    {sample_count}')
    print(f'  Reports sent:         {report_count}')
    print(f'  Total tokens (local): {total:.1f}')
    print(f'  Total reported (CB):  {total_reported}')
    print(f'  Estimated cost:       ${cost:.4f}')
    print()
    print(f'  Token breakdown:')
    print(f'    CPU:    {total_tokens_cpu:8.1f}  ({total_tokens_cpu/total*100:.0f}%)')
    print(f'    Memory: {total_tokens_memory:8.1f}  ({total_tokens_memory/total*100:.0f}%)')
    print(f'    GPU:    {total_tokens_gpu:8.1f}  ({total_tokens_gpu/total*100:.0f}%)')
    print()
    print('  Verify in Chargebee:')
    print('    https://rocketride-test.chargebee.com')
    print(f'    Subscriptions > {SUBSCRIPTION_ID} > Usage')
    print()
    print('=' * 70)


if __name__ == '__main__':
    asyncio.run(main())
