import unittest

from fastapi import HTTPException

from app import main


class PipelineTests(unittest.TestCase):
    def test_selects_primary_pipeline_for_text_and_images(self):
        selection = main.select_pipeline(
            main.ChatRequest(
                system="Observe the chatroom.",
                messages=[
                    main.ChatMessage(
                        role="user",
                        content="What is shown?",
                        images=["aW1hZ2UtYnl0ZXM="],
                    )
                ],
            )
        )

        self.assertEqual(selection.pipelineId, "conversation.gemma-4.v1")
        self.assertEqual(selection.inputModalities, ["text", "image"])
        self.assertEqual(
            selection.requiredArtifactRoles,
            ["multimodal_reasoning"],
        )
        self.assertEqual(selection.deterministicProcessors, [])

    def test_uses_the_same_gemma_pipeline_for_audio(self):
        selection = main.select_pipeline(
            main.ChatRequest(
                system="Observe the chatroom.",
                messages=[
                    main.ChatMessage(
                        role="user",
                        parts=[
                            main.ChatPart(
                                kind="audio",
                                data="YXVkaW8tYnl0ZXM=",
                                mediaType="audio/wav",
                                filename="voice.wav",
                            )
                        ],
                    )
                ],
            )
        )

        self.assertEqual(selection.pipelineId, "conversation.gemma-4.v1")
        self.assertEqual(selection.inputModalities, ["audio"])
        self.assertEqual(
            selection.requiredArtifactRoles,
            ["multimodal_reasoning"],
        )
        self.assertEqual(selection.deterministicProcessors, [])

    def test_selects_required_video_and_document_processors(self):
        selection = main.select_pipeline(
            main.ChatRequest(
                system="Observe the chatroom.",
                messages=[
                    main.ChatMessage(
                        role="user",
                        parts=[
                            main.ChatPart(
                                kind="video",
                                data="dmlkZW8tYnl0ZXM=",
                                mediaType="video/mp4",
                                filename="clip.mp4",
                            ),
                            main.ChatPart(
                                kind="file",
                                data="ZmlsZS1ieXRlcw==",
                                mediaType="application/pdf",
                                filename="notes.pdf",
                            ),
                        ],
                    )
                ],
            )
        )

        self.assertEqual(selection.inputModalities, ["video", "file"])
        self.assertEqual(
            selection.deterministicProcessors,
            ["document_text_extraction"],
        )

    def test_health_reports_that_client_execution_is_not_ready(self):
        response = main.health()

        self.assertEqual(response.status_code, 503)
        self.assertIn(b"waiting_for_client_inference", response.body)
        self.assertIn(b"local inference", response.body)

    def test_chat_does_not_fall_back_to_a_paid_provider(self):
        with self.assertRaises(HTTPException) as captured:
            main.chat(
                main.ChatRequest(
                    system="You are Iris.",
                    messages=[main.ChatMessage(role="user", content="Hello")],
                )
            )

        self.assertEqual(captured.exception.status_code, 503)
        self.assertIn("local inference", captured.exception.detail)


if __name__ == "__main__":
    unittest.main()
