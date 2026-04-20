# Plan de acción — `feat/conditional-node-if-else`

Reconciliación con discusión #680 (Python Director), PR #528 (`feature/conditional-branch-node`) y use case Frame Grabber → Gemini.

## Dirección acordada

**Opción A** (módulo contenido, cero cambios en engine/UI) con dos invariantes fundacionales que definen la estructura de todo el sistema de flow control futuro:

1. **Async-first.** Todo el pipeline de flow control es `asyncio`. `invoke()` es awaitable. Los loops futuros (`flow_for`, `flow_map`) podrán hacer `asyncio.gather()` nativamente sin refactor.
2. **Per-chunk state.** El `state` store vive en el scope de una sola invocación del flow node (un chunk). Fresh state al inicio de cada `prepare()`. Cross-chunk state NO existe por default; si se necesita, es un namespace separado y explícito (`pipeline_state`).

Estas dos decisiones se toman ahora porque rediseñarlas después obliga a migrar cada flow node existente. El costo hoy es marginal, el costo diferido es alto.

## Decisiones descartadas y por qué

| Alternativa                                                     | Descarte                                                                                                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extender C++ binder (meta-lanes `then`/`else` + branch tagging) | Fuera de alcance: "no C++ unless strictly necessary". El use case se resuelve por orchestration Python.                                                   |
| `PreventDefault` parallel gates (comentario #5 de #680)         | UX inaceptable (dos nodos gemelos por decisión) + no escala por lane.                                                                                     |
| Subclasificar `AgentBase`                                       | `AgentBase` es 100% sync (`def run_agent`, `def call_llm`, `def call_tool`). Heredar forzaría sync o migrar AgentBase — dos costos que no queremos pagar. |
| `state` cross-chunk por default                                 | Race conditions con concurrencia async + acoplamiento entre invocaciones. Si se necesita, explícito en namespace separado.                                |

## Arquitectura: módulo `flow_*`

```
nodes/src/nodes/flow_base/                 # paquete compartido, no es un nodo
├── driver.py          # FlowDriverBase — async, base paralela a AgentBase
├── sandbox.py         # evaluador de expresiones Python (soporta await)
├── cond.py            # helpers cond.contains/regex/score_threshold/... (absorbe PR #528)
├── state.py           # PerChunkState — scope = una invocación del flow node
├── invoker.py         # AsyncInvoker — async façade sobre instance.invoke() sync
├── bounds.py          # timeout + max_iterations enforcement (asyncio.wait_for)
├── trace.py           # observabilidad estructurada (alineada con #680)
└── types.py           # FlowContext, FlowResult, Decision

nodes/src/nodes/flow_if/                   # esta rama — primer consumidor
├── IGlobal.py / IInstance.py
├── services.text.json / services.questions.json / services.answers.json
└── driver.py          # IfDriver(FlowDriverBase)

nodes/src/nodes/flow_for/                  # futuro — bounded iteration
nodes/src/nodes/flow_while/                # futuro — guarded loop
nodes/src/nodes/flow_map/                  # futuro — for + gather results async
nodes/src/nodes/flow_switch/               # futuro — N-way branch
nodes/src/nodes/flow_reduce/               # futuro
```

## Contrato `FlowDriverBase` (async-first)

```python
class FlowDriverBase(ABC):
    def __init__(self, invoker, config): ...

    async def run(self, chunk) -> FlowResult:
        state = PerChunkState()           # fresh per chunk
        ctx = FlowContext(chunk, state, self.invoker, self.bounds)
        async with self.trace.span(self.node_id, chunk):
            async with self.bounds.deadline():
                decision = await self.evaluate(ctx)
                output = await self.dispatch(ctx, decision)
                await self.emit(ctx, output)

    @abstractmethod
    async def evaluate(self, ctx) -> Any: ...

    @abstractmethod
    async def dispatch(self, ctx, decision) -> Any: ...

    async def emit(self, ctx, output): ...        # shared — reemite a output lane
```

Cada subclase solo implementa `evaluate` y `dispatch`. El resto se hereda.

## API Python estable (`rocketride.flow`)

Superficie que los usuarios escriben en el sandbox. Todos los flow nodes la comparten.

```python
from rocketride.flow import cond, state, invoke, emit

# condiciones (absorbidas de PR #528)
if cond.regex(chunk.text, r"error|failure"):
    ...

# state per-chunk (fresh en cada invocación del flow node)
i = state.get("i", 0)
state.set("i", i + 1)

# invocación async de downstream (AsyncInvoker façade sobre instance.invoke sync)
result = await invoke(node_id="embedding_1", payload=chunk)

# paralelismo nativo (flow_map lo usa gratis)
results = await asyncio.gather(*[invoke(node_id=body, payload=x) for x in items])

# emisión a la output lane del flow node
emit(result)
```

Esto mapea 1:1 al API propuesto en #680 (`routing.branch`, `routing.emit`, `state.get/set`). El día que llegue el Director completo, los `flow_*` son ejemplos canónicos del patrón.

## Invariante: async façade sobre transport sync

`instance.invoke()` (host adapter del engine) es sync — cambiarlo requiere tocar bindings C++/Python. En vez de migrarlo:

```python
# flow_base/invoker.py
class AsyncInvoker:
    def __init__(self, sync_invoker, executor):
        self._sync = sync_invoker
        self._executor = executor  # ThreadPoolExecutor compartido

    async def invoke(self, node_id: str, payload: Any) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor,
            self._sync.invoke,
            payload,
            node_id,
        )
```

Beneficios:

- Cero cambios en engine/bindings.
- `flow_map` / `flow_for` async paralelos funcionan nativo.
- Si un día el engine expone invocación async real, solo cambia esta clase — el resto del módulo no se entera.

## Invariante: `PerChunkState`

```python
# flow_base/state.py
class PerChunkState:
    """Scope: una sola invocación de un flow node sobre un chunk.
    Fresh instance al inicio de cada run(). Descartado al final."""
    def __init__(self):
        self._data: dict[str, Any] = {}

    def get(self, key, default=None): return self._data.get(key, default)
    def set(self, key, value): self._data[key] = value
```

**Reglas:**

- Un `FlowDriverBase.run(chunk)` crea un `PerChunkState` nuevo.
- Todos los `invoke()` downstream, loops internos y re-evaluaciones comparten ese state.
- Al terminar `run()`, el state se descarta. No persiste entre chunks.
- Concurrencia: dos chunks procesados en paralelo → dos `PerChunkState` independientes → sin race conditions.

Si en el futuro se necesita cross-chunk state: namespace separado `pipeline_state` con locking explícito. **No se agrega ahora**.

## Fase 1 — `flow_base/` + `flow_if/` (esta rama)

1. **Extraer `flow_base/`** con todas las piezas: driver, sandbox, cond helpers, state, invoker, bounds, trace, types.
2. **Implementar `flow_if/` como primer consumidor.**
   - Una input lane, una output lane (existentes, ya en `MethodNames`).
   - Config: `condition_expr` (Python), `then_target` (node_id), `else_target` (node_id).
   - `evaluate` corre `condition_expr` en sandbox → bool.
   - `dispatch` hace `await invoke(then_target | else_target, payload)`.
3. **Variantes por lane data-driven**: `services.text.json`, `services.questions.json`, `services.answers.json`. Cada una reusa `IfDriver`. Nuevas variantes = solo un JSON.
4. **Absorber las 8 condiciones de PR #528** como `flow_base/cond.py`. Migrar los 86 tests. Cerrar PR #528 con crédito a Nihal.
5. **Tests**:
   - `flow_base/`: unit tests con `AsyncInvoker` mockeado. Cobertura completa del `run()` loop, state, bounds, trace.
   - `flow_if/`: tests de decisión true/false, dispatch al target correcto, preservación del payload completo (no solo texto — diferenciador vs PR #528).
   - `pytest-asyncio` como harness.
6. **No replicar la conversión lossy `Question→Answer` de PR #528.** Si se necesita, nodo `lane_convert` aparte.

## Fase 2 — Validación en producción

7. Shippar `flow_if` solo. Observar métricas (latencia async vs sync esperada, trace events, errores de sandbox).
8. Recoger feedback UX sobre "target por node_id" vs "handles visuales". Si es requisito duro, reabrir conversación sobre C++ — pero con data, no a priori.

## Fase 3 — Expandir el módulo `flow_*`

Cada uno es ~30–60 líneas de Python nuevo + descriptores JSON. Cero tocar `flow_base` si se diseñó bien:

| Nodo          | Qué sobrescribe                                                    | Complejidad                          |
| ------------- | ------------------------------------------------------------------ | ------------------------------------ |
| `flow_for`    | `dispatch`: itera, `await invoke()` por item, respeta `max_iter`   | Baja                                 |
| `flow_while`  | `dispatch`: loop con re-evaluate de guard + `max_iter` + timeout   | Baja                                 |
| `flow_map`    | `dispatch`: `asyncio.gather()` sobre items con `max_concurrency`   | Media — gestión de concurrency bound |
| `flow_switch` | `evaluate`: devuelve clave; `dispatch`: dict `{key: node_id}`      | Baja                                 |
| `flow_reduce` | `dispatch`: fold secuencial sobre items con accumulator en `state` | Baja                                 |

**Criterio de admisión**: cualquier flow node nuevo debe subclasificar `FlowDriverBase`, NO reimplementar invocación/state/bounds/trace. Si no encaja, es señal de que la abstracción falta algo — se mejora `flow_base/`, no se hace bypass.

## Fase 4 — Convergencia con Python Director (#680)

Con `flow_base` estable, el Director deja de ser un big-bang:

- `rocketride.flow` ya es la API de #680 (`routing`, `state`, invoke).
- Agregar proxies: `flow_base/proxies/llm.py`, `embedding.py`, `vector_db.py` — wrappers finos sobre `invoke()` tipados.
- `flow_python` = nodo genérico que ejecuta un script Python arbitrario con acceso completo al API. Es el Director.
- Host adapter channels para `embedding`/`vector_db` en `AgentHostServices` — único cambio fuera del módulo, y es extensión aditiva.

El conditional queda como **caso degenerado del Director** (una decisión binaria expresada declarativamente en vez de scripted), no como feature separado.

## Estrategia de PRs

Todo es Python. Un solo repo path (`nodes/src/nodes/`). División por capas lógicas:

### PR 1 — `flow_base/`

Solo la infra compartida + tests aislados. Sin nodos que la usen todavía. Mergeable sola.

Audiencia: revisores de infra Python. Review focus: contrato del driver, correctness del AsyncInvoker, bounds enforcement.

### PR 2 — `flow_if/` + absorción de PR #528

Depende de PR 1. Introduce el primer nodo consumidor + las 8 condiciones como `cond.*`.

Audiencia: revisores de nodos. Co-autoría con Nihal. Cierra PR #528.

### PR 3 — Documentación

`.rocketride/docs/` adds: `ROCKETRIDE_FLOW_NODES.md` describiendo el API `rocketride.flow` y cómo agregar nuevos `flow_*`. Es el contrato público.

### PRs futuros

Uno por cada flow node (`flow_for`, `flow_while`, …). Cada uno chico, independiente, reviewable en horas.

## Riesgos abiertos

- **Sandbox con `await`**: hay que verificar si el sandbox actual (compartido con `tool_python`) soporta `async def` / `await`. Si no, o se extiende o se usa un sandbox separado para `flow_*`. Tarea de Fase 1.
- **ThreadPoolExecutor sizing**: el `AsyncInvoker` usa thread pool para llamar `instance.invoke()` sync. Pool compartido vs per-driver — decidir en Fase 1. Default conservador: pool global con `max_workers = min(32, os.cpu_count() * 4)`.
- **Observabilidad del Director future**: `trace.py` debe emitir eventos suficientes para que #680 no tenga que reinventar tracing. Diseñar pensando en el consumidor más complejo desde ya.
- **UX de targets por node_id**: requiere que el usuario conozca el ID de nodos. En el canvas esto es visible, pero menos natural que arrastrar wires. Mitigable con un selector dropdown en la UI del nodo (cambio contenido en el component TS del conditional — no afecta engine).
- **Compatibilidad con el diff C++ existente en la rama**: este plan lo reemplaza completo. El diff actual de `binder.cpp` debe revertirse antes del PR 1, o la rama se recrea desde `develop`.
