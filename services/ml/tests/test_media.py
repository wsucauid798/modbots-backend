import io
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from app.media import (
    MediaProcessingError,
    decode_base64,
    process_audio,
    process_document,
    process_video,
)


class MediaTests(unittest.TestCase):
    def test_rejects_invalid_base64(self):
        with self.assertRaises(MediaProcessingError):
            decode_base64("not base64")

    def test_extracts_docx_text(self):
        data = io.BytesIO()

        with zipfile.ZipFile(data, "w") as archive:
            archive.writestr(
                "word/document.xml",
                """
                <w:document xmlns:w="urn:test">
                  <w:body><w:p><w:r><w:t>Multimodal room note</w:t></w:r></w:p></w:body>
                </w:document>
                """,
            )

        processed = process_document(
            data.getvalue(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "notes.docx",
        )

        self.assertEqual(processed.text, "Multimodal room note")

    def test_normalizes_audio_for_remote_gemma(self):
        with tempfile.TemporaryDirectory(prefix="modbots-media-test-") as directory:
            source = Path(directory) / "sample.mp3"
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=1",
                    "-ac",
                    "2",
                    "-ar",
                    "44100",
                    "-y",
                    str(source),
                ],
                check=True,
            )

            normalized = process_audio(source.read_bytes(), "sample.mp3")

        self.assertEqual(normalized[:4], b"RIFF")
        self.assertGreater(len(normalized), 44)

    def test_extracts_video_frames_and_audio(self):
        with tempfile.TemporaryDirectory(prefix="modbots-media-test-") as directory:
            source = Path(directory) / "sample.mp4"
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=blue:s=320x240:d=1",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=1",
                    "-shortest",
                    "-c:v",
                    "mpeg4",
                    "-c:a",
                    "aac",
                    "-y",
                    str(source),
                ],
                check=True,
            )

            processed = process_video(source.read_bytes(), "sample.mp4")

        self.assertEqual(len(processed.images), 1)
        self.assertEqual(len(processed.image_timestamps_ms), 1)
        self.assertIsNotNone(processed.audio)
        self.assertGreater(len(processed.audio or b""), 44)


if __name__ == "__main__":
    unittest.main()
