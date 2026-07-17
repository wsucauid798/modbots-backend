import unittest
from types import SimpleNamespace

from fastapi import HTTPException

from app import main


class FakeClient:
    def __init__(self, content: str = "Hello from Gemma"):
        self.content = content
        self.request = None

    def chat(self, **request):
        self.request = request
        return SimpleNamespace(
            message=SimpleNamespace(content=self.content),
        )


class ChatTests(unittest.TestCase):
    def tearDown(self):
        main.state["client"] = None

    def test_maps_text_request_to_ollama_chat(self):
        client = FakeClient()
        main.state["client"] = client

        response = main.chat(
            main.ChatRequest(
                system="You are Iris.",
                messages=[main.ChatMessage(role="user", content="Hello")],
                maxTokens=60,
                temperature=0.85,
            )
        )

        self.assertEqual(response.content, "Hello from Gemma")
        self.assertEqual(response.model, "gemma4:31b-cloud")
        self.assertEqual(response.observations, [])
        self.assertEqual(client.request["model"], "gemma4:31b-cloud")
        self.assertEqual(
            client.request["messages"],
            [
                {"role": "system", "content": "You are Iris."},
                {"role": "user", "content": "Hello"},
            ],
        )
        self.assertFalse(client.request["stream"])
        self.assertFalse(client.request["think"])
        self.assertEqual(client.request["options"]["num_predict"], 60)
        self.assertEqual(client.request["options"]["temperature"], 0.85)

    def test_maps_base64_images_to_ollama_message(self):
        client = FakeClient()
        main.state["client"] = client

        main.chat(
            main.ChatRequest(
                system="Look at the room content.",
                messages=[
                    main.ChatMessage(
                        role="user",
                        content="What is shown?",
                        images=["aW1hZ2UtYnl0ZXM="],
                    )
                ],
            )
        )

        self.assertEqual(
            client.request["messages"][1]["images"],
            ["aW1hZ2UtYnl0ZXM="],
        )

    def test_routes_ordered_image_part_to_gemma(self):
        client = FakeClient()
        main.state["client"] = client

        response = main.chat(
            main.ChatRequest(
                system="Observe the room.",
                messages=[
                    main.ChatMessage(
                        role="user",
                        parts=[
                            main.ChatPart(kind="text", text="Look at this."),
                            main.ChatPart(
                                kind="image",
                                data="aW1hZ2UtYnl0ZXM=",
                                mediaType="image/png",
                                filename="room.png",
                            ),
                        ],
                    )
                ],
            )
        )

        prepared = client.request["messages"][1]
        self.assertIn("Look at this.", prepared["content"])
        self.assertIn("ordered content part 1", prepared["content"])
        self.assertEqual(prepared["images"], ["aW1hZ2UtYnl0ZXM="])
        self.assertEqual(response.observations[0].kind, "image")
        self.assertEqual(response.observations[0].sourcePart, 1)
        self.assertEqual(response.observations[0].model, "gemma4:31b-cloud")

    def test_rejects_audio_without_an_ollama_cloud_audio_model(self):
        main.state["client"] = FakeClient()

        with self.assertRaises(HTTPException) as captured:
            main.chat(
                main.ChatRequest(
                    system="Observe the room.",
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

        self.assertEqual(captured.exception.status_code, 422)

    def test_extracts_text_document_before_gemma(self):
        client = FakeClient()
        main.state["client"] = client

        response = main.chat(
            main.ChatRequest(
                system="Observe the room.",
                messages=[
                    main.ChatMessage(
                        role="user",
                        parts=[
                            main.ChatPart(
                                kind="file",
                                data="cmVzZWFyY2ggbm90ZXM=",
                                mediaType="text/plain",
                                filename="notes.txt",
                            )
                        ],
                    )
                ],
            )
        )

        prepared = client.request["messages"][1]
        self.assertIn("research notes", prepared["content"])
        self.assertEqual(response.observations[0].kind, "document_text")

    def test_rejects_empty_cloud_response(self):
        main.state["client"] = FakeClient("   ")

        with self.assertRaises(HTTPException) as captured:
            main.chat(
                main.ChatRequest(
                    system="You are Iris.",
                    messages=[main.ChatMessage(role="user", content="Hello")],
                )
            )

        self.assertEqual(captured.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()
