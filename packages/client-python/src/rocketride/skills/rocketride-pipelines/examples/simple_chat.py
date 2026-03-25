"""
Simple Chat Pipeline — chat → LLM → response

Minimal example: takes user questions and returns LLM answers.
"""

import asyncio
import os
from rocketride import RocketRideClient
from rocketride.schema import Question


def create_pipeline():
    """Create a simple chat → LLM → response pipeline."""
    return {
        'project_id': 'simple-chat',
        'source': 'chat_1',
        'components': [
            {
                'id': 'chat_1',
                'provider': 'chat',
                'config': {},
            },
            {
                'id': 'llm_openai_1',
                'provider': 'llm_openai',
                'config': {
                    'profile': 'openai-5-2',
                    'openai-5-2': {'apikey': os.environ.get('ROCKETRIDE_APIKEY_OPENAI', '')},
                },
                'input': [{'lane': 'questions', 'from': 'chat_1'}],
            },
            {
                'id': 'response_answers_1',
                'provider': 'response_answers',
                'config': {'laneName': 'answers'},
                'input': [{'lane': 'answers', 'from': 'llm_openai_1'}],
            },
        ],
    }


async def main():
    """Run the simple chat pipeline."""
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
            question.addQuestion('What is the capital of France?')
            response = await client.chat(token=token, question=question)
            answers = response.get('answers', [])
            print(f'Answer: {answers[0] if answers else "No answer"}')
        finally:
            await client.terminate(token)


if __name__ == '__main__':
    asyncio.run(main())
