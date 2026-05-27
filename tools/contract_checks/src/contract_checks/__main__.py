"""Allow ``engine -m contract_checks ...`` to invoke the CLI."""

from contract_checks.cli import main

if __name__ == '__main__':
    raise SystemExit(main())
