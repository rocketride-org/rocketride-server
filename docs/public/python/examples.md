---
title: Examples
sidebar_position: 11
---

# Examples

Complete, runnable programs covering the SDK surface end to end. For pipeline-level
examples, see the site-wide examples —
[RAG pipeline](/examples/rag-pipeline), [webhook pipeline](/examples/webhook-pipeline), and [document extraction](/examples/document-extraction).

## 1. Minimal: connect, run pipeline from file, send one string, disconnect

```python
import asyncio
from rocketride import RocketRideClient


async def main():
    client = RocketRideClient(uri='https://api.rocketride.ai', auth='my-key')
    await client.connect()
    result = await client.use(filepath='pipeline.pipe')
    token = result['token']
    out = await client.send(token, 'Hello, pipeline!', objinfo={'name': 'input.txt'}, mimetype='text/plain')
    print(out)
    await client.terminate(token)
    await client.disconnect()


asyncio.run(main())
```

## 2. One-off script with context manager (recommended)

```python
import asyncio
from rocketride import RocketRideClient


my_pipeline_config = {'components': []}  # your pipeline dict, e.g. json.load(open('pipeline.pipe'))


async def main():
    async with RocketRideClient(uri='wss://api.rocketride.ai', auth='my-key') as client:
        result = await client.use(pipeline=my_pipeline_config)
        token = result['token']
        await client.send(token, '{"data": 1}')
        status = await client.get_task_status(token)
        print(status)
        await client.terminate(token)


asyncio.run(main())
```

## 3. Long-lived app: persist mode, callbacks, and status handling

Lifecycle callbacks are awaited, so pass `async` functions:

```python
import asyncio
from rocketride import RocketRideClient


async def on_connected(info):
    print('Connected:', info)


async def on_disconnected(reason, has_error):
    # Do not call disconnect() here if you want auto-reconnect.
    print('Disconnected:', reason, has_error)


async def on_connect_error(msg):
    print('Connect error:', msg)


async def on_event(e):
    print(e.get('event'), e.get('body'))


async def main():
    client = RocketRideClient(
        uri='https://api.rocketride.ai',
        auth='my-key',
        persist=True,
        on_connected=on_connected,
        on_disconnected=on_disconnected,
        on_connect_error=on_connect_error,
        on_event=on_event,
    )
    await client.connect()
    # Later: use(), send_files(), etc. If the connection drops, the client
    # retries forever (linear backoff) — except on auth failure.


asyncio.run(main())
```

## 4. Upload multiple files and poll until pipeline completes

```python
import asyncio
from rocketride import RocketRideClient


async def main():
    client = RocketRideClient(uri='https://api.rocketride.ai', auth='my-key')
    await client.connect()
    result = await client.use(filepath='vectorize.pipe')
    token = result['token']
    await client.set_events(token, ['apaevt_status_upload', 'apaevt_status_processing'])

    files = ['doc1.md', 'doc2.md', ('doc3.json', {'tag': 'export'}, 'application/json')]
    upload_results = await client.send_files(files, token)
    for r in upload_results:
        if r['action'] == 'complete':
            print('OK', r['filepath'])
        else:
            print('Failed', r['filepath'], r.get('error'))

    while True:
        status = await client.get_task_status(token)
        print(f'Progress: {status.get("completedCount", 0)}/{status.get("totalCount", 0)}')
        if status.get('completed'):
            break
        await asyncio.sleep(2)
    await client.terminate(token)
    await client.disconnect()


asyncio.run(main())
```

## 5. Streaming large data with a pipe

```python
import asyncio
from rocketride import RocketRideClient


async def main():
    async with RocketRideClient(uri='https://api.rocketride.ai', auth='my-key') as client:
        result = await client.use(filepath='ingest.pipe')
        token = result['token']
        pipe = await client.pipe(token, objinfo={'name': 'large.csv'}, mime_type='text/csv')
        await pipe.open()
        with open('large.csv', 'rb') as f:
            while True:
                chunk = f.read(64 * 1024)
                if not chunk:
                    break
                await pipe.write(chunk)
        result = await pipe.close()
        print(result)
        await client.terminate(token)


asyncio.run(main())
```

## 6. Chat: question with instructions and examples, parse JSON answer

```python
import asyncio
from rocketride import RocketRideClient
from rocketride.schema import Question, Answer


async def main():
    async with RocketRideClient(uri='https://api.rocketride.ai', auth='my-key') as client:
        result = await client.use(filepath='chat_pipeline.pipe')
        token = result['token']
        question = Question(expectJson=True)
        question.addInstruction('Format', 'Return a JSON object with keys: summary, keywords.')
        question.addExample('Summarize X', {'summary': '...', 'keywords': ['a', 'b']})
        question.addQuestion('Summarize the main points and list keywords.')
        response = await client.chat(token=token, question=question)
        answer_text = (response.get('answers') or [None])[0]
        answer = Answer(expectJson=True)
        answer.setAnswer(answer_text or '')
        if answer.isJson():
            structured = answer.getJson()
        else:
            structured = answer.getText()
        print(structured)
        await client.terminate(token)


asyncio.run(main())
```

## 7. Discover services and send a custom DAP request

```python
import asyncio
from rocketride import RocketRideClient


async def main():
    client = RocketRideClient(uri='https://api.rocketride.ai', auth='my-key')
    await client.connect()
    services = await client.get_services()
    print('Available:', list(services['services'].keys()))
    ocr = await client.get_service('ocr')  # raises if the service is unknown
    print('OCR definition sections:', list(ocr.keys()))
    my_token = 'existing-task-token'  # token from an earlier client.use() call
    req = client.build_request('rrext_ping', token=my_token)
    res = await client.request(req, timeout=5000)
    if client.did_fail(res):
        raise RuntimeError(res.get('message', 'Ping failed'))
    await client.disconnect()


asyncio.run(main())
```
