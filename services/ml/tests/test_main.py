import unittest
from types import SimpleNamespace

from fastapi import HTTPException
from httpx import Request, Response
from openai import APIStatusError

from app import main


class FakeResponses:
    def __init__(self, client):
        self.client = client

    def create(self, **request):
        self.client.request = request
        return SimpleNamespace(
            output_text=self.client.content,
            usage=SimpleNamespace(
                input_tokens=120,
                input_tokens_details=SimpleNamespace(cached_tokens=64),
                output_tokens=18,
            ),
        )


class FakeClient:
    def __init__(self, content: str = "Hello from OpenAI"):
        self.content = content
        self.request = None
        self.responses = FakeResponses(self)


class RateLimitedResponses:
    def create(self, **request):
        raise APIStatusError(
            "rate limited",
            response=Response(
                429,
                request=Request("POST", "https://api.openai.com/v1/responses"),
            ),
            body={"error": "rate limited"},
        )


class RateLimitedClient:
    def __init__(self):
        self.responses = RateLimitedResponses()


class ChatTests(unittest.TestCase):
    def tearDown(self):
        main.state["client"] = None

    def test_maps_text_request_to_openai_response(self):
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

        self.assertEqual(response.content, "Hello from OpenAI")
        self.assertEqual(response.model, "gpt-5.6-luna")
        self.assertEqual(response.observations, [])
        self.assertEqual(response.usage.inputTokens, 120)
        self.assertEqual(response.usage.cachedInputTokens, 64)
        self.assertEqual(response.usage.outputTokens, 18)
        self.assertEqual(client.request["model"], "gpt-5.6-luna")
        self.assertEqual(client.request["instructions"], "You are Iris.")
        self.assertEqual(
            client.request["input"],
            [
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Hello"}],
                },
            ],
        )
        self.assertEqual(client.request["max_output_tokens"], 60)
        self.assertEqual(client.request["reasoning"], {"effort": "none"})
        self.assertEqual(client.request["temperature"], 0.85)
        self.assertEqual(client.request["text"], {"verbosity": "low"})

    def test_health_identifies_openai(self):
        response = main.health()

        self.assertEqual(response["provider"], "openai")
        self.assertEqual(response["model"], "gpt-5.6-luna")

    def test_maps_base64_images_to_openai_input(self):
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
            client.request["input"][0]["content"][1],
            {
                "type": "input_image",
                "image_url": "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
            },
        )

    def test_routes_ordered_image_part_to_openai(self):
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

        prepared = client.request["input"][0]
        prepared_text = prepared["content"][0]["text"]
        self.assertIn("Look at this.", prepared_text)
        self.assertIn("ordered content part 1", prepared_text)
        self.assertEqual(
            prepared["content"][1],
            {
                "type": "input_image",
                "image_url": "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
            },
        )
        self.assertEqual(response.observations[0].kind, "image")
        self.assertEqual(response.observations[0].sourcePart, 1)
        self.assertEqual(response.observations[0].model, "gpt-5.6-luna")

    def test_rejects_audio_for_the_configured_openai_model(self):
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

    def test_extracts_text_document_before_openai(self):
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

        prepared = client.request["input"][0]
        self.assertIn("research notes", prepared["content"][0]["text"])
        self.assertEqual(response.observations[0].kind, "document_text")

    def test_rejects_empty_openai_response(self):
        main.state["client"] = FakeClient("   ")

        with self.assertRaises(HTTPException) as captured:
            main.chat(
                main.ChatRequest(
                    system="You are Iris.",
                    messages=[main.ChatMessage(role="user", content="Hello")],
                )
            )

        self.assertEqual(captured.exception.status_code, 502)

    def test_propagates_openai_rate_limits(self):
        main.state["client"] = RateLimitedClient()

        with self.assertRaises(HTTPException) as captured:
            main.chat(
                main.ChatRequest(
                    system="You are Iris.",
                    messages=[main.ChatMessage(role="user", content="Hello")],
                )
            )

        self.assertEqual(captured.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
