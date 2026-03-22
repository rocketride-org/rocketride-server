"""
Project Mariner Agent Loop for RocketRide testing.

Uses Gemini computer_use to visually test web applications.
The agent takes screenshots, sends them to Gemini, and executes
the returned actions via Playwright.

Usage:
    # Set GOOGLE_API_KEY or use gcloud auth
    python tests/mariner_agent.py https://oauth2.rocketride.ai/health
    python tests/mariner_agent.py http://localhost:3002  # chat-ui dev server

Requires:
    pip install google-genai Pillow playwright
    playwright install chromium
"""

import asyncio
import os
import re
import sys

from google import genai
from google.genai import types
from playwright.async_api import async_playwright


# Config
MAX_STEPS = 15
SCREENSHOT_DIR = '/tmp/mariner_screenshots'
MODEL = 'gemini-2.5-flash'


async def take_screenshot(page, step: int) -> str:
    """Take a screenshot and save it."""
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    path = f'{SCREENSHOT_DIR}/step_{step:03d}.png'
    await page.screenshot(path=path, full_page=False)
    return path


async def run_mariner_agent(url: str, goal: str):
    """Run the Mariner agent loop on a URL with a goal."""
    # Init Gemini client
    api_key = os.environ.get('GOOGLE_API_KEY') or os.environ.get('GEMINI_API_KEY')
    if not api_key:
        # Try using gcloud auth
        try:
            import subprocess

            result = subprocess.run(
                ['gcloud', 'auth', 'print-access-token'],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                api_key = result.stdout.strip()
        except FileNotFoundError:
            pass

    if not api_key:
        print('ERROR: Set GOOGLE_API_KEY or login with gcloud')
        sys.exit(1)

    # Try API key first, fall back to vertex
    try:
        client = genai.Client(api_key=api_key)
    except Exception:
        client = genai.Client()

    # Define computer_use tool
    # Use vision-only mode (no computer_use tool needed)
    # Agent analyzes screenshots and reports findings
    config = types.GenerateContentConfig()

    print('Mariner Agent starting')
    print(f'  URL:  {url}')
    print(f'  Goal: {goal}')
    print(f'  Max steps: {MAX_STEPS}')
    print()

    findings = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={'width': 1280, 'height': 720})
        page = await context.new_page()

        # Navigate to URL
        print(f'[Step 0] Navigating to {url}')
        await page.goto(url, wait_until='networkidle')

        for step in range(1, MAX_STEPS + 1):
            # Take screenshot
            screenshot_path = await take_screenshot(page, step)

            # Read screenshot as bytes
            with open(screenshot_path, 'rb') as f:
                screenshot_bytes = f.read()

            # Send to Gemini with goal
            prompt = (
                f'You are a QA tester. Your goal: {goal}\n\n'
                f'This is step {step}/{MAX_STEPS}. '
                f'Current URL: {page.url}\n\n'
                'Look at this screenshot and:\n'
                '1. Describe what you see\n'
                '2. Report any bugs, broken UI, or issues\n'
                '3. If the goal is achieved, say DONE\n'
                '4. Otherwise, suggest the next action to take\n\n'
                'Format your response as:\n'
                'OBSERVATION: <what you see>\n'
                'BUGS: <any issues found, or "none">\n'
                'STATUS: <DONE or CONTINUE>\n'
                'NEXT_ACTION: <what to do next, or "none">'
            )

            try:
                response = client.models.generate_content(
                    model=MODEL,
                    contents=[
                        types.Content(
                            role='user',
                            parts=[
                                types.Part.from_text(text=prompt),
                                types.Part.from_bytes(data=screenshot_bytes, mime_type='image/png'),
                            ],
                        ),
                    ],
                    config=config,
                )

                result_text = response.text if hasattr(response, 'text') else str(response)
                print(f'\n[Step {step}] Gemini response:')
                print(result_text[:500])

                # Check for bugs
                if 'BUGS:' in result_text:
                    bugs_line = [line for line in result_text.split('\n') if line.startswith('BUGS:')]
                    if bugs_line and 'none' not in bugs_line[0].lower():
                        findings.append(
                            {
                                'step': step,
                                'url': page.url,
                                'bug': bugs_line[0].replace('BUGS:', '').strip(),
                                'screenshot': screenshot_path,
                            }
                        )

                # Check if done
                if 'STATUS: DONE' in result_text or 'DONE' in result_text.upper():
                    print(f'\n[Step {step}] Goal achieved!')
                    break

                # Check for navigation suggestions in response
                if 'NEXT_ACTION: navigate' in result_text.lower() or 'NEXT_ACTION: click' in result_text.lower():
                    # Extract URL if suggested
                    for line in result_text.split('\n'):
                        if 'navigate' in line.lower() and 'http' in line:
                            urls = re.findall(r'https?://\S+', line)
                            if urls:
                                print(f'  Navigating to: {urls[0]}')
                                await page.goto(urls[0], wait_until='networkidle')

            except Exception as e:
                print(f'[Step {step}] Error: {e}')
                break

            # Small delay between steps
            await asyncio.sleep(1)

        await browser.close()

    # Report findings
    print('\n' + '=' * 60)
    print('  MARINER AGENT REPORT')
    print('=' * 60)
    if findings:
        print(f'\n  Bugs found: {len(findings)}')
        for f in findings:
            print(f'  - Step {f["step"]}: {f["bug"]}')
            print(f'    URL: {f["url"]}')
            print(f'    Screenshot: {f["screenshot"]}')
    else:
        print('\n  No bugs found!')
    print()


if __name__ == '__main__':
    url = sys.argv[1] if len(sys.argv) > 1 else 'https://oauth2.rocketride.ai/health'
    goal = sys.argv[2] if len(sys.argv) > 2 else 'Explore the page and find any bugs, broken UI elements, or issues'

    asyncio.run(run_mariner_agent(url, goal))
