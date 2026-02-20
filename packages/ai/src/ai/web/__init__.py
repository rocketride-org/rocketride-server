import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from fastapi import FastAPI, Request, Body, Header, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware

# Include the basic support
from ai.web.response import response, error, error_dap, formatException, exception, ResultBase, Result
from ai.web.server import WebServer

from ai.account.account import AccountInfo

__all__ = [
    'AccountInfo',
    'Body',
    'CORSMiddleware',
    'depends',
    'error',
    'error_dap',
    'exception',
    'FastAPI',
    'File',
    'formatException',
    'Header',
    'ObjectPipe',
    'Query',
    'Request',
    'response',
    'Result',
    'ResultBase',
    'UploadFile',
    'WebServer',
]
