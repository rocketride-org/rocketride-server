# Authoring a Python node

## Introduction

This document covers authoring a node in Python. The internal engine supports a large subset of the Python libraries shipped with 3.10

## Steps

1. Add a service definition json file to the <code>services</code> folder. This json file describes the node endpoint

2. Create a new module directory in the <code>nodes</code> folder and add your __init__.py. The __main__.py is not needed unless you are going to start this module directly from the command line.

3. Declare your IEndpoint class. This class contains the main entry points for endpoint operations. For a complete example, see the <code>example</code> endpoint

4. Declare your IInstance class. This class contains the entry points to access the underlying data. For a complete example, see the <code>example</code> endpoint

5. Debugging - select the Engine - Python debug task from the debug drop down. Set breakpoints in you code as needed
