import base64
import unittest

import httpx
from fastapi import HTTPException

from app import main


class FakeClient:
    def __init__(self, health_response=None, chat_response=None, error=None):
        self.health_response = health_response
        self.chat_response = chat_response
        self.error = error
        self.last_chat_request = None

    async def get(self, path, **_):
        if self.error is not None:
            raise self.error
        self.last_health_path = path
        return self.health_response

    async def post(self, path, json):
        if self.error is not None:
            raise self.error
        self.last_chat_request = (path, json)
        return self.chat_response


def response(status_code, payload):
    return httpx.Response(
        status_code,
        json=payload,
        request=httpx.Request(
            "POST",
            "http://model-runner.docker.internal/v1/test",
        ),
    )


class CpuInferenceTests(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        main.state["client"] = None

    async def test_health_reports_cpu_model_when_ready(self):
        main.state["client"] = FakeClient(
            health_response=response(200, {"status": "ok"})
        )

        result = await main.health()

        self.assertEqual(result.status_code, 200)
        self.assertEqual(main.state["client"].last_health_path, "models")
        self.assertIn(b'"execution":"cpu"', result.body)
        self.assertIn(main.MODEL_ID.encode(), result.body)

    async def test_health_has_user_friendly_starting_message(self):
        main.state["client"] = FakeClient(
            health_response=response(
                503,
                {"error": {"message": "Loading model"}},
            )
        )

        result = await main.health()

        self.assertEqual(result.status_code, 503)
        self.assertIn(b"Chat bots are still getting ready", result.body)
        self.assertNotIn(b"backend unavailable", result.body)

    async def test_text_chat_uses_local_chat_completions_contract(self):
        client = FakeClient(
            chat_response=response(
                200,
                {
                    "choices": [
                        {"message": {"role": "assistant", "content": "Hello."}}
                    ],
                },
            )
        )
        main.state["client"] = client

        result = await main.chat(
            main.ChatRequest(
                system="You are Iris.",
                messages=[main.ChatMessage(role="user", content="Hello")],
                maxTokens=40,
                temperature=0.4,
            )
        )

        path, payload = client.last_chat_request
        self.assertEqual(path, "chat/completions")
        self.assertEqual(payload["model"], main.MODEL_ID)
        self.assertEqual(
            payload["messages"],
            [
                {"role": "system", "content": "You are Iris."},
                {"role": "user", "content": "Hello"},
            ],
        )
        self.assertEqual(payload["max_tokens"], 40)
        self.assertTrue(payload["cache_prompt"])
        self.assertFalse(payload["chat_template_kwargs"]["enable_thinking"])
        self.assertEqual(payload["reasoning_format"], "none")
        self.assertEqual(result.content, "Hello.")

    async def test_image_and_audio_use_model_runner_multimodal_parts(self):
        client = FakeClient(
            chat_response=response(
                200,
                {
                    "choices": [{"message": {"content": "I can perceive both."}}],
                },
            )
        )
        main.state["client"] = client
        image = base64.b64encode(b"image-bytes").decode()
        audio = base64.b64encode(b"audio-bytes").decode()

        await main.chat(
            main.ChatRequest(
                system="Observe accurately.",
                messages=[
                    main.ChatMessage(
                        role="user",
                        parts=[
                            main.ChatPart(
                                kind="image",
                                data=image,
                                mediaType="image/jpeg",
                                filename="photo.jpg",
                            ),
                            main.ChatPart(
                                kind="audio",
                                data=audio,
                                mediaType="audio/wav",
                                filename="voice.wav",
                            ),
                        ],
                    )
                ],
            )
        )

        content = client.last_chat_request[1]["messages"][1]["content"]
        self.assertEqual(content[0]["type"], "image_url")
        self.assertTrue(
            content[0]["image_url"]["url"].startswith(
                "data:image/jpeg;base64,"
            )
        )
        self.assertEqual(content[1]["type"], "input_audio")
        self.assertEqual(content[1]["input_audio"]["format"], "wav")

    async def test_busy_model_is_reported_as_rate_limited(self):
        main.state["client"] = FakeClient(
            chat_response=response(429, {"error": {"message": "busy"}})
        )

        with self.assertRaises(HTTPException) as captured:
            await main.chat(
                main.ChatRequest(
                    system="You are Iris.",
                    messages=[main.ChatMessage(role="user", content="Hello")],
                )
            )

        self.assertEqual(captured.exception.status_code, 429)

    async def test_connection_failure_reports_starting_state(self):
        request = httpx.Request(
            "GET",
            "http://model-runner.docker.internal/v1/models",
        )
        main.state["client"] = FakeClient(
            error=httpx.ConnectError("not ready", request=request)
        )

        result = await main.health()

        self.assertEqual(result.status_code, 503)
        self.assertIn(b"Chat bots are still getting ready", result.body)


if __name__ == "__main__":
    unittest.main()
