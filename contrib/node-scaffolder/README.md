# Node Scaffolder

A community-maintained CLI utility for generating RocketRide node boilerplate.

> **This is a community-maintained utility and is not officially supported by the core team.**
> Use it at your own discretion. Bug reports and improvements are welcome via pull request.

## Usage

```bash
# Run from the repository root
python contrib/node-scaffolder/new_node.py <node_name> [options]

# Examples
python contrib/node-scaffolder/new_node.py my_custom_llm --class-type llm --prefix my
python contrib/node-scaffolder/new_node.py db_redis      --class-type database --capability noremote invoke
python contrib/node-scaffolder/new_node.py my_processor  --class-type default  --register endpoint

# Full option reference
python contrib/node-scaffolder/new_node.py --help
```

## Limitations

- **Class types**: Currently only 5 class types are wired to known base classes:
  `llm`, `agent`, `embedding`, `database`, and `default`.
  Any other value passed via `--class-type` will fall back to the `default` base classes.
- **Python only**: The scaffolder generates Python node skeletons exclusively.
  It does not support other RocketRide node runtimes (e.g., JavaScript/TypeScript nodes).
- **Execution path**: The script **must be executed from the repository root**.
  It resolves the `nodes/src/nodes/` output directory relative to its own location
  (`contrib/node-scaffolder/new_node.py` → three levels up → repo root).
  Running it from any other directory will produce incorrect output paths.

## Customising the License Header

Generated files include a placeholder header controlled by the `LICENSE_HOLDER`
constant near the top of `new_node.py`. Replace `<INSERT_YOUR_LICENSE_HERE>`
with your own copyright notice before using the scaffolder in your project.

## Contributing

Improvements to support additional class types, runtimes, or generation strategies
are encouraged. Please open a pull request targeting the `feat/cli-node-scaffolder`
branch and follow the project's [contributing guidelines](../../CONTRIBUTING.md).
