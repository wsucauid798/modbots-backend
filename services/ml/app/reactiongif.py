from dataclasses import dataclass
from io import BytesIO
from math import pi, sin
from textwrap import wrap
from typing import Literal

from PIL import Image, ImageDraw, ImageFont


GifTemplate = Literal["celebrate", "laugh", "side_eye", "facepalm"]


@dataclass(frozen=True)
class RenderedReactionGif:
    data: bytes
    media_type: str
    width: int
    height: int


_WIDTH = 640
_HEIGHT = 480
_FRAME_COUNT = 18
_PALETTES: dict[GifTemplate, tuple[str, str, str]] = {
    "celebrate": ("#07131f", "#00c2ff", "#fbbf24"),
    "laugh": ("#17102b", "#c084fc", "#fb7185"),
    "side_eye": ("#111827", "#38bdf8", "#a3e635"),
    "facepalm": ("#25120f", "#fb7185", "#fbbf24"),
}


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.truetype("DejaVuSans-Bold.ttf", size)
    except OSError:
        return ImageFont.load_default()


def _text_lines(text: str) -> list[str]:
    normalized = " ".join(text.split()).strip()
    if not normalized:
        return []

    lines = wrap(
        normalized,
        width=24,
        break_long_words=False,
        break_on_hyphens=False,
    )[:3]
    return lines


def _centered_text(
    draw: ImageDraw.ImageDraw,
    lines: list[str],
    y: int,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
) -> None:
    for index, line in enumerate(lines):
        box = draw.textbbox((0, 0), line, font=font, stroke_width=2)
        width = box[2] - box[0]
        draw.text(
            ((_WIDTH - width) // 2, y + index * 48),
            line,
            font=font,
            fill="#ffffff",
            stroke_width=2,
            stroke_fill="#05070a",
        )


def _draw_bot(
    draw: ImageDraw.ImageDraw,
    template: GifTemplate,
    frame: int,
    accent: str,
    highlight: str,
) -> None:
    phase = frame / _FRAME_COUNT * 2 * pi
    bounce = round(sin(phase * 2) * (10 if template in {"celebrate", "laugh"} else 3))
    left = 218
    top = 214 + bounce
    right = 422
    bottom = 390 + bounce

    draw.rounded_rectangle(
        (left, top, right, bottom),
        radius=52,
        fill="#0a0f17",
        outline=accent,
        width=7,
    )
    draw.rounded_rectangle(
        (left + 25, top + 35, right - 25, top + 118),
        radius=34,
        fill="#dbeafe",
    )

    eye_shift = 0
    if template == "side_eye":
        eye_shift = round(sin(phase) * 17)

    eye_y = top + 75
    if template == "laugh":
        draw.arc((left + 53, eye_y - 8, left + 92, eye_y + 20), 195, 345, fill="#07131f", width=8)
        draw.arc((right - 92, eye_y - 8, right - 53, eye_y + 20), 195, 345, fill="#07131f", width=8)
    else:
        draw.ellipse((left + 65 + eye_shift, eye_y, left + 84 + eye_shift, eye_y + 19), fill="#07131f")
        draw.ellipse((right - 84 + eye_shift, eye_y, right - 65 + eye_shift, eye_y + 19), fill="#07131f")

    if template == "laugh":
        draw.arc((left + 72, top + 101, right - 72, bottom - 18), 10, 170, fill=highlight, width=9)
    elif template == "side_eye":
        draw.line((left + 82, top + 143, right - 82, top + 143), fill=highlight, width=8)
    else:
        draw.arc((left + 78, top + 105, right - 78, bottom - 25), 15, 165, fill=highlight, width=8)

    if template == "facepalm":
        hand_y = top + 8 + round((1 + sin(phase - pi / 2)) * 34)
        draw.rounded_rectangle(
            (right - 112, hand_y, right + 36, hand_y + 38),
            radius=18,
            fill=highlight,
            outline="#ffffff",
            width=3,
        )


def _draw_confetti(
    draw: ImageDraw.ImageDraw,
    frame: int,
    accent: str,
    highlight: str,
) -> None:
    colors = (accent, highlight, "#ffffff", "#34d399")
    for index in range(22):
        x = 30 + ((index * 97 + frame * (7 + index % 4)) % 580)
        y = 170 + ((index * 53 + frame * (11 + index % 3)) % 280)
        color = colors[index % len(colors)]
        draw.rounded_rectangle((x, y, x + 8, y + 18), radius=3, fill=color)


def render_reaction_gif(
    template: GifTemplate,
    text: str,
    author: str,
) -> RenderedReactionGif:
    lines = _text_lines(text)
    if not lines:
        raise ValueError("An animated reaction requires text")

    background, accent, highlight = _PALETTES[template]
    normalized_author = " ".join(author.split()).strip()[:60] or "Mod Bots"
    frames: list[Image.Image] = []
    title_font = _font(38)
    meta_font = _font(17)

    for frame_index in range(_FRAME_COUNT):
        frame = Image.new("RGB", (_WIDTH, _HEIGHT), background)
        draw = ImageDraw.Draw(frame)
        draw.rounded_rectangle(
            (16, 16, _WIDTH - 16, _HEIGHT - 16),
            radius=34,
            fill="#070a10",
            outline=accent,
            width=3,
        )
        draw.text((36, 28), template.replace("_", " ").upper(), font=meta_font, fill=accent)
        author_box = draw.textbbox((0, 0), normalized_author, font=meta_font)
        draw.text(
            (_WIDTH - 36 - (author_box[2] - author_box[0]), 28),
            normalized_author,
            font=meta_font,
            fill="#cbd5e1",
        )
        _centered_text(draw, lines, 82, title_font)
        if template == "celebrate":
            _draw_confetti(draw, frame_index, accent, highlight)
        _draw_bot(draw, template, frame_index, accent, highlight)
        frames.append(frame)

    output = BytesIO()
    frames[0].save(
        output,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=85,
        loop=0,
        disposal=2,
        optimize=False,
    )
    return RenderedReactionGif(
        data=output.getvalue(),
        media_type="image/gif",
        width=_WIDTH,
        height=_HEIGHT,
    )
