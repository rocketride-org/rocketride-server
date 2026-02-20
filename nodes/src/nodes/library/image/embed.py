# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

import base64
import requests

from bs4 import BeautifulSoup
from urllib.parse import urlparse, urlunparse, ParseResult

from rocketlib import debug


def embed_images_in_html(html_content: str, default_scheme: str, default_site: str) -> str:
    """Modify the HTML to replace external image links with embedded Base64-encoded images.

    Args:
        html_content (str): HTML content
        default_scheme (str): Scheme to use for image URLs if not specified
        default_site (str): Site to use for image URLs if not specified

    Returns:
        str: modified content
    """
    # Parse the HTML content
    soup = BeautifulSoup(html_content, 'html.parser')

    # Find all image tags
    images = soup.find_all('img')

    for img in images:
        try:
            image_url = img['src']

            parse_result: ParseResult = urlparse(image_url)
            if not parse_result.scheme:
                image_url = urlunparse((default_scheme, default_site, image_url, '', '', ''))

            # Download the image
            debug(f'Processing image URL: {image_url}')

            # Check if the image URL is valid
            response = requests.get(image_url)
            response.raise_for_status()
            image_data = response.content

            if image_data:
                # Convert the image to base64
                base64_image = base64.b64encode(image_data).decode('utf-8')

                # Guess the image MIME type
                if image_url.lower().endswith('.png'):
                    mime_type = 'image/png'
                elif image_url.lower().endswith('.jpg') or image_url.lower().endswith('.jpeg'):
                    mime_type = 'image/jpeg'
                elif image_url.lower().endswith('.gif'):
                    mime_type = 'image/gif'
                else:
                    mime_type = 'image/png'  # Default to PNG if MIME type is uncertain

                # Create the data URI for embedding
                img['src'] = f'data:{mime_type};base64,{base64_image}'
        except Exception as e:
            debug(f"Error fetching image URL '{image_url}': {e}")
            continue

    # Return the modified HTML
    return str(soup)
