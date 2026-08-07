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


def response(status_code, payload, headers=None):
    return httpx.Response(
        status_code,
        json=payload,
        headers=headers,
        request=httpx.Request(
            "POST",
            "https://api.openai.com/v1/test",
        ),
    )


def environment(**overrides):
    values = dict(
        MODEL_ID="hosted-model",
        OPENAI_API_KEY="sk-test",
        INFERENCE_TIMEOUT_SECONDS=120.0,
    )
    values.update(overrides)
    return mock.patch.multiple(main, **values)


class OpenAIInferenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = environment()
        self.env.start()

    def tearDown(self):
        self.env.stop()
        main.state["client"] = None

    async def test_health_reports_hosted_model_when_ready(self):
        main.state["client"] = FakeClient(
            health_response=response(200, {"data": [{"id": main.MODEL_ID}]})
        )

        result = await main.health()

        self.assertEqual(result.status_code, 200)
        self.assertEqual(main.state["client"].last_health_path, "models")
        self.assertIn(b'"execution":"hosted"', result.body)
        self.assertIn(main.MODEL_ID.encode(), result.body)

    async def test_meme_renderer_returns_base64_svg(self):
        result = await main.render_meme(
            main.MemeRenderRequest(
                template="reaction",
                topText="When the room gets quiet",
                bottomText="Ru has entered the chat",
                author="Ru",
            )
        )

        rendered = base64.b64decode(result.data).decode("utf-8")
        self.assertEqual(result.mediaType, "image/svg+xml")
        self.assertEqual((result.width, result.height), (1200, 1200))
        self.assertIn("Ru has entered the", rendered)

    async def test_reaction_renderer_returns_an_animated_gif(self):
        result = await main.render_gif(
            main.GifRenderRequest(
                template="side_eye",
                text="You called that a tiny change?",
                author="Felix",
            )
        )

        rendered = base64.b64decode(result.data)
        self.assertEqual(result.mediaType, "image/gif")
        self.assertEqual((result.width, result.height), (640, 480))
        self.assertTrue(rendered.startswith((b"GIF87a", b"GIF89a")))
        self.assertIn(b"NETSCAPE2.0", rendered)

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

    async def test_text_chat_uses_openai_chat_completions_contract(self):
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
        self.assertEqual(payload["max_completion_tokens"], 40)
        self.assertEqual(payload["reasoning_effort"], "none")
        self.assertNotIn("max_tokens", payload)
        self.assertNotIn("temperature", payload)
        self.assertEqual(result.content, "Hello.")

    async def test_research_uses_required_live_web_search_and_returns_sources(self):
        client = FakeClient(
            chat_response=response(
                200,
                {
                    "output": [
                        {
                            "type": "web_search_call",
                            "action": {
                                "sources": [
                                    {
                                    "title": "Example source",
                                    "url": "https://example.com/research",
                                    }
                                ]
                            },
                        },
                        {
                            "type": "message",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "TOPIC=Ocean heat\nKNOWLEDGE=Measured ocean heat has increased.",
                                    "annotations": [
                                        {
                                            "type": "url_citation",
                                            "title": "Cited source",
                                            "url": "https://example.com/cited?utm_source=openai&id=7",
                                        }
                                    ],
                                }
                            ],
                        },
                    ]
                },
            )
        )
        main.state["client"] = client

        result = await main.research(
            main.ResearchRequest(
                system="Learn one real subject.",
                prompt="Research something worth understanding.",
            )
        )

        path, payload = client.last_chat_request
        self.assertEqual(path, "responses")
        self.assertEqual(
            payload["tools"],
            [
                {
                    "type": "web_search",
                    "search_context_size": "medium",
                    "external_web_access": True,
                }
            ],
        )
        self.assertEqual(payload["tool_choice"], "required")
        self.assertEqual(payload["include"], ["web_search_call.action.sources"])
        self.assertEqual(result.sources[0].url, "https://example.com/cited?id=7")
        self.assertEqual(result.sources[1].url, "https://example.com/research")
        self.assertIn("TOPIC=Ocean heat", result.content)

    async def test_research_rejects_unsourced_output(self):
        main.state["client"] = FakeClient(
            chat_response=response(
                200,
                {
                    "output": [
                        {
                            "type": "message",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "An unsupported answer",
                                    "annotations": [],
                                }
                            ],
                        }
                    ]
                },
            )
        )

        with self.assertRaises(HTTPException) as raised:
            await main.research(
                main.ResearchRequest(
                    system="Learn.",
                    prompt="Research.",
                )
            )

        self.assertEqual(raised.exception.status_code, 502)
        self.assertIn("no sourced knowledge", str(raised.exception.detail))

    async def test_image_and_audio_use_openai_multimodal_parts(self):
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
            chat_response=response(
                429,
                {
                    "error": {
                        "message": "busy",
                        "code": "rate_limit_exceeded",
                    }
                },
                headers={"retry-after": "3"},
            )
        )

        with self.assertRaises(HTTPException) as captured:
            await main.chat(
                main.ChatRequest(
                    system="You are Iris.",
                    messages=[main.ChatMessage(role="user", content="Hello")],
                )
            )

        self.assertEqual(captured.exception.status_code, 429)
        self.assertEqual(captured.exception.detail["code"], "rate_limited")
        self.assertEqual(captured.exception.detail["retryAfterMs"], 3_000)

    def test_rate_limit_reset_duration_is_parsed(self):
        limited = response(
            429,
            {"error": {"code": "rate_limit_exceeded"}},
            headers={
                "x-ratelimit-reset-requests": "750ms",
                "x-ratelimit-reset-tokens": "1m1.5s",
            },
        )

        self.assertEqual(main._retry_after_milliseconds(limited), 61_500)

    async def test_provider_insufficient_quota_is_reported_as_unavailable(self):
        main.state["client"] = FakeClient(
            chat_response=response(
                429,
                {
                    "error": {
                        "message": "You exceeded your current quota.",
                        "type": "insufficient_quota",
                        "code": "insufficient_quota",
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

        self.assertEqual(captured.exception.status_code, 503)
        self.assertEqual(captured.exception.detail["code"], "insufficient_quota")

    async def test_connection_failure_reports_starting_state(self):
        request = httpx.Request(
            "GET",
            "https://api.openai.com/v1/models",
        )
        main.state["client"] = FakeClient(
            error=httpx.ConnectError("not ready", request=request)
        )

        result = await main.health()

        self.assertEqual(result.status_code, 503)
        self.assertIn(b"Chat bots are still getting ready", result.body)

class OpenAIErrorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = environment()
        self.env.start()

    def tearDown(self):
        self.env.stop()
        main.state["client"] = None

    async def test_refused_request_surfaces_the_openai_explanation(self):
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

    async def test_health_rejects_an_unavailable_model(self):
        main.state["client"] = FakeClient(
            health_response=response(200, {"data": [{"id": "another-model"}]})
        )

        result = await main.health()

        self.assertEqual(result.status_code, 503)
        self.assertIn(b"configured chat model is unavailable", result.body)

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


class OpenAIConfigTests(unittest.TestCase):
    def test_api_key_becomes_a_bearer_header(self):
        with environment():
            self.assertEqual(
                main._auth_headers(),
                {"Authorization": "Bearer sk-test"},
            )

    def test_a_complete_environment_validates(self):
        with environment():
            main._validate_configuration()

    def test_missing_api_key_fails_at_startup(self):
        with environment(OPENAI_API_KEY=""):
            with self.assertRaises(RuntimeError) as captured:
                main._validate_configuration()

        self.assertIn("OPENAI_API_KEY", str(captured.exception))

    def test_missing_model_id_fails_at_startup(self):
        with environment(MODEL_ID=""):
            with self.assertRaises(RuntimeError) as captured:
                main._validate_configuration()

        self.assertIn("MODEL_ID", str(captured.exception))

    def test_missing_timeout_fails_at_startup(self):
        with environment(INFERENCE_TIMEOUT_SECONDS=0.0):
            with self.assertRaises(RuntimeError) as captured:
                main._validate_configuration()

        self.assertIn("INFERENCE_TIMEOUT_SECONDS", str(captured.exception))


if __name__ == "__main__":
    unittest.main()
