import threading
import errno
import tempfile
import os
import imageio_ffmpeg as ffmpeg
import subprocess
from abc import ABC, abstractmethod
from typing import List
from rocketlib import AVI_ACTION, debug


class AVIReader(ABC):
    @abstractmethod
    def onData(self, data: bytes):
        pass

    @abstractmethod
    def onInfo(self, info: List[str]):
        pass

    def __init__(self, args: List[str], name: str, **kwargs):
        """Initialize the audio player."""
        # Set to not started
        self._started = False

        self._isStdinCompatible = False
        self._cache = None

        # Save the name for future errors
        self._name = name

        # Save the lock if provided
        self._lock_mutex = kwargs.get('lock', None)
        self._lock_owner = False

        # Save the info for start!
        self._args = args

        # How much data we are going to read from/write to stdio ar once
        self._write_chunk_size = 16 * 1024  # adjust for optimal performance
        self._read_chunk_size = 16 * 1024  # adjust for optimal performance

    def __del__(self):
        """
        Cleanup resources when the object is deleted.
        """
        # If we are started, stop it
        if self._started:
            self.stop()

        # Cleanup resources
        self._cleanup()

    def _cleanup(self):
        """
        Cleanup resources after stopping the reader.
        """
        # If we used a cache file and created it, remove it
        if not self._isStdinCompatible and self._cache:
            try:
                # Get the full path
                file = self._cache.name

                # Clear it
                self._cache = None

                # Remove it - okay if we can't
                os.remove(file)
            except Exception:
                pass

        # If we have a lock, release it
        self._unlock()

    def _data_process(self):
        """Read decoded buffer from FFmpeg's stdout and call the callback."""
        while True:
            # Read data from FFmpeg's stdout
            data = self.stdout.read(self._read_chunk_size)  # Adjust the size if needed

            # Was stderr closed?
            if not data:
                break

            try:
                self.onData(data)  # Call the callback with the read data
            except Exception as e:
                debug('[Reader] Error in data callback: {}'.format(e))

        # Signal callback we are done
        self.onData(None)

    def _info_process(self):
        """Read decoded buffer from FFmpeg's stderr and call the callback."""
        while True:
            # Read data from FFmpeg's stdout
            info = self.stderr.readline(self._read_chunk_size)  # Adjust the size if needed

            # Was stderr closed?
            if not info:
                break

            # Convert to a string
            infostr = info.decode('utf-8', 'replace')
            debug(infostr)

            # Split it at \r. This happens when ffmpeg outputs progress
            # info to the console
            lines = infostr.split('\r')
            for line in lines:
                # Remove any white space
                value = line.strip()

                # If there is some data, call the callback
                if not value:
                    continue

                try:
                    self.onInfo(value)  # Call the callback with the read data
                except Exception as e:
                    debug('[Reader] Error in info callback: {}'.format(e))

        # Signal callback we are done
        self.onInfo(None)

    def _watch_process(self):
        """
        Watch the ffmpeg process and wait for it to finish.
        """
        self._exit_code = self._ffmpeg_process.wait()
        self._done = True

        debug(f'[Reader] {self._name} exited with code {self._exit_code}')

    def _detect_media_format_and_stdin_compat(self, data: bytes) -> tuple[str | None, bool]:
        """
        Detect common video/audio file formats from the first chunk of bytes (up to 16KB).

        Returns a tuple (format_name: str or None, is_stdin_compatible: bool).

        Formats that are "compatible with stdin" are generally raw streams or
        container formats that ffmpeg can handle piped input for.
        """
        if len(data) < 16:
            return None, False

        def check_bytes(offset: int, signature: bytes) -> bool:
            return data[offset : offset + len(signature)] == signature

        # Stdin compatibility dictionary for detected formats:
        # From previous info:
        # mp4/mov: False (not stdin friendly)
        # mpeg-ts: True
        # webm/mkv: False
        # avi: False
        # flv: True
        # asf/wmv: False
        # raw h264: True
        # mp3: True
        # wav: True
        # ogg: True
        # aac (ADTS): True
        # flac: True
        # mov/qt: False

        # Check signatures and return with compatibility

        if len(data) > 12 and check_bytes(4, b'ftyp'):
            ftyp_brand = data[8:12]
            known_brands = [b'isom', b'iso2', b'avc1', b'mp41', b'mp42', b'qt  ']
            if ftyp_brand in known_brands:
                return 'mp4/mov', False

        if len(data) > 188 * 5:
            if all(data[i * 188] == 0x47 for i in range(5)):
                return 'mpeg-ts', True

        if check_bytes(0, b'\x1a\x45\xdf\xa3'):
            if b'webm' in data[:16384].lower():
                return 'webm', False
            return 'matroska/mkv', False

        if check_bytes(0, b'RIFF') and len(data) > 12:
            if check_bytes(8, b'AVI '):
                return 'avi', False
            if check_bytes(8, b'WAVE'):
                return 'wav', True

        if check_bytes(0, b'FLV'):
            return 'flv', True

        if check_bytes(0, bytes.fromhex('3026B2758E66CF11A6D900AA0062CE6C')):
            return 'asf/wmv', False

        if check_bytes(0, b'\x00\x00\x00\x01') or check_bytes(0, b'\x00\x00\x01'):
            return 'raw h264', True

        if len(data) > 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
            return 'mp3', True

        if check_bytes(0, b'OggS'):
            return 'ogg', True

        if len(data) > 2 and (data[0] & 0xFF) == 0xFF and (data[1] & 0xF0) == 0xF0:
            return 'aac (ADTS)', True

        if check_bytes(0, b'fLaC'):
            return 'flac', True

        if b'moov' in data[:16384]:
            return 'mov/qt', False

        return None, False

    def _start_decoder(self):
        """
        Create a ffmpeg process and returns it.

        This is used to create a subprocess for feeding into another AVIPReader.
        """
        # Get the executable path for FFmpeg
        ffexec = ffmpeg.get_ffmpeg_exe()

        # If we have to use a cache file, create one here
        if self._isStdinCompatible:
            # Send data via stdin
            input = ['-i', '-']  # Use stdin as input
        else:
            # Set it up to read from this file
            input = ['-i', self._cache.name]  # Use a cache file as input

        # Add it to the args
        ffargs = [ffexec] + input + self._args

        # print the arguments
        debug(f'[Reader] Starting {self._name} with args: {" ".join(ffargs)}')

        # Start FFmpeg process
        self._ffmpeg_process = subprocess.Popen(ffargs, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=16384)

        # If we could not start the process, raise an error
        if not self._ffmpeg_process:
            raise RuntimeError(f'[Reader] Unable to start {self._name} process')

        # Grab the stdio and return the process
        self.stdin = self._ffmpeg_process.stdin
        self.stdout = self._ffmpeg_process.stdout
        self.stderr = self._ffmpeg_process.stderr

        # Watch for ffmpeg termination
        self._watch_thread = threading.Thread(target=self._watch_process, name='avi_reader_terminate', daemon=True)
        self._watch_thread.start()

        # Start a thread to handle FFmpeg's stdout reading
        self._data_thread = threading.Thread(target=self._data_process, name='avi_reader_data', daemon=True)
        self._data_thread.start()

        # Start a thread to handle FFmpeg's stderr reading
        self._info_thread = threading.Thread(target=self._info_process, name='avi_reader_info', daemon=True)
        self._info_thread.start()

    def _lock(self):
        """
        Acquire the associated lock, if it exists, and mark this instance as the owner.
        """
        if self._lock_mutex:
            self._lock_mutex.acquire()
            self._lock_owner = True

    def _unlock(self):
        """
        Release the associated lock only if this instance currently owns it.
        """
        if self._lock_mutex and self._lock_owner:
            self._lock_mutex.release()
            self._lock_owner = False

    def start(self, *, input=None, output=None):
        """
        Start the reading process.

        This may defer the actual starting of the process until the first block of data
        is written so we can tell if we need to cache it or pipe it.
        """
        # Check if this is already started
        if self._started:
            raise RuntimeError(f'[Reader]: {self._name} is already started')
        self._started = True

        # Setup for detection
        self._firstBlock = True
        self._media_type = None
        self._isStdinCompatible = False

        # Done is set when ffmpeg terminates
        self._done = False
        self._exit_code = 0

        # Player process states
        self._data_thread = None
        self._info_thread = None
        self._watch_thread = None
        self._ffmpeg_process = None
        self._cache = None

        self.stdin = None
        self.stdout = None
        self.stderr = None

    def stop(self):
        """
        Clean up resources and wait for thread to finish.
        """
        debug(f'[Reader] Stopping {self._name}')

        # If we are not started, we don't need to do anything
        if not self._started:
            return
        self._started = False

        # Now, if we are writing to a cache file, we need to process the
        # everything we gathered
        if not self._isStdinCompatible and self._cache:
            # Close the cache file
            self._cache.close()

            # Start the decoder
            self._start_decoder()

            # Wait for it to finish
            self._ffmpeg_process.wait()
        else:
            # Close ffmpeg stdin to signal end of input
            if self.stdin:
                try:
                    self.stdin.close()
                except Exception:
                    # If we are done, we don't care about the error
                    pass

            # Close ffmpeg process and ensure it completes
            if self._ffmpeg_process:
                try:
                    self._ffmpeg_process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self._ffmpeg_process.kill()

        # Wait for data thread to finish reading ffmpeg stdout
        if self._watch_thread and self._watch_thread.is_alive():
            self._watch_thread.join()

        # Wait for data thread to finish reading ffmpeg stdout
        if self._data_thread and self._data_thread.is_alive():
            self._data_thread.join()

        # Wait for info thread to finish reading ffmpeg stdout
        if self._info_thread and self._info_thread.is_alive():
            self._info_thread.join()

        # Close ffmpeg process
        if self.stdout:
            try:
                self.stdout.close()
            except Exception:
                pass

        if self.stderr:
            try:
                self.stderr.close()
            except Exception:
                pass

        # Cleanup resources
        self._cleanup()

        # Cleanup so things are released
        self._data_thread = None
        self._info_thread = None
        self._watch_thread = None
        self._ffmpeg_process = None
        self.stdin = None
        self.stdout = None
        self.stderr = None

    def write(self, buffer: bytes):
        """Send buffer to FFmpeg for decoding."""
        # Make sure we are started
        if not self._started:
            raise Exception(f'[Reader]: {self._name} is not started')

        # If the ffmpeg process is done, we don't need to write anything since
        # it terminated, it is complete but we still need to send blocks through
        if self._done:
            if self._exit_code != 0:
                raise Exception(f'[Reader]: {self._name} terminated with error {self._exit_code}')
            return

        # If this is the first block, we need to kick everything off
        if self._firstBlock:
            # Determine the media type and stdin compatibility
            self._media_type, self._isStdinCompatible = self._detect_media_format_and_stdin_compat(buffer)

            # If we have to cache it
            if not self._isStdinCompatible:
                # We have to use a cache file - delay the start
                self._cache = tempfile.NamedTemporaryFile(delete=False, mode='wb', suffix='.avi', prefix='media_')

                # Debug
                debug(f'[Reader] Caching {self._name} data to {self._cache.name}')
            else:
                # Debug
                debug(f'[Reader] {self._name} is compatible with stdin, will not cache data')

                # We can start it now
                self._start_decoder()

            # We have done the detection
            self._firstBlock = False

        # If we are writing to to a pipe, do so now
        if self._isStdinCompatible:
            # Get the total length to send and send it in chunks
            total_len = len(buffer)
            for i in range(0, total_len, self._write_chunk_size):
                chunk = buffer[i : i + self._write_chunk_size]
                try:
                    self.stdin.write(chunk)

                except BrokenPipeError:
                    # This occurs if ffmpeg terminates before we finish writing due
                    # to it fulfilling all the requests and the watcher hasn't kicked in yet.
                    return

                except OSError as e:
                    if e.errno == errno.EPIPE:
                        # Broken pipe error, normal termination
                        return
                    elif e.errno == errno.EINVAL:
                        # Invalid argument, treat similarly as broken pipe
                        return
                    else:
                        raise RuntimeError(f'[Reader] Error writing to {self._name} stdin: {e}')

                except Exception as e:
                    raise RuntimeError(f'[Reader] Error writing to {self._name} stdin: {e}')
        else:
            # Save it to the cache file
            self._cache.write(buffer)

    def writeAVI(self, action: AVI_ACTION, mimeType: str, buffer: bytes):
        """
        Easy interface to handle standard AVI actions, both audio and video.

        - Acquires the lock only on BEGIN.
        - Releases the lock only on END.
        - WRITE simply writes data and assumes BEGIN has already occurred.
        """
        if action == AVI_ACTION.BEGIN:
            try:
                # Lock it if we need to
                self._lock()

                # Start the reader process
                self.start()

            except Exception:
                # If an error occurs, release the lock (if acquired)
                self._unlock()

                # Reraise the exception to propagate the error
                raise

        elif action == AVI_ACTION.WRITE:
            try:
                # Write buffer data (e.g., a chunk of audio/video)
                self.write(buffer)

            except Exception:
                # On error, stop the reader but do not manage the lock
                self.stop()
                raise

        elif action == AVI_ACTION.END:
            try:
                # Stop the reader process
                self.stop()

            finally:
                # Always release the lock if we are the owner
                self._unlock()
