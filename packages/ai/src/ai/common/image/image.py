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
        Load an image from raw bytes and ensure it is in PNG format internally.

        This method attempts to open the image data using Pillow's Image.open().
        If the loaded image format is not PNG, it converts the image to PNG in memory,
        reopening it from the PNG buffer to normalize the format.

        Args:
            image_data (bytes): The raw image data in bytes.

        Returns:
            Image: A Pillow Image object guaranteed to be in PNG format.

        Raises:
            ValueError: If no image data is provided.

        Notes:
            - The .copy() call after reopening the PNG buffer is necessary to avoid
              issues related to the underlying buffer being closed once the BytesIO
              context manager exits.
            - This method may raise or return None on failure; the caller should check.
        """
        if not image_data:
            raise ValueError('No image data provided')

        try:
            # Open the image from bytes buffer
            image = Image.open(io.BytesIO(image_data))

            # Check the image format; if not PNG, convert to PNG in-memory
            if image.format != 'PNG':
                with io.BytesIO() as png_buffer:
                    # Save the image as PNG into the in-memory buffer
                    image.save(png_buffer, format='PNG')

                    # Rewind the buffer to the beginning before reading
                    png_buffer.seek(0)

                    # Re-open the image from the PNG buffer and copy to detach from buffer
                    image = Image.open(png_buffer).copy()

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
    def get_bytes(image: Image) -> bytes:
        """
        Convert a Pillow Image to PNG format bytes.

        This method saves the image as PNG to preserve transparency and full color data.
        No conversion to RGB is needed since PNG supports RGBA and other modes.

        Args:
            image (Image): The Pillow Image object to convert.

        Returns:
            bytes: The PNG image data.
        """
        buffered = io.BytesIO()

        # Save image to buffer in PNG format (supports transparency)
        image.save(buffered, format='PNG')

        # Retrieve byte data from buffer
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
