import unittest

from app.reactiongif import render_reaction_gif


class ReactionGifTests(unittest.TestCase):
    def test_renders_a_looping_animated_gif(self):
        rendered = render_reaction_gif(
            "celebrate",
            "When the tests finally pass",
            "Felix",
        )

        self.assertEqual(rendered.media_type, "image/gif")
        self.assertEqual((rendered.width, rendered.height), (640, 480))
        self.assertTrue(rendered.data.startswith((b"GIF87a", b"GIF89a")))
        self.assertIn(b"NETSCAPE2.0", rendered.data)
        self.assertGreater(len(rendered.data), 10_000)

    def test_requires_visible_reaction_text(self):
        with self.assertRaises(ValueError):
            render_reaction_gif("laugh", "   ", "Ru")


if __name__ == "__main__":
    unittest.main()
