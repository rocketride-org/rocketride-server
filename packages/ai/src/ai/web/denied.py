CONST_OTHER_TEXT = '{}'

CONST_OTHER_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>Error</title>
</head>
<body>
    <h1>Error</h1>
    <p>{}</p>
</body>
</html>
"""

CONST_ACCESS_DENIED_TEXT = 'Access denied'

CONST_ACCESS_DENIED_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>401 - Access Denied</title>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}

        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #2c3e50;
        }}

        .container {{
            background: white;
            padding: 60px 40px;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.1);
            text-align: center;
            max-width: 500px;
            width: 90%;
        }}

        .dog-scene {{
            margin-bottom: 40px;
            position: relative;
        }}

        .doghouse {{
            width: 120px;
            height: 80px;
            background: #8B4513;
            margin: 0 auto 20px;
            border-radius: 10px;
            position: relative;
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
        }}

        .doghouse::before {{
            content: '';
            position: absolute;
            top: -30px;
            left: -10px;
            width: 0;
            height: 0;
            border-left: 70px solid transparent;
            border-right: 70px solid transparent;
            border-bottom: 40px solid #654321;
        }}

        .doghouse-door {{
            width: 35px;
            height: 45px;
            background: #2c3e50;
            border-radius: 50% 50% 0 0;
            margin: 15px auto 0;
        }}

        .dog {{
            width: 80px;
            height: 60px;
            background: #DEB887;
            border-radius: 50px;
            margin: 20px auto;
            position: relative;
            animation: wag 2s ease-in-out infinite;
        }}

        .dog::before {{
            content: '';
            position: absolute;
            width: 40px;
            height: 35px;
            background: #DEB887;
            border-radius: 50%;
            top: -25px;
            left: 45px;
        }}

        .dog::after {{
            content: '';
            position: absolute;
            width: 20px;
            height: 20px;
            background: #CD853F;
            border-radius: 50%;
            top: -20px;
            left: 55px;
        }}

        .ears {{
            position: absolute;
            width: 15px;
            height: 20px;
            background: #CD853F;
            border-radius: 50%;
            top: -35px;
            left: 45px;
        }}

        .ears::after {{
            content: '';
            position: absolute;
            width: 15px;
            height: 20px;
            background: #CD853F;
            border-radius: 50%;
            left: 20px;
        }}

        .tail {{
            position: absolute;
            width: 25px;
            height: 8px;
            background: #DEB887;
            border-radius: 10px;
            top: 10px;
            left: -20px;
            transform-origin: right center;
            animation: tailWag 1s ease-in-out infinite;
        }}

        @keyframes wag {{
            0%, 100% {{ transform: translateX(0); }}
            50% {{ transform: translateX(5px); }}
        }}

        @keyframes tailWag {{
            0%, 100% {{ transform: rotate(0deg); }}
            50% {{ transform: rotate(30deg); }}
        }}

        .error-code {{
            font-size: 4rem;
            font-weight: 700;
            color: #e74c3c;
            margin-bottom: 20px;
        }}

        .title {{
            font-size: 1.8rem;
            font-weight: 600;
            color: #2c3e50;
            margin-bottom: 15px;
        }}

        .message {{
            font-size: 1.1rem;
            color: #7f8c8d;
            line-height: 1.6;
            margin-bottom: 30px;
        }}

        .dog-thought {{
            background: #ecf0f1;
            padding: 20px;
            border-radius: 15px;
            margin: 30px 0;
            position: relative;
            font-style: italic;
            color: #34495e;
        }}

        .dog-thought::before {{
            content: '';
            position: absolute;
            bottom: -10px;
            left: 30px;
            width: 0;
            height: 0;
            border-left: 10px solid transparent;
            border-right: 10px solid transparent;
            border-top: 10px solid #ecf0f1;
        }}

        .btn {{
            background: #3498db;
            color: white;
            padding: 12px 30px;
            border: none;
            border-radius: 8px;
            font-size: 1rem;
            cursor: pointer;
            transition: background 0.3s ease;
            margin: 0 10px;
            text-decoration: none;
            display: inline-block;
        }}

        .btn:hover {{
            background: #2980b9;
            transform: translateY(-1px);
        }}

        .btn-secondary {{
            background: #95a5a6;
        }}

        .btn-secondary:hover {{
            background: #7f8c8d;
        }}

        .footer-text {{
            margin-top: 30px;
            font-size: 0.9rem;
            color: #bdc3c7;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="dog-scene">
            <div class="doghouse">
                <div class="doghouse-door"></div>
            </div>

            <div class="dog">
                <div class="ears"></div>
                <div class="tail"></div>
            </div>
        </div>

        <div class="error-code">401</div>

        <h1 class="title">Woof! Access Denied</h1>

        <p class="message">
            Looks like you don't have the right credentials to enter this area.
            Our guard dog is keeping watch, but don't worry – he's friendly!
        </p>

        <div class="dog-thought">
            "I'd let you in, but I need to see some ID first! 🐕"
        </div>

        <div style="margin-top: 40px;">
            <button class="btn" onclick="window.location.reload()">
                Try Again
            </button>
            <button class="btn btn-secondary" onclick="window.history.back()">
                Go Back
            </button>
        </div>

        <p class="footer-text">
            Please contact your administrator if you believe this is an error.
        </p>
    </div>
</body>
</html>
"""
