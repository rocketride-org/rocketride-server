# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Exercise the shipped helpdesk pipeline with local fake services."""

import asyncio
import datetime
import json
import os
import socket
import ssl
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import pytest


EMAIL = 'demo@example.com'
USER_ID = 'auth0|synthetic'
SECRET = 'synthetic-client-secret-123'
TOKEN = 'synthetic-access-token-456'
IP = '192.0.2.91'


def certificate(tmp_path):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'demo.auth0.com')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName('demo.auth0.com')]),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = tmp_path / 'cert.pem', tmp_path / 'key.pem'
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    return cert_path, key_path


class FakeAuth0(BaseHTTPRequestHandler):
    calls = []
    tls = None

    def log_message(self, *args):
        pass

    def do_CONNECT(self):
        assert self.path == 'demo.auth0.com:443'
        self.send_response(200)
        self.end_headers()
        self.connection = self.tls.wrap_socket(self.connection, server_side=True)
        self.rfile = self.connection.makefile('rb')
        self.wfile = self.connection.makefile('wb')
        self.close_connection = False

    def _reply(self, data):
        raw = json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        assert self.path == '/oauth/token'
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert data['client_secret'] == SECRET
        self.calls.append('token')
        self._reply({'access_token': TOKEN, 'expires_in': 3600})

    def do_GET(self):
        path = urlsplit(self.path).path
        assert self.headers['Authorization'] == 'Bearer ' + TOKEN
        self.calls.append(path)
        event = {
            'log_id': 'synthetic-log',
            'type': 'limit_wc',
            'ip': IP,
            'description': SECRET,
        }
        values = {
            '/api/v2/users-by-email': [{'user_id': USER_ID, 'email': EMAIL, 'app_metadata': {'secret': SECRET}}],
            '/api/v2/users/auth0%7Csynthetic/logs': [event],
        }
        assert path in values
        self._reply(values[path])


class FakeModel(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.calls.append(body)
        replies = [
            {'tool_calls': [{'tool': 'tool_auth0_1.search_users', 'args': {'email': EMAIL}}]},
            {'tool_calls': [{'tool': 'tool_auth0_1.get_user_logs', 'args': {'user_id': USER_ID}}]},
            {'done': True, 'answer': 'Investigation complete.'},
        ]
        content = json.dumps(replies[min(len(self.calls) - 1, 2)])
        if body.get('stream'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for delta in ({'role': 'assistant', 'content': content}, {}):
                chunk = {
                    'id': 'fake',
                    'object': 'chat.completion.chunk',
                    'created': 1,
                    'model': 'fake',
                    'choices': [
                        {
                            'index': 0,
                            'delta': delta,
                            'finish_reason': None if delta else 'stop',
                        }
                    ],
                }
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        else:
            payload = {
                'id': 'fake',
                'object': 'chat.completion',
                'created': 1,
                'model': 'fake',
                'choices': [
                    {
                        'index': 0,
                        'message': {'role': 'assistant', 'content': content},
                        'finish_reason': 'stop',
                    }
                ],
                'usage': {
                    'prompt_tokens': 1,
                    'completion_tokens': 1,
                    'total_tokens': 2,
                },
            }
            raw = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)


def test_synthetic_example_reaches_model(tmp_path):
    executable = os.environ.get('AUTH0_TEST_ENGINE', sys.executable)
    if not Path(executable).name.lower().startswith('engine'):
        pytest.skip('requires the built engine runtime')
    from rocketride import Question, RocketRideClient

    root = Path(__file__).resolve().parents[3]
    requirements = [
        str(root / 'nodes' / 'src' / 'nodes' / name / 'requirements.txt')
        for name in ('agent_rocketride', 'llm_ollama', 'tool_auth0')
    ]
    # Resolve the node dependencies before routing the engine's HTTPS traffic
    # exclusively through the fake Auth0 proxy below.
    subprocess.run(
        [executable, '-c', 'import depends, sys; [depends.depends(p) for p in sys.argv[1:]]', *requirements],
        cwd=Path(executable).parent,
        check=True,
        timeout=300,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    pipe = json.loads((root / 'nodes/src/nodes/tool_auth0/example.pipe').read_text(encoding='utf-8'))
    components = {item['id']: item for item in pipe['components']}
    components['tool_auth0_1']['config'].update(
        domain='demo.auth0.com', clientId='synthetic-client-id', clientSecret=SECRET
    )
    cert, key = certificate(tmp_path)
    FakeAuth0.calls = []
    FakeModel.calls = []
    FakeAuth0.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    FakeAuth0.tls.load_cert_chain(cert, key)
    proxy = ThreadingHTTPServer(('127.0.0.1', 0), FakeAuth0)
    model = ThreadingHTTPServer(('127.0.0.1', 0), FakeModel)
    for server in (proxy, model):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    components['llm_ollama_1']['config']['custom'].update(
        serverbase=f'http://127.0.0.1:{model.server_port}', model='fake'
    )
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = dict(
        os.environ,
        HTTPS_PROXY=f'http://127.0.0.1:{proxy.server_port}',
        REQUESTS_CA_BUNDLE=str(cert),
        NO_PROXY='127.0.0.1,localhost',
        ROCKETRIDE_APIKEY='MYAPIKEY',
    )
    env.pop('ROCKETRIDE_MOCK', None)
    env['UV_OFFLINE'] = '1'
    env['https_proxy'] = env['HTTPS_PROXY']
    env['no_proxy'] = env['NO_PROXY']
    engine_dir = Path(executable).parent
    output = (tmp_path / 'engine.log').open('w+', encoding='utf-8')
    process = subprocess.Popen(
        [
            executable,
            '--autoterm',
            'ai/eaas.py',
            '--host=127.0.0.1',
            f'--port={port}',
            '--base_port=41000',
        ],
        cwd=engine_dir,
        env=env,
        stdin=subprocess.PIPE,
        stdout=output,
        stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )

    async def run():
        client = RocketRideClient(uri=f'http://127.0.0.1:{port}', auth='MYAPIKEY')
        await client.connect()
        token = None
        try:
            token = (await client.use(pipeline=pipe, source='chat_1'))['token']
            q = Question()
            q.addQuestion(f'Investigate the synthetic sign-in for {EMAIL}')
            await client.chat(token=token, question=q)
        finally:
            if token:
                await client.terminate(token)
            await client.disconnect()

    try:
        for _ in range(120):
            if process.poll() is not None:
                output.flush()
                pytest.fail('test engine exited: ' + (tmp_path / 'engine.log').read_text(encoding='utf-8')[-6000:])
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.5)
        else:
            pytest.fail('test engine did not start')
        asyncio.run(asyncio.wait_for(run(), timeout=180))
        assert '/api/v2/users-by-email' in FakeAuth0.calls
        assert '/api/v2/users/auth0%7Csynthetic/logs' in FakeAuth0.calls
        assert len(FakeModel.calls) >= 3
        prompts = json.dumps(FakeModel.calls)
        assert EMAIL in prompts and USER_ID in prompts and 'synthetic-log' in prompts
        assert 'Brute-force protection' in prompts
        assert (
            IP not in prompts
            and SECRET not in prompts
            and TOKEN not in prompts
            and 'synthetic-client-id' not in prompts
        )
    finally:
        process.terminate()
        process.wait(timeout=30)
        output.close()
        for server in (proxy, model):
            server.shutdown()
            server.server_close()
