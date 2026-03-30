# Headless Pipeline Execution

RocketRide pipelines can run without the VS Code UI — triggered programmatically
from any application via the SDK.

## When to Use Headless Execution

- **Production workflows:** Trigger pipelines from API endpoints, cron jobs, or event handlers
- **CI/CD:** Run pipelines as part of automated test/deploy workflows
- **Batch processing:** Fan out to multiple pipeline instances programmatically

## Performance Characteristics

Headless execution bypasses the VS Code UI layer entirely. The C++ engine processes
nodes directly without rendering the pipeline visualization. This means:

- Lower memory footprint (no webview/DOM overhead)
- Faster startup for short pipelines
- Suitable for high-frequency triggering (e.g., per-request in an API)

## Pattern: API-triggered Pipeline

```python
# In your FastAPI/Flask/Django app:
from rocketride import RocketRideClient
import json

def run_pipeline(data: dict) -> dict:
    client = RocketRideClient(uri="http://localhost:5565")
    client.connect()
    token = client.use(filepath="./pipeline.pipe")
    result = client.send(
        token["token"],
        json.dumps(data),
        {"name": "input.json"},
        "application/json"
    )
    client.terminate(token["token"])
    client.disconnect()
    return result
```

## Engine Availability

The engine must be running before calling `client.connect()`. Two options:

1. VS Code with RocketRide extension installed (engine auto-starts)
2. Docker: `docker run -p 5565:5565 ghcr.io/rocketride-org/rocketride-engine:latest`

Always handle the case where the engine isn't running:

```python
try:
    client = RocketRideClient(uri=ROCKETRIDE_URI)
    client.connect()
    # run pipeline
except Exception as e:
    # Fall back to direct execution
    pass
```
