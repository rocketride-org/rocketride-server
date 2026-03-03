# RocketRide Common Mistakes & Troubleshooting Guide

A comprehensive guide to avoiding common pitfalls when building RocketRide pipelines and applications.

**Last Updated:** March 3, 2026

---

## Table of Contents

- [Pipeline Configuration Mistakes](#pipeline-configuration-mistakes)
- [SDK Mistakes (Python & TypeScript)](#sdk-mistakes-python--typescript)
- [Blocking the Async Event Loop - CRITICAL](#asynchronous-client)
- [Language-Specific SDK Mistakes](#language-specific-sdk-mistakes)
- [Component Configuration Mistakes](#component-configuration-mistakes)
- [Data Flow Mistakes](#data-flow-mistakes)
- [Engine Extension (Python–C++ Interop)](#engine-extension-python-c-interop)
- [Quick Reference](#quick-reference)

---

## Pipeline Configuration Mistakes

### Mistake 1: Mismatched Response Keys

**Problem:**
```python
# Pipeline has custom laneName
{
  "provider": "response",
  "config": {
    "lanes": [{"laneId": "answers", "laneName": "chat_response"}]
  }
}

# But code expects default key
response = await client.chat(token, question)
answer = response['answers']  # ERROR: KeyError! Key is 'chat_response'
```

**Why This Happens:**
The `response` component's `laneName` parameter changes the JSON key in the response. When you customize it, your client code must match.

**Solution:**
```python
# Match your pipeline configuration
answer = response['chat_response']  # CORRECT: Use custom key from pipeline
```

**Better Solution:**
```python
# Use default response configuration (no custom lanes)
{
  "provider": "response",
  "config": {}  // CORRECT: Use defaults
}

# Then your code works with standard keys
answer = response['answers']  # CORRECT: Works with default config
```

**Rule:** If you customize `laneName` in your pipeline, you MUST update your client code to match. **When in doubt, don't customize - use defaults!**

**Default Key Mappings:**
- `answers` lane → `answers` key
- `text` lane → `text` key
- `documents` lane → `documents` key
- `questions` lane → `questions` key

**Why would you customize the lane name?**
If you are returning mutlitple items from the same lane, you might want to change the names in the results. For example, if you wanted to compare the results from 2 different LLMs, change the lane name on the first LLM to llm_openai, and the second to llm_anthropic. You will then have the results from both LLMs for comparison.

---


### Mistake 2: Using Variable Substitution in project_id

**Problem:**
```json
{
  "pipeline": {
    "project_id": "${ROCKETRIDE_PROJECT_ID}",  // ERROR: Not allowed!
    "source": "chat_1"
  }
}
```

**Why This Happens:**
The `project_id` is read before environment variable substitution occurs. It must be a literal GUID.

**Solution:**
```json
{
  "pipeline": {
    "project_id": "a7f3c2e1-9b4d-4a8e-b1c5-7d6e9f2a8b3c",  // CORRECT: Literal GUID
    "source": "chat_1"
  }
}
```

**Rule:** Always use a unique literal GUID for `project_id`. Never use variables.

**Generate GUIDs:**
- PowerShell: `[guid]::NewGuid().ToString()`
- Linux/Mac: `uuidgen`
- Python: `import uuid; print(uuid.uuid4())`
- Online: https://www.uuidgenerator.net/

---

### Mistake 3: Wrong File Extension

**Problem:**
```bash
my_pipeline.json  # ERROR: Wrong extension
```

**Why This Happens:**
RocketRide looks for `.pipe` files specifically.

**Solution:**
```bash
my_pipeline.pipe  # CORRECT: Correct extension
```

**Rule:** Pipeline files MUST use `.pipe` extension, not just `.json`.

---

### Mistake 4: Invalid source Reference

**Problem:**
```json
{
  "pipeline": {
    "source": "webhook_1",  // References this component
    "components": [
      {
        "id": "webhook_2",  // ERROR: Different ID!
        "provider": "webhook"
      }
    ]
  }
}
```

**Why This Happens:**
The `source` field must reference an actual component ID that exists in the components array.

**Solution:**
```json
{
  "pipeline": {
    "source": "webhook_1",  // CORRECT: Matches component ID
    "components": [
      {
        "id": "webhook_1",  // CORRECT: Same ID
        "provider": "webhook"
      }
    ]
  }
}
```

**Rule:** The `source` field must exactly match the `id` of one component.

---

## SDK Mistakes (Python & TypeScript)

These mistakes apply to both Python and TypeScript SDKs. Examples are shown in both languages.

---

### Mistake 5: Wrong Source Component for Use Case

**Problem:**
```python
# Python: Using webhook for chat
result = await client.use(filepath='webhook_pipeline.json')
response = await client.chat(token, question)  # ERROR: Wrong! Webhook doesn't accept questions
```

```typescript
// TypeScript: Using webhook for chat
const result = await client.use({filepath: 'webhook_pipeline.json'});
const response = await client.chat(token, question);  // ERROR: Wrong!
```

**Why This Happens:**
Different source components expect different input types. The `chat()` method requires a `chat` source component.

**Solution:**
```python
# Python: Use chat source for conversations
result = await client.use(filepath='chat_pipeline.json')  # Pipeline with 'chat' source
response = await client.chat(token, question)  # CORRECT: Correct

# Use webhook source for file uploads
result = await client.use(filepath='webhook_pipeline.json')  # Pipeline with 'webhook' source
response = await client.send_files(files, token)  # CORRECT: Correct
```

```typescript
// TypeScript: Use chat source for conversations
const result = await client.use({filepath: 'chat_pipeline.json'});  // Pipeline with 'chat' source
const response = await client.chat(token, question);  // CORRECT: Correct

// Use webhook source for file uploads
const result2 = await client.use({filepath: 'webhook_pipeline.json'});
const response2 = await client.sendFiles(files, token);  // CORRECT: Correct
```

**Rule:** Match your source component to your operation:

| Pipeline Source | Method (Python) | Method (TypeScript) | Data Type |
|-----------------|-----------------|---------------------|-----------|
| `chat` | `client.chat()` | `client.chat()` | `Question` object |
| `webhook` | `client.send()` | `client.send()` | `str`/`bytes` or `string`/`Buffer` |
| `webhook` | `client.send_files()` | `client.sendFiles()` | File paths array |
| `filesys` | Auto-processed | Auto-processed | N/A (reads from filesystem) |
| `dropper` | `client.send_files()` | `client.sendFiles()` | File paths array |

---

### Mistake 6: Not Checking Response Structure

**Problem:**
```python
response = await client.chat(token, question)
answer = response['answers'][0]  # ERROR: Assumes 'answers' exists and has items
```

**Why This Happens:**
Responses may not always contain the expected keys (especially if you customized `laneName`), or arrays may be empty.

**Solution:**
```python
response = await client.chat(token, question)

# Consult result_types to find actual key names
result_types = response.get('result_types', {})

# Find which key contains 'answers' lane data
answer_key = None
for key, lane_type in result_types.items():
    if lane_type == 'answers':
        answer_key = key
        break

# Use the discovered key
if answer_key and answer_key in response and len(response[answer_key]) > 0:
    answer = response[answer_key][0]
else:
    answer = "No answer received"
```

**Simpler Solution (if you know you're using defaults):**
```python
# Use .get() with defaults
answers = response.get('answers', [])
answer = answers[0] if answers else "No answer received"
```

**Understanding result_types:**

Every response includes a `result_types` field that maps response keys to their lane types:

```python
response = {
    'chat_response': ['The answer...'],  # Actual data
    'result_types': {'chat_response': 'answers'},  # Maps 'chat_response' → 'answers' lane
    'name': 'Question 1',
    'objectId': '...'
}

# result_types tells you:
# - Response key 'chat_response' contains data from 'answers' lane
# - This happens when pipeline has: "laneName": "chat_response"
```

**Best Practice (Python):**
```python
def extract_answer(response: dict) -> str:
    """
    Extract answer from response, regardless of custom lane names.
    """
    # Check result_types to find the answers lane
    result_types = response.get('result_types', {})
    
    # Find key that maps to 'answers' lane
    for key, lane_type in result_types.items():
        if lane_type == 'answers':
            answers = response.get(key, [])
            if answers and len(answers) > 0:
                return answers[0]
    
    # Fallback: try default 'answers' key
    answers = response.get('answers', [])
    return answers[0] if answers else "No answer received"
```

**Best Practice (TypeScript):**
```typescript
function extractAnswer(response: any): string {
  // Check result_types to find the answers lane
  const resultTypes = response.result_types || {};
  
  // Find key that maps to 'answers' lane
  for (const [key, laneType] of Object.entries(resultTypes)) {
    if (laneType === 'answers') {
      const answers = response[key];
      if (answers && answers.length > 0) {
        return answers[0];
      }
    }
  }
  
  // Fallback: try default 'answers' key
  const answers = response.answers || [];
  return answers.length > 0 ? answers[0] : "No answer received";
}
```

**Rule:** 
1. Always consult `result_types` to find actual response key names
2. Never assume the response uses default key names
3. Validate structure before accessing nested keys or array indices

---

### Mistake 7: Using Wrong Method for Pipeline Type

**Problem:**
```python
# Python: Chat pipeline but using send()
response = await client.send(token, "Hello")  # ERROR: Chat source expects Question objects
```

```typescript
// TypeScript: Chat pipeline but using send()
const response = await client.send(token, "Hello");  // ERROR: Chat source expects Question objects
```

**Why This Happens:**
The `send()` method is for raw data (webhook/dropper sources), not for conversational interfaces.

**Solution:**
```python
# Python: Use the correct method for your pipeline source
from rocketride.schema import Question

question = Question()
question.addQuestion("Hello")
response = await client.chat(token, question)  # CORRECT: Correct for chat source
```

```typescript
// TypeScript: Use the correct method for your pipeline source
import { Question } from 'rocketride';

const question = new Question();
question.addQuestion("Hello");
const response = await client.chat(token, question);  // CORRECT: Correct for chat source
```

**Rule:** 
- Use `chat()` for ALL conversational interfaces (web, console, API, mobile)
- Use `send()` / `sendFiles()` for document processing and file uploads

---

### Mistake 8: Not Cleaning Up Resources

**Problem:**
```python
# Python: Forgot to disconnect
client = RocketRideClient()  # Configuration from .env
await client.connect()
result = await client.use(filepath='pipeline.json')
# ... do stuff ...
# ERROR: Forgot to disconnect!
```

```typescript
// TypeScript: Forgot to disconnect
const client = new RocketRideClient();  // Configuration from .env
await client.connect();
const result = await client.use({filepath: 'pipeline.json'});
// ... do stuff ...
// ERROR: Forgot to disconnect!
```

**Why This Happens:**
Manual resource management is error-prone. If an exception occurs, the connection may not close.

**Solution (Python - use context manager):**
```python
# Use async context manager for automatic cleanup
async with RocketRideClient() as client:  # Configuration from .env
    result = await client.use(filepath='pipeline.json')
    # ... do stuff ...
    # CORRECT: Automatically disconnects, even on exceptions
```

**Solution (TypeScript - use try/finally):**
```typescript
// Use try/finally for proper cleanup
const client = new RocketRideClient();  // Configuration from .env
try {
  await client.connect();
  const result = await client.use({filepath: 'pipeline.json'});
  // ... do stuff ...
} finally {
  await client.disconnect();  // CORRECT: Always disconnects
}
```

**Rule:** 
- **Python**: Use `async with` context managers
- **TypeScript**: Use try/finally blocks to ensure disconnect

---

### Mistake 9: Starting Pipeline for Every Request

**Problem:**
```python
# Python: Starting pipeline every time
async def ask_question(question_text):
    client = RocketRideClient()  # Configuration from .env
    await client.connect()
    result = await client.use(filepath='chat.pipe')  # ERROR: Slow! Pipeline starts every time
    token = result['token']
    
    question = Question()
    question.addQuestion(question_text)
    response = await client.chat(token, question)
    
    await client.disconnect()
    return response
```

```typescript
// TypeScript: Starting pipeline every time
async function askQuestion(questionText: string) {
  const client = new RocketRideClient();  // Configuration from .env
  await client.connect();
  const result = await client.use({filepath: 'chat.pipe'});  // ERROR: Slow!
  const token = result.token;
  
  const question = new Question();
  question.addQuestion(questionText);
  const response = await client.chat(token, question);
  
  await client.disconnect();
  return response;
}
```

**Why This Happens:**
Starting a pipeline is time-consuming. Starting it for every request is inefficient.

**Solution (Python):**
```python
# Start pipeline ONCE at application startup
client = RocketRideClient()  # Configuration from .env
await client.connect()
result = await client.use(filepath='chat.pipe')  # CORRECT: Start once
token = result['token']

async def ask_question(question_text):
    # Just use the existing pipeline
    question = Question()
    question.addQuestion(question_text)
    response = await client.chat(token, question)  # CORRECT: Reuse token
    return response

# Ask many questions
answer1 = await ask_question("What is AI?")
answer2 = await ask_question("Tell me more")

# Disconnect when done
await client.disconnect()
```

**Solution (TypeScript):**
```typescript
// Start pipeline ONCE at application startup
const client = new RocketRideClient();  // Configuration from .env
await client.connect();
const result = await client.use({filepath: 'chat.pipe'});  // CORRECT: Start once
const token = result.token;

async function askQuestion(questionText: string) {
  // Just use the existing pipeline
  const question = new Question();
  question.addQuestion(questionText);
  const response = await client.chat(token, question);  // CORRECT: Reuse token
  return response;
}

// Ask many questions
const answer1 = await askQuestion("What is AI?");
const answer2 = await askQuestion("Tell me more");

// Disconnect when done
await client.disconnect();
```

**Rule:** Start pipelines once, use them many times. Only disconnect when completely done.

---

### Mistake 10: "Pipeline Already Running" Error

**Problem:**
```python
# Python: Calling use() when pipeline already running
result1 = await client.use(filepath='chat.pipe')
token = result1['token']

# Later, trying to start again...
result2 = await client.use(filepath='chat.pipe')  # ERROR: Error: Pipeline already running!
```

```typescript
// TypeScript: Calling use() when pipeline already running
const result1 = await client.use({filepath: 'chat.pipe'});
const token = result1.token;

// Later, trying to start again...
const result2 = await client.use({filepath: 'chat.pipe'});  // ERROR: Error: Pipeline already running!
```

**Why This Happens:**
Each pipeline instance can only run once at a time. By default, `use()` will throw an error if the pipeline is already running.

**Understanding `use_existing` parameter:**

| Parameter | Pipeline Status | Behavior |
|-----------|----------------|----------|
| `use_existing=False` (default) | Not running | YES: Starts pipeline, returns token |
| `use_existing=False` (default) | Already running | NO: **ERROR**: "Pipeline already running" |
| `use_existing=True` | Not running | YES: Starts pipeline, returns token |
| `use_existing=True` | Already running | YES: **Reuses** existing pipeline, returns token |

**Solution 1: Use `use_existing=True` (Recommended for most cases)**
```python
# Python: Use use_existing parameter
result = await client.use(filepath='chat.pipe', use_existing=True)
token = result['token']

# If pipeline is running → reuses it, returns token, NO ERROR
# If pipeline is NOT running → starts it, returns token, NO ERROR
result2 = await client.use(filepath='chat.pipe', use_existing=True)  # CORRECT: Always works!
```

```typescript
// TypeScript: Use useExisting parameter
const result = await client.use({filepath: 'chat.pipe', useExisting: true});
const token = result.token;

// If pipeline is running → reuses it, returns token, NO ERROR
// If pipeline is NOT running → starts it, returns token, NO ERROR
const result2 = await client.use({filepath: 'chat.pipe', useExisting: true});  // CORRECT: Always works!
```

**Solution 2: Terminate before restarting (when you need fresh start)**
```python
# Python: Stop the old pipeline first (use_existing=False is default)
result1 = await client.use(filepath='chat.pipe')  # use_existing defaults to False
token1 = result1['token']

# ... use pipeline ...

# If you try to call use() again without terminating:
# result2 = await client.use(filepath='chat.pipe')  # ERROR: ERROR: Pipeline already running!

# Instead, stop it before starting again:
await client.terminate(token1)  # CORRECT: Stop the old one
result2 = await client.use(filepath='chat.pipe')  # CORRECT: Now you can start fresh (not running anymore)
token2 = result2['token']
```

```typescript
// TypeScript: Stop the old pipeline first (useExisting=false is default)
const result1 = await client.use({filepath: 'chat.pipe'});  // useExisting defaults to false
const token1 = result1.token;

// ... use pipeline ...

// If you try to call use() again without terminating:
// const result2 = await client.use({filepath: 'chat.pipe'});  // ERROR: ERROR: Pipeline already running!

// Instead, stop it before starting again:
await client.terminate(token1);  // CORRECT: Stop the old one
const result2 = await client.use({filepath: 'chat.pipe'});  // CORRECT: Now you can start fresh (not running anymore)
const token2 = result2.token;
```

**Best Practice (Simple):**
```python
# Python: Just use use_existing=True - handles both cases automatically!
async def get_or_start_pipeline(client, filepath):
    """
    Get existing pipeline or start a new one.
    No need for try/catch - use_existing handles both cases.
    """
    result = await client.use(filepath=filepath, use_existing=True)
    return result['token']  # Always works, never errors
```

```typescript
// TypeScript: Just use useExisting=true - handles both cases automatically!
async function getOrStartPipeline(client: RocketRideClient, filepath: string): Promise<string> {
  // No need for try/catch - useExisting handles both cases
  const result = await client.use({filepath, useExisting: true});
  return result.token;  // Always works, never errors
}
```

**When to Use Each Approach:**

| Scenario | Use `use_existing=True` | Use `terminate()` first |
|----------|------------------------|------------------------|
| Long-running service | YES: Yes - reuse pipeline | NO: No - unnecessary restart |
| Testing/development | YES: Yes - quick iteration | YES: Yes - clean state each test |
| Pipeline config changed | NO: No - won't pick up changes | YES: Yes - restart with new config |
| Error recovery | NO: No - might reuse broken state | YES: Yes - fresh start |
| First-time start | YES: Yes - starts if not running | YES: Yes - starts fresh |

**Development Tip - RocketRide VSCode Extension:**

If you're using the **RocketRide VSCode extension** for development, you can configure it to handle pipeline restarts automatically:

- **Auto-restart on file change**: When you save changes to a `.pipe` file, the extension can automatically terminate and restart the pipeline with your latest changes
- **Prompt to restart**: Or configure it to prompt you to restart when changes are detected
- **Manual restart**: Use the extension's UI to quickly restart pipelines during development

This eliminates the need to manually call `terminate()` + `use()` during iterative development!

**To enable:**
1. Open RocketRide extension settings in VSCode
2. Look for "Auto-restart on Pipeline Change" or similar setting
3. Choose your preferred behavior (auto/prompt/manual)

This is especially useful during development when you're frequently tweaking pipeline configurations.

---

**Rule:** 
1. **Default behavior** (`use_existing=False` or omitted): 
   - Starts pipeline if NOT running
   - Throws error if already running
2. **With `use_existing=True`**: 
   - Starts pipeline if NOT running
   - Reuses pipeline if already running
   - Never errors due to "already running"
3. **Production services**: Always use `use_existing=True` to avoid errors
4. **Development with VSCode Extension**: Let extension handle restarts automatically
5. **Development without Extension**: Use `terminate()` then `use()` when you need to pick up config changes
6. **When in doubt**: Use `use_existing=True` - it's safer and handles both cases

---

### Mistake 11: Incorrect Environment Variable Prefix

**Problem:**
```env
# .env file
OPENAI_KEY=sk-...
QDRANT_HOST=localhost
```

```json
{
  "config": {
    "apikey": "${OPENAI_KEY}"  // ERROR: Won't substitute!
  }
}
```

**Why This Happens:**
RocketRide only substitutes variables starting with `ROCKETRIDE_` prefix for security.

**Solution:**
```env
# .env file
ROCKETRIDE_OPENAI_KEY=sk-...  // CORRECT: Has ROCKETRIDE_ prefix
ROCKETRIDE_QDRANT_HOST=localhost
```

```json
{
  "config": {
    "apikey": "${ROCKETRIDE_OPENAI_KEY}"  // CORRECT: Will substitute
  }
}
```

**Rule:** All environment variables for pipelines must start with `ROCKETRIDE_`.

---


## Asynchronous client

### Mistake 12: Blocking the Async Event Loop - CRITICAL

**This is one of the most critical mistakes that causes websocket connection timeouts and failures!**

**Problem:**
```python
# Python: Blocking the event loop with synchronous input()
async def chat_loop():
    while True:
        user_input = input("You: ")  # ERROR: BLOCKS the entire event loop!
        response = await client.chat(token, question)
        print(response)
```

```typescript
// TypeScript: Blocking with synchronous readline
import * as readline from 'readline';

async function chatLoop() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  rl.question('You: ', async (userInput) => {  // ERROR: BLOCKS event loop!
    const response = await client.chat(token, question);
    console.log(response);
  });
}
```

**Why This Happens:**

The RocketRide client uses websockets for communication. Websockets require periodic **ping/pong keepalive messages** to maintain the connection. These messages are processed by the async event loop.

When you use blocking operations like `input()` (Python) or synchronous readline (TypeScript/Node.js):
1. The blocking call **freezes the main thread**
2. The event loop **cannot process any other tasks**
3. Websocket ping/pong messages **cannot be sent/received**
4. After ~60 seconds of no ping/pong, the connection **times out and closes**
5. Your application fails with "Connection closed" or "Connection timeout" errors

**Solution (Python):**

Use `asyncio.run_in_executor()` to run blocking I/O in a separate thread:

```python
# Python: Non-blocking async input
import asyncio
from concurrent.futures import ThreadPoolExecutor

# Create a thread pool for blocking I/O
_input_executor = ThreadPoolExecutor(max_workers=1)

async def async_input(prompt: str = "") -> str:
    """
    Non-blocking async input that doesn't block the event loop.
    This allows websocket ping/pong keepalive to work properly.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_input_executor, input, prompt)

# Use it in your async code
async def chat_loop():
    client = RocketRideClient()  # Configuration from .env
    await client.connect()
    
    result = await client.use(filepath='chat.pipe')
    token = result['token']
    
    while True:
        # CORRECT: Non-blocking input - event loop stays responsive
        user_input = await async_input("You: ")
        
        if user_input.lower() == 'quit':
            break
        
        question = Question()
        question.addQuestion(user_input)
        
        # Event loop can process websocket messages while waiting
        response = await client.chat(token, question)
        print(f"Bot: {response['answers'][0]}")
    
    await client.disconnect()
```

**Solution (TypeScript/Node.js):**

Use `readline/promises` (Node.js 17+) or promisify readline:

```typescript
// TypeScript: Non-blocking async input (Node.js 17+)
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

async function chatLoop() {
  const client = new RocketRideClient();  // Configuration from .env
  await client.connect();
  
  const result = await client.use({filepath: 'chat.pipe'});
  const token = result.token;
  
  // Create readline interface with promises
  const rl = readline.createInterface({ input, output });
  
  while (true) {
    // CORRECT: Non-blocking async input - event loop stays responsive
    const userInput = await rl.question('You: ');
    
    if (userInput.toLowerCase() === 'quit') {
      break;
    }
    
    const question = new Question();
    question.addQuestion(userInput);
    
    // Event loop can process websocket messages while waiting
    const response = await client.chat(token, question);
    console.log(`Bot: ${response.answers[0]}`);
  }
  
  rl.close();
  await client.disconnect();
}
```

**For older Node.js versions (<17), promisify readline:**

```typescript
// TypeScript: Non-blocking input for Node.js < 17
import * as readline from 'readline';
import { promisify } from 'util';

function createAsyncQuestion(rl: readline.Interface) {
  return promisify((prompt: string, callback: (answer: string) => void) => {
    rl.question(prompt, callback);
  });
}

async function chatLoop() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const askQuestion = createAsyncQuestion(rl);
  
  while (true) {
    // CORRECT: Non-blocking async input
    const userInput = await askQuestion('You: ');
    
    // ... rest of code
  }
}
```

**Other Common Blocking Operations to Avoid:**

Both Python and TypeScript/Node.js have other blocking operations that must be avoided in async code:

**Python:**
```python
# ERROR: BLOCKING - Don't use these in async functions
time.sleep(5)           # Use: await asyncio.sleep(5)
open('file.txt').read() # Use: async with aiofiles.open('file.txt') as f
requests.get(url)       # Use: async with aiohttp.ClientSession()
```

**TypeScript:**
```typescript
// ERROR: BLOCKING - Don't use these in async functions
fs.readFileSync('file.txt')     // Use: await fs.promises.readFile()
child_process.execSync('cmd')   // Use: await promisify(exec)()
crypto.pbkdf2Sync()            // Use: await promisify(crypto.pbkdf2)()
```

**Testing the Fix:**

To verify your fix works:

1. Start your application
2. Let it sit idle at the input prompt for **60+ seconds**
3. Type a message and press Enter
4. If the message is processed successfully, the fix works!
5. If you get "Connection closed" or "Connection timeout", the event loop is still being blocked

**Rule (Critical):**

1. **NEVER use blocking I/O** in async functions (input(), readFileSync(), etc.)
2. **ALWAYS use async alternatives** (async_input(), readline/promises, aiofiles, etc.)
3. **Event loop must stay responsive** to process websocket keepalive messages
4. **Test with idle periods** to ensure connections stay alive
5. **Use ThreadPoolExecutor/promisify** for unavoidable blocking operations

**Why This Matters:**

- **WARNING: Websocket connections will timeout** after ~60 seconds of blocked event loop
- **WARNING: Application will fail** with cryptic "Connection closed" errors
- **WARNING: Hard to debug** - symptoms appear after idle periods, not immediately
- **WARNING: Production critical** - affects real-world usage where users pause between inputs

**Symptoms of Event Loop Blocking:**

- Connection works fine initially
- Failures occur after idle periods (30-60 seconds)
- Error messages like "Connection closed", "Connection timeout", "Websocket closed unexpectedly"
- Works fine when constantly sending messages (no idle time)
- Ping/pong messages stop appearing in debug logs

---

## Language-Specific SDK Mistakes

### TypeScript: Not Handling Promises Properly

**Problem:**
```typescript
// Missing await
const response = client.chat(token, question);  // ERROR: Returns Promise, not result
const answer = response.answers[0];  // ERROR: Error!
```

**Why This Happens:**
All RocketRide SDK methods are async and return Promises.

**Solution:**
```typescript
// Use await
const response = await client.chat(token, question);  // CORRECT: Awaits Promise
const answer = response.answers?.[0] ?? "No answer";  // CORRECT: Safe access
```

**Rule:** Always `await` SDK method calls or use `.then()`.

---

### TypeScript: Not Checking for Undefined

**Problem:**
```typescript
const response = await client.chat(token, question);
const answer = response.answers[0];  // ERROR: May be undefined
```

**Why This Happens:**
TypeScript doesn't prevent runtime undefined access.

**Solution:**
```typescript
const response = await client.chat(token, question);
const answer = response.answers?.[0] ?? "No answer received";  // CORRECT: Safe
```

**Rule:** Use optional chaining (`?.`) and nullish coalescing (`??`) for safe access.

---

## Component Configuration Mistakes

### Mistake 13: Mismatched Lane Types

**Problem:**
```json
{
  "id": "preprocessor_1",
  "provider": "preprocessor_langchain",
  "input": [
    {
      "lane": "tags",  // ERROR: Preprocessor expects 'text', not 'tags'
      "from": "webhook_1"
    }
  ]
}
```

**Why This Happens:**
Each component accepts specific lane types. Check the component reference for supported lanes.

**Solution:**
```json
// Add parser between webhook and preprocessor
{
  "id": "parser_1",
  "provider": "parse",
  "input": [{"lane": "tags", "from": "webhook_1"}]  // CORRECT: tags → text
},
{
  "id": "preprocessor_1",
  "provider": "preprocessor_langchain",
  "input": [{"lane": "text", "from": "parser_1"}]  // CORRECT: text input
}
```

**Common Lane Flows:**
- `tags` → `parse` → `text`
- `text` → `preprocessor` → `documents`
- `documents` → `embedding` → `documents` (with vectors)
- `questions` → `llm` → `answers`

**Rule:** Check component reference for supported input/output lanes.

---

### Mistake 14: Missing Required Configuration

**Problem:**
```json
{
  "id": "llm_1",
  "provider": "llm_openai",
  "config": {}  // ERROR: Missing API key!
}
```

**Why This Happens:**
Many components require specific configuration (API keys, hosts, models, etc.).

**Solution:**
```json
{
  "id": "llm_1",
  "provider": "llm_openai",
  "config": {
    "profile": "openai-5",
    "openai-5": {
      "apikey": "${ROCKETRIDE_OPENAI_KEY}",  // CORRECT: Required
      "model": "gpt-4-turbo",
      "modelTotalTokens": 16384
    }
  }
}
```

**Rule:** Always check component reference for required configuration fields.

---

### Mistake 15: Wrong Component for Use Case

**Problem:**
```json
// Using 'question' component in chat pipeline
{
  "id": "question_1",
  "provider": "question",  // ERROR: Converts text to questions, not needed in chat
  "input": [{"lane": "questions", "from": "chat_1"}]
}
```

**Why This Happens:**
The `question` component converts TEXT to questions. The `chat` source already produces questions.

**Solution:**
```json
// Connect chat directly to next step
{
  "id": "embedding_1",
  "provider": "embedding_transformer",
  "input": [{"lane": "questions", "from": "chat_1"}]  // CORRECT: Direct connection
}
```

**Rule:** 
- `question` component: TEXT → QUESTIONS (for webhooks with text input)
- `chat` component: Already produces QUESTIONS (no conversion needed)

---

## Data Flow Mistakes

### Mistake 16: Missing Input Connections

**Problem:**
```json
{
  "id": "response_1",
  "provider": "response",
  "config": {},
  // ERROR: No input array! Where does data come from?
}
```

**Why This Happens:**
Non-source components need an `input` array to receive data from other components.

**Solution:**
```json
{
  "id": "response_1",
  "provider": "response",
  "config": {},
  "input": [
    {"lane": "answers", "from": "llm_1"}  // CORRECT: Receives answers from LLM
  ]
}
```

**Exception:** Source components (webhook, chat, filesys) don't need input arrays - they're entry points.

**Rule:** All non-source components must have an `input` array.

---

### Mistake 17: Circular Dependencies

**Problem:**
```json
{
  "id": "comp_a",
  "input": [{"lane": "text", "from": "comp_b"}]
},
{
  "id": "comp_b",
  "input": [{"lane": "text", "from": "comp_a"}]  // ERROR: Circular!
}
```

**Why This Happens:**
Components reference each other in a loop.

**Solution:**
```json
// Linear flow: source → comp_a → comp_b
{
  "id": "comp_a",
  "input": [{"lane": "tags", "from": "source_1"}]  // CORRECT: From source
},
{
  "id": "comp_b",
  "input": [{"lane": "text", "from": "comp_a"}]  // CORRECT: From comp_a
}
```

**Rule:** Data flow must be acyclic (no loops).

---

### Mistake 18: Orphaned Components

**Problem:**
```json
{
  "pipeline": {
    "source": "webhook_1",
    "components": [
      {"id": "webhook_1", "provider": "webhook"},
      {"id": "parse_1", "provider": "parse", "input": [{"lane": "tags", "from": "webhook_1"}]},
      {"id": "llm_1", "provider": "llm_openai"}  // ERROR: No input! Orphaned
    ]
  }
}
```

**Why This Happens:**
Component exists but isn't connected to the data flow.

**Solution:**
```json
// Connect all components
{
  "id": "llm_1",
  "provider": "llm_openai",
  "input": [{"lane": "questions", "from": "chat_1"}]  // CORRECT: Connected
}
```

**Rule:** Every non-source component should be reachable from the source component.

---

## Engine Extension (Python–C++ Interop)

### Mistake 19: Passing Raw Pydantic Models to C++ JSON Utilities

**Applies to:** Code extending the engine (custom nodes, filter callbacks) that passes Python objects to C++ JSON helpers.

**Problem:**
```python
# Custom node or filter callback - passing Pydantic BaseModel directly
from rocketride.schema import Question

question = Question()
# ...
dictToJson(question)  # ERROR: C++ engine crash (pyjson.hpp)
```

**Why This Happens:**
The C++ engine's JSON utilities expect plain Python dicts. Pydantic `BaseModel` instances are not directly serializable by the engine's `dictToJson` and similar functions—passing them causes a crash.

**Solution:**
```python
# Convert to plain dict before passing to C++ JSON utilities
dictToJson(question.model_dump())  # CORRECT
```

**Rule:** When passing Pydantic models (`Question`, `Answer`, `IInvokeLLM`, `IInvokeTool`, etc.) to the engine's JSON serialization layer, always call `.model_dump()` first to convert them to plain dicts.

---

## Quick Reference

### Pipeline Checklist

- [ ] File named `*.pipe` (not just `.json`)
- [ ] `project_id` is a literal GUID (not a variable)
- [ ] `source` matches an actual component ID
- [ ] All component IDs are unique
- [ ] All non-source components have `input` arrays
- [ ] Lane types match between connected components
- [ ] No circular dependencies
- [ ] No orphaned components
- [ ] API keys use `${ROCKETRIDE_*}` variables

### Code Checklist

- [ ] **NEVER block the event loop** with synchronous I/O (input(), readFileSync(), etc.)
- [ ] **Use async alternatives** for all blocking operations (async_input(), readline/promises, etc.)
- [ ] Use `async with` for client (context manager)
- [ ] Match source type to method (`chat` → `chat()`, `webhook` → `send()`)
- [ ] Check response structure before accessing
- [ ] Start pipeline once, use many times
- [ ] Response keys match pipeline `laneName` configuration
- [ ] Environment variables have `ROCKETRIDE_` prefix
- [ ] Handle exceptions appropriately

### Component Selection

| Need | Source | Method |
|------|--------|--------|
| Chat/Q&A | `chat` | `client.chat()` |
| File upload | `webhook` | `client.send_files()` |
| Data upload | `webhook` | `client.send()` |
| Local files | `filesys` | Auto-processed |
| Drag & drop | `dropper` | `client.send_files()` |

### Response Key Mappings

| Pipeline Config | Response Key |
|-----------------|--------------|
| `config: {}` (default) | `answers`, `text`, `documents` (standard) |
| `laneName: "custom"` | `custom` (YOUR custom name) |

**Rule:** Pipeline and code must match!

---

## Still Having Issues?

### Debug Steps

1. **Check logs** - Look for error messages
2. **Verify .env** - Ensure all `ROCKETRIDE_*` variables are set
3. **Validate pipeline** - Use JSON validator
4. **Check services** - Ensure external services (Qdrant, etc.) are running
5. **Test incrementally** - Build pipeline component by component
6. **Review component reference** - Verify supported lanes and configuration

### Common Error Messages

| Error | Likely Cause | Solution |
|-------|--------------|----------|
| `Connection closed` / `Connection timeout` | **Event loop blocked** | **Use async_input() or readline/promises** |
| `Websocket closed unexpectedly` | **Event loop blocked** | **Never use blocking I/O in async code** |
| `KeyError: 'answers'` | Response key mismatch | Check pipeline `laneName` config |
| `Pipeline already running` | Called `use()` twice | Use `use_existing=True` or `terminate()` first |
| `Component not found` | Invalid provider name | Check spelling against reference |
| `Lane not supported` | Wrong lane type | Check component's supported lanes |
| `Connection refused` | Service not running | Start required services |
| `Invalid API key` | Wrong/missing API key | Check `.env` file |
| `project_id must be a GUID` | Using variable | Use literal GUID |

---

## Additional Resources

- **Component Reference**: `ROCKETRIDE_COMPONENT_REFERENCE.md`
- **Pipeline Rules**: `ROCKETRIDE_PIPELINE_RULES.md`
- **Python API**: `ROCKETRIDE_python_API.md`
- **TypeScript API**: `ROCKETRIDE_typescript_API.md`
- **Platform Overview**: `ROCKETRIDE_README.md`

---

**Remember:** When in doubt, use default configurations and follow documentation examples!

