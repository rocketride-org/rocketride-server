# Redis node verification

The unit tests use redis-py and the shared `test.mocks.redis_fake` fixture. Live
Valkey and model tests are opt-in. The generic node runner has one connectivity
case. The dedicated SDK tests assert all seven Redis operations against the engine.

For a quick check without a Redis server or model key, run the unit and regression
tests from `nodes/` with a built engine containing the current node sources:

```sh
../dist/server/engine -m pytest test/tool_redis/test_redis.py test/tool_redis/test_v1.py -q --rootdir .
```

The regression suite covers optional null arguments, serialized read-back limits,
malformed SCAN keys, literal DELETE keys, pool-exhaustion outcomes, and counter
overflow. Hosted and shared-host tests check that the client selects the guarded
TLS connection and rejects DNS changes to private destinations before connecting.

The live tests below additionally check real expiry, authentication, ACLs and TLS.
Certificate-rejection cases restore valid credentials and assert a certificate
verification failure, so a bad password cannot make a broken TLS check pass.
Without fixture URLs, live tests skip; engine dispatch and model tests also need
their corresponding server and model configuration. Report those skips separately
from passing tests.

From the repository root, with Docker and the engine built:

```sh
sh nodes/test/tool_redis/prepare_live.sh
export REDIS_TEST_URL=redis://127.0.0.1:6381/0
export REDIS_AUTH_TEST_URL=redis://:redis-node-test-only@localhost:6382
export REDIS_TLS_TEST_URL=rediss://:redis-node-test-only@localhost:6383
export REDIS_TLS_CA_FILE="$PWD/nodes/test/tool_redis/.certs/server.crt"
export ROCKETRIDE_REDIS_HOST=127.0.0.1
cd nodes
../dist/server/engine -m pytest test/tool_redis test/memory_persistent test/test_contracts.py -q --rootdir .
../dist/server/engine -m pytest test/test_dynamic.py -k tool_redis -q --rootdir .
```

The fixture ports bind only to loopback. Each test uses its own key prefix and
cleans up its keys. From the repository root, remove the disposable fixture
with `docker compose -p rocketride-redis-v1 -f nodes/test/tool_redis/compose.yaml down -v`.

To opt in to `test_agent.py`, set `ROCKETRIDE_REDIS_AGENT_MODEL` to an available
model and `ROCKETRIDE_REDIS_AGENT_PROVIDER` to `gemini` (default) or `ollama`.
Gemini needs `ROCKETRIDE_GEMINI_KEY` in the test and engine environments. For
Ollama, start a local model server and optionally set `ROCKETRIDE_REDIS_AGENT_URL`
to its OpenAI-compatible URL. The tests make 30 requests, check the agent's tool
trace and Redis state, and enable writes only in disposable test namespaces.
