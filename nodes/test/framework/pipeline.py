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

import os
import uuid
from typing import List, Dict, Any, Optional
from .discovery import NodeTestConfig, get_node_test_config

# Placeholder credentials for LLM nodes when ROCKETRIDE_MOCK is set (mocks handle requests)
# apikey: format must pass each provider's validation (sk-ant, xai-, sk-, AI..., etc.)
# Bedrock uses accessKey/secretKey; Vertex uses GCP service account (not covered here)
_LLM_MOCK_CREDENTIALS = {
    'llm_anthropic': {'apikey': 'sk-ant-mock-placeholder-for-tests'},
    'llm_xai': {'apikey': 'xai-mock-placeholder-for-tests'},
    'llm_openai': {'apikey': 'sk-mock-placeholder-for-tests'},
    'llm_perplexity': {'apikey': 'sk-mock-placeholder-for-tests'},
    'llm_deepseek': {'apikey': 'sk-mock-placeholder-for-tests'},
    'llm_mistral': {'apikey': 'mock-mistral-placeholder-for-tests'},
    'llm_vision_mistral': {'apikey': 'mock-mistral-placeholder-for-tests'},
    'llm_gemini': {'apikey': 'AIza-mock-placeholder-for-tests'},
    'llm_ibm_watson': {'apikey': 'mock-watson-placeholder-for-tests'},
    'llm_bedrock': {'accessKey': 'mock-access-key', 'secretKey': 'mock-secret-key', 'region': 'us-east-1'},
}


