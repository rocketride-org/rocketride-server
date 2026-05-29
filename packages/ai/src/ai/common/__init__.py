import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

# __all__ = ['normalize', 'safeString', 'parseJson', 'parsePython', 'obfuscate_string']
