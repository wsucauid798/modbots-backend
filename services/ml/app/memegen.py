from dataclasses import dataclass
from html import escape
from textwrap import wrap
from typing import Literal


MemeTemplate = Literal["reaction", "contrast", "announcement"]


@dataclass(frozen=True)
class RenderedMeme:
    data: bytes
    media_type: str
    width: int
    height: int


_PALETTES: dict[MemeTemplate, tuple[str, str, str]] = {
    "reaction": ("#07131f", "#13314a", "#00b8ff"),
    "contrast": ("#101116", "#282338", "#c084fc"),
    "announcement": ("#17120a", "#3a2610", "#fbbf24"),
}


def _lines(text: str, width: int = 24, maximum: int = 5) -> list[str]:
    normalized = " ".join(text.split()).strip()
    if not normalized:
        return []

    lines = wrap(
        normalized,
        width=width,
        break_long_words=False,
        break_on_hyphens=False,
    )
    if len(lines) <= maximum:
        return lines

    visible = lines[:maximum]
    visible[-1] = f"{visible[-1][: max(1, width - 1)].rstrip()}…"
    return visible


def _text_block(lines: list[str], start_y: int, size: int) -> str:
    return "".join(
        f'<text x="600" y="{start_y + index * round(size * 1.12)}" '
        f'text-anchor="middle" class="meme-text" font-size="{size}">'
        f"{escape(line)}</text>"
        for index, line in enumerate(lines)
    )


def render_meme_svg(
    template: MemeTemplate,
    top_text: str,
    bottom_text: str,
    author: str,
) -> RenderedMeme:
    background, panel, accent = _PALETTES[template]
    top_lines = _lines(top_text)
    bottom_lines = _lines(bottom_text)

    if not top_lines or not bottom_lines:
        raise ValueError("A meme requires both top and bottom text")

    top_size = 64 if len(top_lines) <= 3 else 54
    bottom_size = 70 if len(bottom_lines) <= 3 else 56
    top_start = 250 - ((len(top_lines) - 1) * round(top_size * 1.12)) // 2
    bottom_start = 810 - ((len(bottom_lines) - 1) * round(bottom_size * 1.12)) // 2
    escaped_author = escape(" ".join(author.split()).strip()[:60] or "Mod Bots")
    template_label = escape(template.upper())

    divider = (
        '<path d="M120 600 H1080" stroke="url(#accent)" stroke-width="4" '
        'stroke-linecap="round" opacity="0.9"/>'
        if template != "contrast"
        else '<rect x="72" y="572" width="1056" height="56" rx="28" fill="url(#accent)"/>'
    )

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200" role="img" aria-label="Meme by {escaped_author}">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{background}"/>
      <stop offset="1" stop-color="{panel}"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="{accent}" stop-opacity="0.25"/>
      <stop offset="0.5" stop-color="{accent}"/>
      <stop offset="1" stop-color="{accent}" stop-opacity="0.25"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#000" flood-opacity="0.4"/>
    </filter>
    <style>
      .meme-text {{ fill: #fff; font-family: Inter, Arial, sans-serif; font-weight: 800; letter-spacing: -1px; }}
      .meta {{ font-family: Inter, Arial, sans-serif; font-weight: 700; letter-spacing: 3px; }}
    </style>
  </defs>
  <rect width="1200" height="1200" fill="url(#background)"/>
  <circle cx="110" cy="96" r="170" fill="{accent}" opacity="0.1"/>
  <circle cx="1110" cy="1100" r="250" fill="{accent}" opacity="0.08"/>
  <rect x="72" y="72" width="1056" height="1056" rx="58" fill="#05070a" fill-opacity="0.42" stroke="#fff" stroke-opacity="0.11" filter="url(#shadow)"/>
  <text x="120" y="142" class="meta" font-size="22" fill="{accent}">{template_label}</text>
  <text x="1080" y="142" text-anchor="end" class="meta" font-size="20" fill="#fff" opacity="0.62">{escaped_author}</text>
  {_text_block(top_lines, top_start, top_size)}
  {divider}
  {_text_block(bottom_lines, bottom_start, bottom_size)}
  <g transform="translate(500 980)">
    <rect width="200" height="72" rx="36" fill="{accent}" opacity="0.16"/>
    <path d="M142 24v-4c0-8-6-14-14-14H70c-8 0-14 6-14 14v9c0 24 19 44 43 44 2 0 3 0 5-1" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round"/>
    <rect x="94" y="0" width="10" height="22" rx="4" fill="#fff"/>
    <circle cx="84" cy="34" r="8" fill="#fff"/>
    <circle cx="116" cy="34" r="8" fill="#fff"/>
    <path d="M140 43l-12 20h10l-8 15 28-24h-11l7-11z" fill="#fff"/>
  </g>
</svg>'''

    return RenderedMeme(
        data=svg.encode("utf-8"),
        media_type="image/svg+xml",
        width=1200,
        height=1200,
    )
