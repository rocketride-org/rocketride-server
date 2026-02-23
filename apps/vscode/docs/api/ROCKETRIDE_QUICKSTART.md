# RocketRide Quick Start - Complete Working Examples

## Python: Complete Working Project

### Step 1: Check `.env` File (Auto-Created)
The RocketRide extension automatically creates/updates `.env` with your configured settings:
```env
# Auto-populated from extension settings (rocketride.hostUrl and API key)
ROCKETRIDE_URI=https://cloud.rocketride.ai  # Your configured server
ROCKETRIDE_APIKEY=your-api-key-here     # From extension settings

# Add your custom variables:
ROCKETRIDE_INPUT_PATH=/data/input
ROCKETRIDE_OUTPUT_PATH=/data/output
```

> **Note:** `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY` are automatically synced from your extension settings. You can add additional custom variables as needed.

### Step 2: Install Client
```bash
# Use the server URL from your .env file (ROCKETRIDE_URI)
pip install ${ROCKETRIDE_URI}/client/python/rocketride-latest-py3-none-any.whl

# Or directly:
pip install https://cloud.rocketride.ai/client/python/rocketride-latest-py3-none-any.whl
```

### Step 3: Create Pipeline (`pipeline.json`)
```json
{
  "pipeline": {
    "project_id": "85be2a13-ad93-49ed-a1e1-4b0f763ca618",
    "source": "input",
    "components": [
      {
        "id": "input",
        "provider": "webhook",
        "config": {}
      },
      {
        "id": "processor",
        "provider": "transform",
        "config": {
          "input_path": "${ROCKETRIDE_INPUT_PATH}",
          "output_path": "${ROCKETRIDE_OUTPUT_PATH}"
        }
      },
      {
        "id": "output",
        "provider": "response",
        "config": {}
      }
    ]
  }
}
```

### Step 4: Create Python Script (`main.py`)
```python
import asyncio
from rocketride import RocketRideClient

async def main():
    # Client reads configuration from .env automatically
    client = RocketRideClient()
    
    try:
        # Connect to server
        await client.connect()
        print("✓ Connected to RocketRide server")
        
        # Start pipeline
        result = await client.use(filepath='pipeline.json')
        token = result['token']
        print(f"✓ Pipeline started with token: {token}")
        
        # Send data
        await client.send(token, "Hello, RocketRide!")
        print("✓ Data sent successfully")
        
        # Check status
        status = await client.get_task_status(token)
        print(f"✓ Pipeline state: {status['state']}")
        
    finally:
        # Always disconnect
        await client.disconnect()
        print("✓ Disconnected")

if __name__ == "__main__":
    asyncio.run(main())
```

### Step 5: Run
```bash
python main.py
```

---

## TypeScript: Complete Working Project

### Step 1: Check `.env` File (Auto-Created)
The RocketRide extension automatically creates/updates `.env` with your configured settings:
```env
# Auto-populated from extension settings (rocketride.hostUrl and API key)
ROCKETRIDE_URI=https://cloud.rocketride.ai  # Your configured server
ROCKETRIDE_APIKEY=your-api-key-here     # From extension settings

# Add your custom variables:
ROCKETRIDE_INPUT_PATH=/data/input
ROCKETRIDE_OUTPUT_PATH=/data/output
```

> **Note:** `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY` are automatically synced from your extension settings. You can add additional custom variables as needed.

### Step 2: Install Client
```bash
# Use the server URL from your .env file (ROCKETRIDE_URI)
npm install ${ROCKETRIDE_URI}/client/typescript

# Or directly:
npm install https://cloud.rocketride.ai/client/typescript
```

### Step 3: Create Pipeline (`pipeline.json`)
```json
{
  "pipeline": {
    "project_id": "85be2a13-ad93-49ed-a1e1-4b0f763ca618",
    "source": "input",
    "components": [
      {
        "id": "input",
        "provider": "webhook",
        "config": {}
      },
      {
        "id": "processor",
        "provider": "transform",
        "config": {
          "input_path": "${ROCKETRIDE_INPUT_PATH}",
          "output_path": "${ROCKETRIDE_OUTPUT_PATH}"
        }
      },
      {
        "id": "output",
        "provider": "response",
        "config": {}
      }
    ]
  }
}
```

### Step 4: Create TypeScript Script (`main.ts`)
```typescript
import { RocketRideClient } from '@rocketride/client-typescript';

async function main() {
  // Client reads configuration from .env automatically
  const client = new RocketRideClient();
  
  try {
    // Connect to server
    await client.connect();
    console.log('✓ Connected to RocketRide server');
    
    // Start pipeline
    const result = await client.use({ filepath: 'pipeline.json' });
    const token = result.token;
    console.log(`✓ Pipeline started with token: ${token}`);
    
    // Send data
    await client.send(token, 'Hello, RocketRide!');
    console.log('✓ Data sent successfully');
    
    // Check status
    const status = await client.getTaskStatus(token);
    console.log(`✓ Pipeline state: ${status.state}`);
    
  } finally {
    // Always disconnect
    await client.disconnect();
    console.log('✓ Disconnected');
  }
}

main().catch(console.error);
```

### Step 5: Run
```bash
npx tsx main.ts
```

---

## Key Patterns to Remember

### Always Do This:
1. Configure server URL in extension settings (`rocketride.hostUrl` and API key)
2. Extension auto-creates/updates `.env` with `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY`
3. Use empty constructor: `RocketRideClient()` or `new RocketRideClient()`
4. Use literal GUID for `project_id`
5. Use `${ROCKETRIDE_*}` variables in component `config` fields
6. Always `connect()` before use, `disconnect()` after

### Never Do This:
1. Hardcode `uri` or `auth` in constructor (use `.env` instead)
2. Use variables in `project_id` field (must be literal GUID)
3. Manually edit `ROCKETRIDE_URI` or `ROCKETRIDE_APIKEY` in `.env` (use extension settings)
4. Skip `connect()` or `disconnect()`
5. Use non-ROCKETRIDE_* variables in pipelines

---

## Complete Project Structure

```
my-rocketride-project/
├── .env                    # Configuration (MUST have)
├── pipeline.json           # Pipeline definition
├── main.py or main.ts      # Your code
└── package.json            # (TypeScript only)
```

---

Copy these examples exactly. They are guaranteed to work.

