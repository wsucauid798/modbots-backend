import base64
import binascii
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

MAX_MEDIA_BYTES = 100 * 1024 * 1024
MAX_DOCUMENT_CHARACTERS = 200_000
MAX_DOCUMENT_PAGES = 12
MAX_VIDEO_FRAMES = 8


class MediaProcessingError(ValueError):
    pass


@dataclass
class ProcessedMedia:
    text: str = ""
    images: list[bytes] = field(default_factory=list)
    image_timestamps_ms: list[int] = field(default_factory=list)
    audio: bytes | None = None


def decode_base64(data: str) -> bytes:
    encoded = data.split(",", 1)[1] if data.startswith("data:") else data

    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exception:
        raise MediaProcessingError("Media data must be valid base64") from exception

    if not decoded:
        raise MediaProcessingError("Media data cannot be empty")

    if len(decoded) > MAX_MEDIA_BYTES:
        raise MediaProcessingError(
            f"Media data cannot exceed {MAX_MEDIA_BYTES} bytes"
        )

    return decoded


def encode_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _run(arguments: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            arguments,
            check=True,
            capture_output=True,
            timeout=timeout,
        )
    except FileNotFoundError as exception:
        raise MediaProcessingError(
            f"Required media tool '{arguments[0]}' is unavailable"
        ) from exception
    except subprocess.CalledProcessError as exception:
        detail = exception.stderr.decode("utf-8", errors="replace").strip()
        raise MediaProcessingError(
            f"Media processing failed: {detail[-500:]}"
        ) from exception
    except subprocess.TimeoutExpired as exception:
        raise MediaProcessingError("Media processing timed out") from exception


def _archive_text(data: bytes, filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    supported = {
        ".docx": ("word/", "t"),
        ".pptx": ("ppt/slides/", "t"),
        ".xlsx": ("xl/", "t"),
        ".odt": ("content.xml", "p"),
    }

    if suffix not in supported:
        raise MediaProcessingError(f"Unsupported document format '{suffix or 'unknown'}'")

    prefix, local_name = supported[suffix]
    values: list[str] = []

    try:
        with tempfile.TemporaryFile() as stream:
            stream.write(data)
            stream.seek(0)

            with zipfile.ZipFile(stream) as archive:
                for name in sorted(archive.namelist()):
                    if not name.startswith(prefix) or not name.endswith(".xml"):
                        continue

                    root = ET.fromstring(archive.read(name))

                    for element in root.iter():
                        tag = element.tag.rsplit("}", 1)[-1]

                        if tag == local_name and element.text:
                            values.append(element.text)
    except (zipfile.BadZipFile, ET.ParseError) as exception:
        raise MediaProcessingError("Document archive is malformed") from exception

    return "\n".join(values)[:MAX_DOCUMENT_CHARACTERS]


def process_document(data: bytes, media_type: str, filename: str) -> ProcessedMedia:
    normalized = media_type.split(";", 1)[0].strip().lower()
    suffix = Path(filename).suffix.lower()
    text_types = {
        "application/csv",
        "application/json",
        "application/xml",
        "text/csv",
        "text/html",
        "text/markdown",
        "text/plain",
        "text/xml",
    }

    if normalized.startswith("text/") or normalized in text_types:
        return ProcessedMedia(
            text=data.decode("utf-8", errors="replace")[:MAX_DOCUMENT_CHARACTERS]
        )

    if normalized == "application/pdf" or suffix == ".pdf":
        with tempfile.TemporaryDirectory(prefix="modbots-document-") as directory:
            root = Path(directory)
            source = root / "document.pdf"
            source.write_bytes(data)
            text_result = _run(["pdftotext", "-layout", str(source), "-"])
            image_prefix = root / "page"
            _run(
                [
                    "pdftoppm",
                    "-jpeg",
                    "-r",
                    "120",
                    "-f",
                    "1",
                    "-l",
                    str(MAX_DOCUMENT_PAGES),
                    str(source),
                    str(image_prefix),
                ]
            )
            images = [
                path.read_bytes()
                for path in sorted(root.glob("page-*.jpg"))
            ]
            return ProcessedMedia(
                text=text_result.stdout.decode(
                    "utf-8", errors="replace"
                )[:MAX_DOCUMENT_CHARACTERS],
                images=images,
            )

    return ProcessedMedia(text=_archive_text(data, filename))


def process_audio(data: bytes, filename: str) -> bytes:
    suffix = Path(filename).suffix.lower() or ".audio"

    with tempfile.TemporaryDirectory(prefix="modbots-audio-") as directory:
        root = Path(directory)
        source = root / f"source{suffix}"
        output = root / "audio.wav"
        source.write_bytes(data)
        _run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(source),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                "-y",
                str(output),
            ]
        )

        if not output.exists() or output.stat().st_size <= 44:
            raise MediaProcessingError("Audio does not contain a readable track")

        return output.read_bytes()


def process_video(data: bytes, filename: str) -> ProcessedMedia:
    suffix = Path(filename).suffix.lower() or ".video"

    with tempfile.TemporaryDirectory(prefix="modbots-video-") as directory:
        root = Path(directory)
        source = root / f"source{suffix}"
        source.write_bytes(data)
        duration_result = _run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(source),
            ]
        )

        try:
            duration = max(0.0, float(duration_result.stdout.strip()))
        except ValueError as exception:
            raise MediaProcessingError("Video duration could not be read") from exception

        frame_count = min(MAX_VIDEO_FRAMES, max(1, round(duration / 4)))
        timestamps = [
            duration * (index + 1) / (frame_count + 1)
            for index in range(frame_count)
        ]
        images: list[bytes] = []

        for index, timestamp in enumerate(timestamps):
            output = root / f"frame-{index:03d}.jpg"
            _run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-ss",
                    f"{timestamp:.3f}",
                    "-i",
                    str(source),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale='min(1280,iw)':-2",
                    "-q:v",
                    "3",
                    "-y",
                    str(output),
                ]
            )
            images.append(output.read_bytes())

        audio_path = root / "audio.wav"

        try:
            _run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-i",
                    str(source),
                    "-map",
                    "0:a:0?",
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-y",
                    str(audio_path),
                ]
            )
        except MediaProcessingError:
            pass

        audio = (
            audio_path.read_bytes()
            if audio_path.exists() and audio_path.stat().st_size > 44
            else None
        )
        return ProcessedMedia(
            images=images,
            image_timestamps_ms=[round(timestamp * 1000) for timestamp in timestamps],
            audio=audio,
        )
