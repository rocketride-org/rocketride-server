# =============================================================================
# VENDORED — Apache AGE Python driver agtype decoder (Apache-2.0).
# Source: apache/age master drivers/python/age/ at commit
# 5a254d6869d8b2c271f025ea158c0fee2cfacfa3
# Local deviations:
#   - exceptions.py: dropped 'from psycopg.errors import *' (psycopg v3
#     convenience re-export; this repo standardises on psycopg2 and the local
#     exception classes never used it).
#   - gen/: regenerated from drivers/Agtype.g4 with ANTLR 4.13.2 (upstream
#     ships 4.11.1-generated code, which warns per-parse under the 4.13
#     runtime). See ../README.md for the regeneration step.
#   - builder.py: _stripStringDelimiters decodes JSON escapes with json.loads
#     (upstream strips only the quote delimiters, so '"a\nb"' round-tripped as
#     a literal backslash-n; the STRING token is grammar-guaranteed to be a
#     valid JSON string literal).
# =============================================================================

from .builder import newResultHandler, parseAgeValue  # noqa: F401
from .models import Edge, Path, Vertex  # noqa: F401
