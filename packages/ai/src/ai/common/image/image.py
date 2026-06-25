import io
import base64
from PIL import Image
from rocketlib import debug


class ImageProcessor:
    """
    A class to handle image loading, processing, thumbnail creation, and encoding operations using the Pillow library.
    """

    @staticmethod
    def load_image_from_bytes(image_data: bytes) -> Image:
        """
        Load an image from raw bytes into a fully-decoded Pillow Image.

        Opens the bytes with Pillow and forces a full decode (``load()``) so the
        image stays usable after the source buffer is released. The image keeps its
        original mode/format; callers use the pixel data, not ``.format``.

        Args:
            image_data (bytes): The raw image data in bytes.

        Returns:
            Image: A fully-loaded Pillow Image, or None on failure.

        Raises:
            ValueError: If no image data is provided.
        """
        if not image_data:
            raise ValueError('No image data provided')

        try:
            # Decode once; load() forces a full read so the image detaches from the
            # buffer (replaces a costly format-normalizing PNG re-encode round-trip).
            image = Image.open(io.BytesIO(image_data))
            image.load()
            return image

        except Exception as e:
            # Log the exception with debug and return None to indicate failure
            debug(f'Error processing image: {e}')
            return None

    @staticmethod
    def load_image_from_base64(image_str: str) -> Image:
        # Decode the base64 image
        image_bytes = base64.b64decode(image_str)

        # Use the get_image_from_bytes method to convert bytes to a Pillow Image
        return ImageProcessor.load_image_from_bytes(image_bytes)

    @staticmethod
    def resize_image(image: Image, width: int, height: int) -> Image:
        """
        Resize an image to the specified width and height using LANCZOS filter.

        Args:
            image (Image): Pillow Image object to resize.
            width (int): Target width.
            height (int): Target height.

        Returns:
            Image: Resized Pillow Image.
        """
        return image.resize((width, height), resample=Image.LANCZOS)

    @staticmethod
    def get_thumbnail(image: Image, target_size: int = 128) -> Image:
        """
        Create a centered 128x128 pixel thumbnail from the provided image.

        This method performs:
        - Stepwise downscaling by half until the larger side is <= 2 * target size,
        which is efficient and avoids aliasing.
        - A final thumbnail resize preserving aspect ratio with Pillow's thumbnail().
        - A center crop to exactly 128x128 pixels.

        Args:
            image (Image): A Pillow Image object to generate a thumbnail from.

        Returns:
            Image: A new Pillow Image object of size 128x128 pixels.
        """
        # Work on a copy of the image to avoid modifying the original
        image = image.copy()

        # Stepwise downscale if the image is much larger than needed
        while max(image.width, image.height) > 2 * target_size:
            # Use generic resize_image function to downscale by half
            image = ImageProcessor.resize_image(image, image.width // 2, image.height // 2)

        # Resize image preserving aspect ratio so the largest side is at most 256 pixels
        image.thumbnail((target_size * 2, target_size * 2), Image.LANCZOS)

        # Calculate coordinates to center-crop the image to 128x128 pixels
        left = (image.width - target_size) // 2
        top = (image.height - target_size) // 2
        right = left + target_size
        bottom = top + target_size

        # Perform the crop and return the thumbnail
        thumbnail = image.crop((left, top, right, bottom))
        return thumbnail

    @staticmethod
    def get_bytes(image: Image, fmt: str = 'PNG', quality: int = 90, compress_level: int = 6) -> bytes:
        """
        Encode a Pillow Image to bytes.

        PNG by default (preserves alpha). Pass ``fmt='JPEG'`` for a smaller/faster
        encode; non-RGB modes (e.g. RGBA) are coerced to RGB since JPEG has no alpha.

        Args:
            image (Image): The Pillow Image object to convert.
            fmt (str): 'PNG' (default) or 'JPEG'.
            quality (int): JPEG quality (ignored for PNG).
            compress_level (int): PNG zlib level 0-9 (ignored for non-PNG). Default 6
                matches Pillow. Lower trades file size for speed — e.g. 1 cuts a 30 MP
                RGBA encode from ~16 s to ~2-3 s, which matters for full-res cutouts.

        Returns:
            bytes: The encoded image data.
        """
        buffered = io.BytesIO()
        if fmt.upper() in ('JPEG', 'JPG'):
            if image.mode not in ('RGB', 'L'):
                image = image.convert('RGB')
            image.save(buffered, format='JPEG', quality=quality)
        elif fmt.upper() == 'PNG':
            image.save(buffered, format='PNG', compress_level=compress_level)
        else:
            image.save(buffered, format=fmt)
        return buffered.getvalue()

    @staticmethod
    def get_base64(image: Image) -> str:
        """
        Encode a Pillow Image as a base64 string in PNG format.

        This method saves the image as PNG to preserve transparency and full color data,
        then encodes the in-memory bytes to a base64 string suitable for embedding
        in data URIs or JSON.

        Args:
            image (Image): Pillow Image object to encode.

        Returns:
            str: Base64-encoded PNG string.
        """
        buffered = io.BytesIO()

        # Save image as PNG to buffer (supports transparency)
        image.save(buffered, format='PNG')

        # Get byte content of buffer
        img_bytes = buffered.getvalue()

        # Return base64 encoded string
        return base64.b64encode(img_bytes).decode('utf-8')
