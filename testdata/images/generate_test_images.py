"""
Generate test images for OCR node testing.

Creates images with:
1. Plain text - for text lane testing
2. Simple table - for table lane testing
3. Text and table combined - for full OCR testing
"""

from PIL import Image, ImageDraw, ImageFont
import os

# Output directory
OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))


def get_font(size=20):
    """Get a font, falling back to default if needed."""
    try:
        # Try common system fonts
        for font_name in ['arial.ttf', 'Arial.ttf', 'DejaVuSans.ttf', 'LiberationSans-Regular.ttf']:
            try:
                return ImageFont.truetype(font_name, size)
            except OSError:
                continue
        # Fallback to default
        return ImageFont.load_default()
    except Exception:
        return ImageFont.load_default()


def create_text_image():
    """Create an image with plain text."""
    img = Image.new('RGB', (600, 200), color='white')
    draw = ImageDraw.Draw(img)
    font = get_font(24)

    text = """The quick brown fox jumps over the lazy dog.
This is a test image for OCR processing.
It contains multiple lines of text."""

    draw.text((20, 20), text, fill='black', font=font)

    path = os.path.join(OUTPUT_DIR, 'ocr_test_text.png')
    img.save(path)
    print(f'Created: {path}')
    return path


def create_table_image():
    """Create an image with a simple table."""
    img = Image.new('RGB', (500, 250), color='white')
    draw = ImageDraw.Draw(img)
    font = get_font(16)

    # Table dimensions
    x_start, y_start = 50, 30
    col_width = 120
    row_height = 40
    rows = 4
    cols = 3

    # Draw table grid
    for i in range(rows + 1):
        y = y_start + i * row_height
        draw.line([(x_start, y), (x_start + cols * col_width, y)], fill='black', width=2)

    for j in range(cols + 1):
        x = x_start + j * col_width
        draw.line([(x, y_start), (x, y_start + rows * row_height)], fill='black', width=2)

    # Table data
    data = [
        ['Name', 'Age', 'City'],
        ['Alice', '30', 'New York'],
        ['Bob', '25', 'Chicago'],
        ['Carol', '35', 'Boston'],
    ]

    # Draw text in cells
    for i, row in enumerate(data):
        for j, cell in enumerate(row):
            x = x_start + j * col_width + 10
            y = y_start + i * row_height + 10
            draw.text((x, y), cell, fill='black', font=font)

    path = os.path.join(OUTPUT_DIR, 'ocr_test_table.png')
    img.save(path)
    print(f'Created: {path}')
    return path


def create_mixed_image():
    """Create an image with both text and a table."""
    img = Image.new('RGB', (600, 400), color='white')
    draw = ImageDraw.Draw(img)
    font = get_font(18)
    header_font = get_font(22)

    # Header text
    draw.text((20, 20), 'Quarterly Sales Report', fill='black', font=header_font)
    draw.text((20, 50), 'Below is the summary of sales data:', fill='black', font=font)

    # Table dimensions
    x_start, y_start = 50, 100
    col_width = 130
    row_height = 35
    rows = 5
    cols = 3

    # Draw table grid
    for i in range(rows + 1):
        y = y_start + i * row_height
        draw.line([(x_start, y), (x_start + cols * col_width, y)], fill='black', width=2)

    for j in range(cols + 1):
        x = x_start + j * col_width
        draw.line([(x, y_start), (x, y_start + rows * row_height)], fill='black', width=2)

    # Table data
    data = [
        ['Product', 'Q1 Sales', 'Q2 Sales'],
        ['Widget A', '$12,500', '$15,200'],
        ['Widget B', '$8,300', '$9,100'],
        ['Widget C', '$22,000', '$24,500'],
        ['Total', '$42,800', '$48,800'],
    ]

    # Draw text in cells
    for i, row in enumerate(data):
        for j, cell in enumerate(row):
            x = x_start + j * col_width + 10
            y = y_start + i * row_height + 8
            draw.text((x, y), cell, fill='black', font=font)

    # Footer text
    draw.text((20, 290), 'Note: All figures are in USD.', fill='gray', font=font)
    draw.text((20, 320), 'Report generated for testing purposes.', fill='gray', font=font)

    path = os.path.join(OUTPUT_DIR, 'ocr_test_mixed.png')
    img.save(path)
    print(f'Created: {path}')
    return path


if __name__ == '__main__':
    print('Generating OCR test images...')
    create_text_image()
    create_table_image()
    create_mixed_image()
    print('Done!')
