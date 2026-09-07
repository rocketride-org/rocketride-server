from rocketride import RocketRideClient


def test_unknown_constructor_kwarg_raises_type_error():
    # A misspelled option must be reported, not silently discarded as if it
    # had never been passed (#1837).
    try:
        RocketRideClient(auth='x', client_nmae='typo')
    except TypeError as e:
        assert 'client_nmae' in str(e)
    else:
        raise AssertionError('expected TypeError for client_nmae')


def test_unknown_constructor_kwargs_all_listed():
    try:
        RocketRideClient(auth='x', ws_paht='/nope', on_trce=None)
    except TypeError as e:
        msg = str(e)
        assert 'on_trce' in msg and 'ws_paht' in msg
    else:
        raise AssertionError('expected TypeError for ws_paht/on_trce')


def test_documented_constructor_kwargs_still_accepted():
    client = RocketRideClient(
        uri='ws://localhost:5565',
        auth='x',
        ws_path='/task/service',
        client_name='my-app',
        client_version='2.0',
        module='my-module',
        persist=True,
        max_retry_time=5.0,
        request_timeout=5000,
        on_event=lambda *a, **k: None,
        on_connected=lambda *a, **k: None,
        on_disconnected=lambda *a, **k: None,
        on_connect_error=lambda *a, **k: None,
        on_protocol_message=lambda *a, **k: None,
        on_debug_message=lambda *a, **k: None,
        on_trace=lambda *a, **k: None,
        env={'ROCKETRIDE_URI': 'ws://localhost:5565'},
        public=True,
    )
    assert client._client_display_name == 'my-app'
    assert client._client_display_version == '2.0'
    assert client._public is True


def test_transport_kwarg_rejected():
    # RocketRideClient always creates its own transport in _internal_connect;
    # the DAP base chain never consumes a caller-supplied transport, so passing
    # one must be rejected rather than silently forwarded (#1901).
    try:
        RocketRideClient(auth='x', transport=None)
    except TypeError as e:
        assert 'transport' in str(e)
    else:
        raise AssertionError('expected TypeError for transport')

