#!/usr/bin/env python3
"""
RocketRide CLI Entry Point.

This script serves as a standalone entry point for running the RocketRide CLI
during development. It can be executed directly from the command line.

Usage:
    python run_cli.py list --apikey your_key
    python run_cli.py start pipeline.json --apikey your_key
    python run_cli.py apaext_store save_project --project-id project-1 --project-file path/to/pipeline.json --uri http://localhost:5565 --apikey MYKEY
"""

import sys
from pathlib import Path

# Add src to path so "rocketride" package is found
_src_path = Path(__file__).parent.parent / 'src'
if str(_src_path) not in sys.path:
    sys.path.insert(0, str(_src_path))

from rocketride.cli.main import main

if __name__ == '__main__':
    main()
