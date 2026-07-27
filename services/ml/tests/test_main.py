import base64
import unittest
from unittest import mock

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


def environment(**overrides):
    values = dict(
        MODEL_BACKEND=main.OPENAI_BACKEND,
        MODEL_URL="https://api.openai.com/v1",
        MODEL_ID="hosted-model",
        OPENAI_API_KEY="sk-test",
        INFERENCE_TIMEOUT_SECONDS=120.0,
    )
    values.update(overrides)
    return mock.patch.multiple(main, **values)


class CpuInferenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = environment(
            MODEL_BACKEND=main.LOCAL_BACKEND,
            MODEL_URL="http://model-runner.docker.internal/engines/v1",
            MODEL_ID="ai/gemma4",
            OPENAI_API_KEY="",
            INFERENCE_TIMEOUT_SECONDS=600.0,
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()
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


class HostedInferenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = environment()
        self.env.start()

    def tearDown(self):
        self.env.stop()
        main.state["client"] = None

    async def test_hosted_payload_omits_llama_cpp_extensions(self):
        client = FakeClient(
            chat_response=response(
                200,
                {"choices": [{"message": {"content": "Hello."}}]},
            )
        )
        main.state["client"] = client

        await main.chat(
            main.ChatRequest(
                system="You are Iris.",
                messages=[main.ChatMessage(role="user", content="Hello")],
                maxTokens=40,
                temperature=0.4,
            )
        )

        payload = client.last_chat_request[1]
        self.assertEqual(payload["max_completion_tokens"], 40)
        self.assertNotIn("max_tokens", payload)
        self.assertNotIn("temperature", payload)
        self.assertNotIn("cache_prompt", payload)
        self.assertNotIn("chat_template_kwargs", payload)
        self.assertNotIn("reasoning_format", payload)

    async def test_refused_request_surfaces_the_backend_explanation(self):
        main.state["client"] = FakeClient(
            chat_response=response(
                400,
                {
                    "error": {
                        "message": (
                            "Unsupported parameter: 'max_tokens' is not "
                            "supported with this model."
                        ),
                        "code": "unsupported_parameter",
                    }
                },
            )
        )

        with self.assertRaises(HTTPException) as captured:
            await main.chat(
                main.ChatRequest(
                    system="You are Iris.",
                    messages=[main.ChatMessage(role="user", content="Hello")],
                )
            )

        self.assertEqual(captured.exception.status_code, 502)
        self.assertIn("Unsupported parameter", captured.exception.detail)

    async def test_hosted_health_reports_hosted_execution(self):
        main.state["client"] = FakeClient(
            health_response=response(200, {"data": []})
        )

        result = await main.health()

        self.assertEqual(result.status_code, 200)
        self.assertIn(b'"execution":"hosted"', result.body)

    async def test_rejected_credentials_name_the_key_to_check(self):
        main.state["client"] = FakeClient(
            chat_response=response(401, {"error": {"message": "bad key"}})
        )

        with self.assertRaises(HTTPException) as captured:
            await main.chat(
                main.ChatRequest(
                    system="You are Iris.",
                    messages=[main.ChatMessage(role="user", content="Hello")],
                )
            )

        self.assertEqual(captured.exception.status_code, 502)
        self.assertIn("OPENAI_API_KEY", captured.exception.detail)


class BackendConfigTests(unittest.TestCase):
    def test_api_key_becomes_a_bearer_header(self):
        with environment():
            self.assertEqual(
                main._auth_headers(),
                {"Authorization": "Bearer sk-test"},
            )

    def test_local_backend_sends_no_authorization_header(self):
        with environment(
            MODEL_BACKEND=main.LOCAL_BACKEND, OPENAI_API_KEY=""
        ):
            self.assertEqual(main._auth_headers(), {})

    def test_a_complete_environment_validates(self):
        with environment():
            main._validate_backend()

    def test_hosted_backend_without_a_key_fails_at_startup(self):
        with environment(OPENAI_API_KEY=""):
            with self.assertRaises(RuntimeError) as captured:
                main._validate_backend()

        self.assertIn("OPENAI_API_KEY", str(captured.exception))

    def test_unknown_backend_fails_at_startup(self):
        with environment(MODEL_BACKEND="somewhere-else"):
            with self.assertRaises(RuntimeError) as captured:
                main._validate_backend()

        self.assertIn("MODEL_BACKEND", str(captured.exception))

    def test_missing_backend_fails_at_startup(self):
        with environment(MODEL_BACKEND=""):
            with self.assertRaises(RuntimeError) as captured:
                main._validate_backend()

        self.assertIn("MODEL_BACKEND", str(captured.exception))

    def test_missing_model_url_fails_at_startup(self):
        with environment(MODEL_URL=""):
            with self.assertRaises(RuntimeError) as captured:
                main._validate_backend()

        self.assertIn("MODEL_URL", str(captured.exception))

    def test_missing_model_id_fails_at_startup(self):
        with environment(MODEL_ID=""):
            with self.assertRaises(RuntimeError) as captured:
                main._validate_backend()

        self.assertIn("MODEL_ID", str(captured.exception))

    def test_missing_timeout_fails_at_startup(self):
        with environment(INFERENCE_TIMEOUT_SECONDS=0.0):
            with self.assertRaises(RuntimeError) as captured:
                main._validate_backend()

        self.assertIn("INFERENCE_TIMEOUT_SECONDS", str(captured.exception))


if __name__ == "__main__":
    unittest.main()
