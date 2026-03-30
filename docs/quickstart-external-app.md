# Quickstart: Invoking Pipelines from External Applications

This guide shows how to invoke RocketRide pipelines from Python and TypeScript applications.
Discovered while building Portfolio Brain at HackwithBay 2.0 — this is the pattern that works.

## Prerequisites

- RocketRide engine running (port 5565 via VS Code extension or Docker)
- Python SDK: `pip install rocketride`

## Python Example

```python
from rocketride import RocketRideClient
import json

# 1. Connect
client = RocketRideClient(uri="http://localhost:5565")
client.connect()

# 2. Load your pipeline
token = client.use(filepath="./my_pipeline.pipe")

# 3. Send data and run
result = client.send(
    token["token"],
    json.dumps({"company": "Acme Corp", "revenue": 500000}),
    {"name": "input.json"},
    "application/json"
)

# 4. Terminate
client.terminate(token["token"])
client.disconnect()

print(result)
```

## Common Patterns

### Graceful fallback when engine unavailable

```python
def get_client():
    try:
        client = RocketRideClient(uri="http://localhost:5565")
        client.connect()
        return client
    except Exception:
        return None  # Engine not running — fall back to direct Python

client = get_client()
if client:
    # Run via pipeline
    ...
else:
    # Direct execution
    ...
```

### Triggering pipelines from FastAPI

```python
from fastapi import FastAPI
from rocketride import RocketRideClient
import json, os

app = FastAPI()
ROCKETRIDE_URI = os.environ.get("ROCKETRIDE_URI", "http://localhost:5565")

@app.post("/trigger-pipeline")
def trigger(payload: dict):
    try:
        client = RocketRideClient(uri=ROCKETRIDE_URI)
        client.connect()
        token = client.use(filepath="./pipeline.pipe")
        result = client.send(token["token"], json.dumps(payload), {"name": "data.json"}, "application/json")
        client.terminate(token["token"])
        client.disconnect()
        return {"status": "complete", "result": str(result)}
    except Exception as e:
        return {"error": str(e)}
```

## Notes

- The engine starts automatically when VS Code opens a workspace with the RocketRide extension
- Use `client.connect()` before any operations, `client.disconnect()` when done
- `client.use(filepath=...)` loads the pipeline; `client.terminate(token)` cleans it up
- The `send()` method blocks until the pipeline completes

## Built With This Pattern

[Portfolio Brain](https://github.com/josephmccann/portfolio-brain) — financial pattern detection
system built at HackwithBay 2.0 uses this pattern to trigger portfolio cascade pipelines
from FastAPI endpoints after each company analysis.
