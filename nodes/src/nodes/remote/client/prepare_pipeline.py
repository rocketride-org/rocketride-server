# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

from rocketlib import PROTOCOL_CAPS


def preparePipeline(pipeline: dict) -> dict:
    """
    Prepare the pipeline configuration for client/server processing.

    Update a simplified remote pipeline configuration
    into a full specified pipeline configuration for local or remote processing.
    """
    # Get the remote component
    (remote,) = filter(lambda comp: comp['provider'] == 'remote', pipeline['components'])

    # Check that all the remote components support remoting
    for remote_comp in remote['config']['pipeline']['components']:
        caps = PROTOCOL_CAPS.getProtocolCaps(remote_comp['provider'])
        if not caps & PROTOCOL_CAPS.REMOTING:
            raise Exception(f"The component '{remote_comp['provider']}' does not support remote execution")

    # Get the remote profile - the local or the remote execution mode
    profile = remote['config']['remote']['remote']['profile']

    # Process pipeline configuration in accordance with the execution mode
    if profile == 'remote':
        return prepareRemotePipeline(pipeline, remote)
    elif profile == 'local':
        return prepareLocalPipeline(pipeline, remote)
    else:
        raise Exception(f'Invalid remote profile: {profile}')


def prepareLocalPipeline(pipeline: dict, remote: dict) -> dict:
    """
    Prepare the pipeline configuration for client processing.

    Update a simplified remote pipeline configuration
    into a full specified pipeline configuration for local processing.
    """
    # Get the local and the remote pipeline components
    local_comps, remote_comps = (pipeline['components'], remote['config']['pipeline']['components'])

    # Determine the position of the remote component in the local components
    remote_idx = local_comps.index(remote)

    # Replace the remote component with its pipeline components
    pipeline['components'] = local_comps[:remote_idx] + remote_comps + local_comps[remote_idx + 1 :]

    return pipeline


def prepareRemotePipeline(pipeline: dict, remote: dict) -> dict:
    """
    Prepare the pipeline configuration for server processing.

    Update a simplified remote pipeline configuration
    into a full specified pipeline configuration for server processing.
    """
    # Check the input, the should be no
    if 'input' in remote:
        raise Exception('Remote configuration must not have any inputs')

    # Init the input
    remote['input'] = []

    # Get the remote pipeline config
    remote_pipeline = remote['config']['pipeline']

    # Create a remote server component
    remote_server = {'id': 'remote_server', 'provider': 'remote_server', 'input': [], 'config': {}}

    # Get the local components
    local_comps = set(comp['id'] for comp in pipeline['components'])

    # Get the remote components
    remote_comps = set(comp['id'] for comp in remote_pipeline['components'])

    # Get the remote input lanes from the local pipeline
    remote_inputs = list(input_ for comp in remote_pipeline['components'] for input_ in comp.get('input', []) if input_['from'] in local_comps)

    # Update local-to-remote lanes as follow:
    #   before : local component -> remote component
    #   after  : local component -> remote -> remote server -> remote component
    for remote_input in remote_inputs:
        remote['input'].append({'lane': remote_input['lane'], 'from': remote_input['from']})
        # The input lane must be from the source, otherwise the filter
        # will not be linked and therefore created with the pipe
        remote_server['input'].append({'lane': remote_input['lane'], 'from': 'remote_source_stub'})
        remote_input['from'] = 'remote_server'

    # Get the local input lanes from the remote pipeline
    local_inputs = list(input_ for comp in pipeline['components'] for input_ in comp.get('input', []) if input_['from'] in remote_comps)

    # Update remote-to-local lanes as follow:
    #   before : remote component -> local component
    #   after  : remote component -> remote server -> remote -> local component
    for local_input in local_inputs:
        remote_server['input'].append({'lane': local_input['lane'], 'from': local_input['from']})
        local_input['from'] = remote['id']

    # Create a remote source stub in the remote pipeline
    remote_pipeline['source'] = 'remote_source_stub'
    remote_pipeline['components'].insert(0, {'id': 'remote_source_stub', 'provider': 'remote_source_stub', 'config': {}})

    # Emplace the remote server node to the remote pipeline
    remote_pipeline['components'].insert(1, remote_server)

    # Put the remote pipeline config into a separate pipeline property
    remote['config']['pipeline'] = {'pipeline': remote_pipeline}

    return pipeline
