# Configure Python path for tests to import rocketride from source
import sys
from pathlib import Path

src_path = Path(__file__).parent.parent / 'src'
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))
