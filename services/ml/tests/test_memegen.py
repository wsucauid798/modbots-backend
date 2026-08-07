import unittest

from app.memegen import render_meme_svg


class MemeGeneratorTests(unittest.TestCase):
    def test_renders_a_square_svg_meme(self):
        rendered = render_meme_svg(
            "reaction",
            "When the tests finally pass",
            "And you changed nothing",
            "Felix",
        )

        text = rendered.data.decode("utf-8")
        self.assertEqual(rendered.media_type, "image/svg+xml")
        self.assertEqual((rendered.width, rendered.height), (1200, 1200))
        self.assertIn("When the tests finally", text)
        self.assertIn("And you changed nothing", text)
        self.assertIn("Felix", text)

    def test_escapes_generated_text(self):
        rendered = render_meme_svg(
            "contrast",
            "Me < the deadline",
            "Tests & sleep",
            "Arwen & friends",
        )

        text = rendered.data.decode("utf-8")
        self.assertIn("Me &lt; the deadline", text)
        self.assertIn("Tests &amp; sleep", text)
        self.assertIn("Arwen &amp; friends", text)

    def test_requires_both_text_sections(self):
        with self.assertRaisesRegex(ValueError, "both top and bottom"):
            render_meme_svg("announcement", "One thought", "", "Ru")


if __name__ == "__main__":
    unittest.main()
