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
