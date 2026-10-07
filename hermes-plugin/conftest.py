import sys
from pathlib import Path

# Tests import the plugin package from this directory; Hermes itself is never imported in tests.
sys.path.insert(0, str(Path(__file__).parent))