class PipelineBuilder:
    """
    Builds test pipelines for node testing.
    
    Creates pipelines in the form:
        webhook → [chain nodes] → [node under test] → [chain nodes] → response(s)
    
    With control nodes attached to the node under test.
    """
    
    def __init__(self, config: NodeTestConfig, profile: Optional[str] = None):
        """
        Initialize the pipeline builder.
        
        Args:
            config: The node test configuration
            profile: Optional profile name to use (from preconfig.profiles)
        """
        self.config = config
        self.profile = profile
        self._component_counter = 0
    
    def _next_id(self, prefix: str) -> str:
        """Generate a unique component ID."""
        self._component_counter += 1
        return f"{prefix}_{self._component_counter}"
    
    def _get_node_config(self, provider: str, profile: Optional[str] = None) -> Dict[str, Any]:
        """
        Get configuration for a node, optionally with a profile.
        
        Args:
            provider: The node provider name
            profile: Optional profile name
        
        Returns:
            Configuration dict for the node
        """
        config = {}
        if profile:
            config['profile'] = profile
        # Inject placeholder credentials for LLM nodes when using mocks
        if os.environ.get('ROCKETRIDE_MOCK') and provider in _LLM_MOCK_CREDENTIALS and profile:
            overrides = config.get(profile, {})
            if isinstance(overrides, dict):
                config[profile] = {**overrides, **_LLM_MOCK_CREDENTIALS[provider]}
        return config
    
    def _build_chain_component(self, provider: str, component_id: str,
                                input_from: str, input_lanes: List[str]) -> Dict[str, Any]:
        """Build a component for a chain node.
        
        Wires all input_lanes that the chain node supports (e.g. embedding_transformer
        receives both documents and questions so vector DB search-with-question works).
        """
        node_config = get_node_test_config(provider)
        profile = None
        if node_config and node_config.profiles:
            profile = node_config.profiles[0]  # Use first profile

        # Wire every lane that both the pipeline and the chain node support
        if node_config and node_config.lanes:
            chain_lanes = list(node_config.lanes.keys())
            lanes_to_wire = [lane for lane in input_lanes if lane in chain_lanes]
        else:
            lanes_to_wire = []
        if not lanes_to_wire:
            lanes_to_wire = [input_lanes[0]] if input_lanes else ['text']

        return {
            'id': component_id,
            'provider': provider,
            'config': self._get_node_config(provider, profile),
            'input': [{'lane': lane, 'from': input_from} for lane in lanes_to_wire]
        }
    
    def _build_control_components(self, target_id: str) -> List[Dict[str, Any]]:
        """Build control node components attached to the target node."""
        components = []
        
        for control_provider in self.config.controls:
            control_id = self._next_id(control_provider)
            
            # Get control node's test config for profile
            control_config = get_node_test_config(control_provider)
            profile = None
            if control_config and control_config.profiles:
                profile = control_config.profiles[0]
            
            components.append({
                'id': control_id,
                'provider': control_provider,
                'config': self._get_node_config(control_provider, profile),
                'control': target_id  # Attach as control to target
            })
        
        return components
    
    def _build_response_components(self, input_from: str) -> List[Dict[str, Any]]:
        """Build response node components for each output lane."""
        components = []
        
        for output_lane in self.config.outputs:
            response_id = self._next_id(f'response_{output_lane}')
            components.append({
                'id': response_id,
                'provider': 'response',
                'config': {},
                'input': [{'lane': output_lane, 'from': input_from}]
            })
        
        # Sink nodes (outputs=[]): no response components needed
        if not self.config.outputs:
            return components
        # No outputs inferred: add default response on text lane
        if not components:
            response_id = self._next_id('response')
            components.append({
                'id': response_id,
                'provider': 'response',
                'config': {},
                'input': [{'lane': 'text', 'from': input_from}]
            })
        
        return components
    
    def build(self) -> Dict[str, Any]:
        """
        Build the complete test pipeline.
        
        Returns:
            Pipeline configuration dict ready for client.use()
        """
        project_id = f"test_{self.config.node_name}_{uuid.uuid4().hex[:8]}"
        components = []
        
        # Start with webhook
        webhook_id = self._next_id('webhook')
        components.append({
            'id': webhook_id,
            'provider': 'webhook',
            'config': {},
            'input': []
        })
        
        # Process chain, finding where * (node under test) goes
        chain = self.config.chain if self.config.chain else ['*']
        
        # Ensure * is in the chain
        if '*' not in chain:
            chain = chain + ['*']
        
        prev_id = webhook_id
        # Get all input lanes from the node's lanes config
        input_lanes = list(self.config.lanes.keys()) if self.config.lanes else []
        # Fallback: infer from test cases if no lanes defined
        if not input_lanes and self.config.cases:
            input_lanes = [self.config.cases[0].input_lane]
        # Ultimate fallback
        if not input_lanes:
            input_lanes = ['text']
        
        prev_lane = input_lanes[0]  # For chain nodes after the node under test
        node_under_test_id = None
        
        for chain_item in chain:
            if chain_item == '*':
                # This is the node under test
                node_id = self._next_id(self.config.provider)
                node_under_test_id = node_id
                
                # Wire ALL input lanes from webhook to the node
                node_inputs = [{'lane': lane, 'from': prev_id} for lane in input_lanes]
                
                components.append({
                    'id': node_id,
                    'provider': self.config.provider,
                    'config': self._get_node_config(self.config.provider, self.profile),
                    'input': node_inputs
                })
                
                # Add control nodes attached to this node
                control_components = self._build_control_components(node_id)
                components.extend(control_components)
                
                prev_id = node_id
                # Output lane depends on node's lanes config
                # For now, keep the same lane or use first output
                if self.config.outputs:
                    prev_lane = self.config.outputs[0]
            else:
                # Chain node (before or after node under test)
                chain_id = self._next_id(chain_item)
                components.append(
                    self._build_chain_component(chain_item, chain_id, prev_id, input_lanes)
                )
                prev_id = chain_id
        
        # Add response nodes for each output lane
        response_components = self._build_response_components(prev_id)
        components.extend(response_components)
        
        return {
            'project_id': project_id,
            'source': webhook_id,
            'components': components
        }
    
    def get_required_env_vars(self) -> List[str]:
        """
        Get all required environment variables for this pipeline.
        
        Includes requirements from the node under test and all chain/control nodes.
        """
        required = set(self.config.requires)
        
        # Add requirements from control nodes
        for control in self.config.controls:
            control_config = get_node_test_config(control)
            if control_config:
                required.update(control_config.requires)
        
        # Add requirements from chain nodes
        for chain_item in self.config.chain:
            if chain_item != '*':
                chain_config = get_node_test_config(chain_item)
                if chain_config:
                    required.update(chain_config.requires)
        
        return list(required)

