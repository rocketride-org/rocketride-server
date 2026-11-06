# Redis node verification

Tests use the real redis-py library; the shared fake is `test.mocks.redis_fake`.
No production Redis is required. Live tests skip when `REDIS_TEST_URL` is absent.

From the repository root, with Docker and the engine built:

```sh
sh nodes/test/tool_redis/prepare_live.sh
export REDIS_TEST_URL=redis://127.0.0.1:6381/0
export REDIS_AUTH_TEST_URL=redis://:redis-node-test-only@localhost:6382
export REDIS_TLS_TEST_URL=rediss://:redis-node-test-only@localhost:6383
export REDIS_TLS_CA_FILE="$PWD/nodes/test/tool_redis/.certs/server.crt"
export ROCKETRIDE_REDIS_HOST=127.0.0.1
# Start in a separate terminal: cd dist/server && ./engine ./ai/eaas.py --host=127.0.0.1
cd nodes
../dist/server/engine -m pytest test/tool_redis test/memory_persistent test/test_contracts.py -q --rootdir .
../dist/server/engine -m pytest test/test_dynamic.py -k tool_redis -q --rootdir .
```

The fixture password and certificate are disposable test values. Ports 6381–6383
bind only to localhost. Test keys use a unique prefix and are removed afterward.
Remove fixture data using `docker compose -p rocketride-redis-v1 -f
nodes/test/tool_redis/compose.yaml down -v` from the repository root.

The live engine test reads the `tool`, `arguments` and `expect_tool` metadata in
`services.json` and dispatches each case through `client.tool`. The standard
lane runner smoke-tests configuration only; it does not exercise tool methods.
Its test configuration explicitly selects port 6381, matching the disposable
plain fixture. Only variables listed in `test.requires` are injected by the
generic runner; setting `ROCKETRIDE_REDIS_PORT` alone does not override a port.
The proposed `.github/workflows/redis-node.yml` runs both without a model key.
Adding these Valkey services to CI requires reviewer approval. CI evidence is
only available after that workflow actually runs in GitHub.

Covered: all seven tools; read-only guards; literal namespaces; exact limits;
UTF-8 overflow before decoding; ASCII-escaped JSON cap; invalid args; missing,
empty, binary, oversized and wrong-type values; counter precision/overflow;
concurrent INCR/NX; SCAN cursor semantics; lifecycle cleanup; zero retries;
hosted destination rejection; DNS-rebinding peer check; real password failure;
trusted TLS and rejected untrusted certificate/hostname mismatch.

A live hosted/public Redis endpoint and an agent-driven LLM canvas walkthrough
are separate deployment checks. Direct engine dispatch does not prove model
selection or hosted egress behavior.
