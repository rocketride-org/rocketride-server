"""
Agent Pipeline — chat → agent (with LLM + tools + memory) → response

A RocketRide Wave agent that can reason, use HTTP tools, and maintain
memory across planning waves.
"""

import asyncio
import os
from rocketride import RocketRideClient
from rocketride.schema import Question


def create_pipeline():
    """Create an agent pipeline with LLM, HTTP tool, and memory."""
    return {
        'project_id': 'agent-with-tools',
        'source': 'chat_1',
        'components': [
            # Source — receives questions
            {
                'id': 'chat_1',
                'provider': 'chat',
                'config': {},
            },
            # Agent — orchestrates LLM, tools, and memory
            {
                'id': 'agent_rocketride_1',
                'provider': 'agent_rocketride',
                'config': {
                    'instructions': [
                        'You are a helpful research assistant.',
                        'Use the HTTP request tool to fetch data from APIs when needed.',
                        'Store intermediate results in memory to avoid redundant requests.',
                    ],
                    'max_waves': 10,
                },
                'input': [{'lane': 'questions', 'from': 'chat_1'}],
            },
            # LLM — controlled by agent (control array goes HERE, not on the agent)
            {
                'id': 'llm_openai_1',
                'provider': 'llm_openai',
                'config': {
                    'profile': 'openai-5-2',
                    'openai-5-2': {'apikey': os.environ.get('ROCKETRIDE_APIKEY_OPENAI', '')},
                },
                'control': [{'classType': 'llm', 'from': 'agent_rocketride_1'}],
            },
            # Tool — controlled by agent
            {
                'id': 'tool_http_request_1',
                'provider': 'tool_http_request',
                'config': {'type': 'tool_http_request'},
                'control': [{'classType': 'tool', 'from': 'agent_rocketride_1'}],
            },
            # Memory — controlled by agent
            {
                'id': 'memory_internal_1',
                'provider': 'memory_internal',
                'config': {'type': 'memory_internal'},
                'control': [{'classType': 'memory', 'from': 'agent_rocketride_1'}],
            },
            # Response — receives answers from agent
            {
                'id': 'response_answers_1',
                'provider': 'response_answers',
                'config': {'laneName': 'answers'},
                'input': [{'lane': 'answers', 'from': 'agent_rocketride_1'}],
            },
        ],
    }


async def main():
    """Run the agent pipeline."""
    async with RocketRideClient(
        uri=os.environ.get('ROCKETRIDE_URI', 'http://localhost:5565'),
        auth=os.environ.get('ROCKETRIDE_APIKEY', ''),
    ) as client:
        pipeline = create_pipeline()
        result = await client.use(pipeline=pipeline, ttl=3600, use_existing=True)
        token = result['token']
        print(f'Pipeline started: {token}')

        try:
            question = Question()
            question.addQuestion('What is the current weather in San Francisco?')
            response = await client.chat(token=token, question=question)
            answers = response.get('answers', [])
            print(f'Answer: {answers[0] if answers else "No answer"}')
        finally:
            await client.terminate(token)


if __name__ == '__main__':
    asyncio.run(main())
