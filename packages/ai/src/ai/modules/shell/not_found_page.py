# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""The engine's own 404 page, for a browser or crawler on an address nothing serves.

The page in the style of the server's Access Denied page (``ai.web.denied``),
saying the page is not there instead of asking for credentials. Both buttons
go to ``/``: sign-in starts from the shell there, and no URL starts it. Self
contained (no scripts, fonts or images), with ``noindex`` and no canonical
URL, light and dark, and readable on a phone.
"""

NOT_FOUND_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex">
    <meta name="color-scheme" content="light dark">
    <title>404 - Page Not Found</title>
    <style>
        :root {
            --bg-from: #f5f7fa;
            --bg-to: #c3cfe2;
            --card: #ffffff;
            --ink: #2c3e50;
            --muted: #5f6b6d;
            --thought: #ecf0f1;
            --code: #e67e22;
            --btn: #2471a3;
            --btn-hover: #1a5276;
            --btn-2: #5f6b6d;
            --btn-2-hover: #4a5456;
            --shadow: rgba(0, 0, 0, 0.1);
        }

        @media (prefers-color-scheme: dark) {
            :root {
                --bg-from: #11161c;
                --bg-to: #1f2a36;
                --card: #18202a;
                --ink: #e8edf2;
                --muted: #aab4bd;
                --thought: #243040;
                --code: #f0a35e;
                --btn: #3b8fd0;
                --btn-hover: #5aa5de;
                --btn-2: #4b5a69;
                --btn-2-hover: #5d6d7e;
                --shadow: rgba(0, 0, 0, 0.45);
            }
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, var(--bg-from) 0%, var(--bg-to) 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            color: var(--ink);
        }

        .container {
            background: var(--card);
            padding: 48px 32px;
            border-radius: 20px;
            box-shadow: 0 20px 60px var(--shadow);
            text-align: center;
            max-width: 500px;
            width: 100%;
        }

        .dog-scene { margin-bottom: 32px; }

        .doghouse {
            width: 120px;
            height: 80px;
            background: #8b4513;
            margin: 30px auto 20px;
            border-radius: 10px;
            position: relative;
        }

        .doghouse::before {
            content: '';
            position: absolute;
            top: -30px;
            left: -10px;
            border-left: 70px solid transparent;
            border-right: 70px solid transparent;
            border-bottom: 40px solid #654321;
        }

        .doghouse-door {
            width: 35px;
            height: 45px;
            background: #2c3e50;
            border-radius: 50% 50% 0 0;
            margin: 15px auto 0;
            position: relative;
            top: 20px;
        }

        .dog {
            width: 80px;
            height: 60px;
            background: #deb887;
            border-radius: 50px;
            margin: 20px auto;
            position: relative;
            animation: sniff 2s ease-in-out infinite;
        }

        .dog::before {
            content: '';
            position: absolute;
            width: 40px;
            height: 35px;
            background: #deb887;
            border-radius: 50%;
            top: -25px;
            left: 45px;
        }

        .dog::after {
            content: '';
            position: absolute;
            width: 20px;
            height: 20px;
            background: #cd853f;
            border-radius: 50%;
            top: -20px;
            left: 55px;
        }

        .tail {
            position: absolute;
            width: 25px;
            height: 8px;
            background: #deb887;
            border-radius: 10px;
            top: 10px;
            left: -20px;
            transform-origin: right center;
            animation: wag 1s ease-in-out infinite;
        }

        @keyframes sniff {
            0%, 100% { transform: translateX(0); }
            50% { transform: translateX(8px); }
        }

        @keyframes wag {
            0%, 100% { transform: rotate(0deg); }
            50% { transform: rotate(30deg); }
        }

        @media (prefers-reduced-motion: reduce) {
            .dog, .tail { animation: none; }
        }

        .error-code {
            font-size: 4rem;
            font-weight: 700;
            color: var(--code);
            margin-bottom: 12px;
        }

        h1 {
            font-size: 1.8rem;
            font-weight: 600;
            margin-bottom: 15px;
        }

        .message {
            font-size: 1.1rem;
            color: var(--muted);
            line-height: 1.6;
        }

        .dog-thought {
            background: var(--thought);
            padding: 18px;
            border-radius: 15px;
            margin: 28px 0;
            font-style: italic;
        }

        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            justify-content: center;
        }

        .btn {
            background: var(--btn);
            color: #ffffff;
            padding: 12px 28px;
            border-radius: 8px;
            font-size: 1rem;
            text-decoration: none;
            display: inline-block;
        }

        .btn:hover { background: var(--btn-hover); }
        .btn:focus-visible { outline: 3px solid var(--code); outline-offset: 3px; }
        .btn-secondary { background: var(--btn-2); }
        .btn-secondary:hover { background: var(--btn-2-hover); }
    </style>
</head>
<body>
    <main class="container">
        <div class="dog-scene" aria-hidden="true">
            <div class="doghouse"><div class="doghouse-door"></div></div>
            <div class="dog"><div class="tail"></div></div>
        </div>
        <p class="error-code">404</p>
        <h1>Woof! Page not found</h1>
        <p class="message">
            We sniffed everywhere, but there is no page at this address.
            It may have moved, or the link may have a typo.
        </p>
        <p class="dog-thought">"It was right here a minute ago... I think."</p>
        <div class="actions">
            <a class="btn" href="/">Go to the home page</a>
            <a class="btn btn-secondary" href="/">Sign in</a>
        </div>
    </main>
</body>
</html>
"""
