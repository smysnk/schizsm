from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from urllib.request import urlopen

from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

from render_support import cleanup, encode_mp4, encode_webp, write_sequence

ROOT = Path(__file__).resolve().parent
OUTPUT_PATH = ROOT / "schizm-repo-flow-demo.webp"
VIDEO_OUTPUT_PATH = ROOT / "schizm-repo-flow-demo.mp4"
SEQUENCE_DIR = ROOT / ".repo-flow-sequence"
FONT_DIR = ROOT / ".font-cache"
FONT_PATH = FONT_DIR / "IBMPlexMono-Regular.ttf"
FONT_WOFF2_URL = (
    "https://fonts.gstatic.com/s/ibmplexmono/v20/-F63fjptAgt5VM-kVkqdyU8n1i8q131nj-o.woff2"
)

FRAME_DELAY_MS = 250
WIDTH = 1600
HEIGHT = 900
BG = (8, 16, 14, 255)
PANEL = (12, 29, 19, 255)
PANEL_SOFT = (10, 24, 16, 255)
BORDER = (69, 133, 74, 255)
TEXT = (164, 255, 166, 255)
TEXT_SOFT = (113, 188, 118, 255)
TEXT_DIM = (78, 138, 83, 255)
ACCENT = (188, 255, 190, 255)
CREATE = (117, 255, 141, 255)
UPDATE = (169, 233, 128, 255)
DELETE = (255, 126, 126, 255)
MERGE = (129, 216, 255, 255)
TENTATIVE = (171, 205, 255, 255)

TITLE_FONT_SIZE = 28
LABEL_FONT_SIZE = 15
BODY_FONT_SIZE = 20
SMALL_FONT_SIZE = 16

PROMPT_HOLD_FRAMES = 4
OPERATION_HOLD_FRAMES = 4
ROUND_SETTLE_FRAMES = 6


@dataclass(frozen=True)
class FileEntry:
    path: str
    tone: str = "normal"


@dataclass(frozen=True)
class CanvasNode:
    id: str
    title: str
    x: int
    y: int
    tone: str = "normal"
    hypothesis: bool = False


@dataclass(frozen=True)
class CanvasEdge:
    start: str
    end: str
    tentative: bool = False


@dataclass(frozen=True)
class PromptRound:
    title: str
    prompt: str
    summary: str
    ops: list[str]
    files: list[FileEntry]
    nodes: list[CanvasNode]
    edges: list[CanvasEdge]
    hypothesis_state: str


ROUNDS = [
    PromptRound(
        title="Prompt 1",
        prompt="I keep getting real thoughts back when I'm washing dishes late at night.",
        summary="Create a fragment note and place it on the canvas as an isolated observation.",
        ops=[
            "create fragments/night-dishes.md",
            "append audit.md",
            "update main.canvas",
        ],
        files=[
            FileEntry("fragments/night-dishes.md", "create"),
            FileEntry("audit.md", "update"),
            FileEntry("main.canvas", "update"),
        ],
        nodes=[
            CanvasNode("night", "night dishes", 980, 290, "create"),
        ],
        edges=[],
        hypothesis_state="No hypothesis yet. The fragment stays isolated.",
    ),
    PromptRound(
        title="Prompt 2",
        prompt="It also happens while vacuuming. Repetitive chores seem to lower resistance.",
        summary="Create a second fragment and start a tentative side theory instead of forcing certainty.",
        ops=[
            "create fragments/vacuuming-opens-space.md",
            "create hypotheses/repetitive-chores-lower-resistance.md",
            "add tentative canvas link",
        ],
        files=[
            FileEntry("fragments/night-dishes.md"),
            FileEntry("fragments/vacuuming-opens-space.md", "create"),
            FileEntry(
                "hypotheses/repetitive-chores-lower-resistance.md",
                "create",
            ),
            FileEntry("audit.md", "update"),
            FileEntry("main.canvas", "update"),
        ],
        nodes=[
            CanvasNode("night", "night dishes", 900, 270),
            CanvasNode("vacuum", "vacuuming opens space", 1170, 285, "create"),
            CanvasNode(
                "hypothesis",
                "repetitive chores lower resistance?",
                1035,
                470,
                "create",
                hypothesis=True,
            ),
        ],
        edges=[
            CanvasEdge("night", "hypothesis", tentative=True),
            CanvasEdge("vacuum", "hypothesis", tentative=True),
        ],
        hypothesis_state="Tentative theory created. Evidence is suggestive, not settled.",
    ),
    PromptRound(
        title="Prompt 3",
        prompt="It may not be dishes specifically. Maybe repetitive chores create enough boredom for avoided thoughts to surface.",
        summary="Merge overlapping fragments into a stronger pattern note and preserve the evolution in audit.",
        ops=[
            "create patterns/repetitive-chores-lower-resistance.md",
            "merge fragments/night-dishes.md -> pattern",
            "merge fragments/vacuuming-opens-space.md -> pattern",
            "delete merged fragment notes",
        ],
        files=[
            FileEntry(
                "patterns/repetitive-chores-lower-resistance.md",
                "merge",
            ),
            FileEntry(
                "hypotheses/repetitive-chores-lower-resistance.md",
                "update",
            ),
            FileEntry("fragments/night-dishes.md", "delete"),
            FileEntry("fragments/vacuuming-opens-space.md", "delete"),
            FileEntry("audit.md", "update"),
            FileEntry("main.canvas", "update"),
        ],
        nodes=[
            CanvasNode(
                "pattern",
                "repetitive chores lower resistance",
                1035,
                300,
                "merge",
            ),
            CanvasNode(
                "hypothesis",
                "repetitive chores lower resistance?",
                1035,
                500,
                "update",
                hypothesis=True,
            ),
        ],
        edges=[CanvasEdge("pattern", "hypothesis")],
        hypothesis_state="Hypothesis strengthened. Pattern note now absorbs the duplicated fragments.",
    ),
    PromptRound(
        title="Prompt 4",
        prompt="The repeated clock times are probably unrelated. I only notice them because I check my phone when I pause chores.",
        summary="Create a separate concept path and explicitly weaken the earlier possible connection.",
        ops=[
            "create fragments/repeated-clock-time.md",
            "create concepts/frequency-illusion.md",
            "append repeated-clock-time into concept note",
            "disprove tentative relation to chore pattern",
        ],
        files=[
            FileEntry("patterns/repetitive-chores-lower-resistance.md"),
            FileEntry("hypotheses/repetitive-chores-lower-resistance.md"),
            FileEntry("fragments/repeated-clock-time.md", "create"),
            FileEntry("concepts/frequency-illusion.md", "create"),
            FileEntry("audit.md", "update"),
            FileEntry("main.canvas", "update"),
        ],
        nodes=[
            CanvasNode("pattern", "repetitive chores lower resistance", 880, 290),
            CanvasNode(
                "hypothesis",
                "repetitive chores lower resistance?",
                880,
                500,
                hypothesis=True,
            ),
            CanvasNode("clock", "repeated clock time", 1200, 250, "create"),
            CanvasNode("illusion", "frequency illusion", 1210, 470, "create"),
        ],
        edges=[
            CanvasEdge("pattern", "hypothesis"),
            CanvasEdge("clock", "illusion"),
        ],
        hypothesis_state="Possible cross-topic link is weakened. The clock-time thread is spun into its own concept path.",
    ),
]


def ensure_font() -> Path:
    if FONT_PATH.exists():
        return FONT_PATH

    FONT_DIR.mkdir(parents=True, exist_ok=True)
    woff_path = FONT_DIR / "IBMPlexMono-Regular.woff2"
    woff_path.write_bytes(urlopen(FONT_WOFF2_URL).read())
    font = TTFont(str(woff_path))
    font.flavor = None
    font.save(str(FONT_PATH))
    return FONT_PATH


def tone_color(tone: str) -> tuple[int, int, int, int]:
    return {
        "create": CREATE,
        "update": UPDATE,
        "delete": DELETE,
        "merge": MERGE,
        "normal": TEXT_SOFT,
    }.get(tone, TEXT_SOFT)


def wrap_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: int,
) -> list[str]:
    if not text:
        return []

    words = text.split()
    lines: list[str] = []
    current = words[0]

    for word in words[1:]:
        trial = f"{current} {word}"
        if draw.textlength(trial, font=font) <= max_width:
            current = trial
        else:
            lines.append(current)
            current = word

    lines.append(current)
    return lines


def ellipsize_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: int,
) -> str:
    if draw.textlength(text, font=font) <= max_width:
        return text

    ellipsis = "…"
    candidate = text
    while candidate:
        candidate = candidate[:-1]
        trial = candidate.rstrip() + ellipsis
        if draw.textlength(trial, font=font) <= max_width:
            return trial

    return ellipsis


def wrap_path_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: int,
) -> list[str]:
    tokens: list[str] = []
    current = ""
    separators = {"/", "-", "_"}

    for character in text:
        current += character
        if character in separators:
            tokens.append(current)
            current = ""

    if current:
        tokens.append(current)

    lines: list[str] = []
    current_line = ""

    for token in tokens:
        trial = f"{current_line}{token}"
        if not current_line or draw.textlength(trial, font=font) <= max_width:
            current_line = trial
            continue

        if current_line:
            lines.append(current_line)
        current_line = token

        while draw.textlength(current_line, font=font) > max_width and len(current_line) > 1:
            split_index = max(1, len(current_line) - 4)
            head = current_line[:split_index]
            tail = current_line[split_index:]
            lines.append(ellipsize_text(draw, head, font, max_width))
            current_line = tail

    if current_line:
        lines.append(current_line)

    return lines


def fit_lines(
    draw: ImageDraw.ImageDraw,
    lines: list[str],
    font: ImageFont.FreeTypeFont,
    max_width: int,
    max_lines: int,
) -> list[str]:
    if len(lines) <= max_lines:
        return lines

    trimmed = lines[: max_lines - 1]
    remainder = " ".join(lines[max_lines - 1 :])
    trimmed.append(ellipsize_text(draw, remainder, font, max_width))
    return trimmed


def blend_color(
    start: tuple[int, int, int, int],
    end: tuple[int, int, int, int],
    ratio: float,
) -> tuple[int, int, int, int]:
    return tuple(
        int(round(start[index] + (end[index] - start[index]) * ratio)) for index in range(4)
    )


def draw_panel(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    title: str,
    title_font: ImageFont.FreeTypeFont,
    body_fill: tuple[int, int, int, int] = PANEL,
) -> None:
    draw.rounded_rectangle(box, radius=20, fill=body_fill, outline=BORDER, width=2)
    draw.text((box[0] + 24, box[1] + 18), title, font=title_font, fill=ACCENT)


def draw_prompt_panel(
    draw: ImageDraw.ImageDraw,
    round_data: PromptRound,
    fonts: dict[str, ImageFont.FreeTypeFont],
    op_index: int,
) -> None:
    box = (42, 42, 618, 382)
    draw_panel(draw, box, round_data.title, fonts["title"])
    draw.text((66, 92), "Prompt", font=fonts["label"], fill=TEXT_DIM)

    y = 126
    for line in wrap_text(draw, round_data.prompt, fonts["body"], 510):
        draw.text((66, y), line, font=fonts["body"], fill=TEXT)
        y += 34

    draw.text((66, 250), "Decision", font=fonts["label"], fill=TEXT_DIM)
    decision_y = 274
    for line in fit_lines(
        draw,
        wrap_text(draw, round_data.summary, fonts["small"], 510),
        fonts["small"],
        510,
        2,
    ):
        draw.text((66, decision_y), line, font=fonts["small"], fill=TEXT_SOFT)
        decision_y += 24

    draw.text((66, 305), "Ops this round", font=fonts["label"], fill=TEXT_DIM)
    op_y = 338
    for index, operation in enumerate(round_data.ops):
        is_active = index == op_index
        fill = ACCENT if is_active else TEXT_SOFT
        badge_fill = tone_color("merge" if "merge" in operation else "create" if "create" in operation else "delete" if "delete" in operation else "update")
        op_lines = fit_lines(
            draw,
            wrap_path_text(draw, operation, fonts["small"], 474),
            fonts["small"],
            474,
            2,
        )
        row_height = 18 + (len(op_lines) * 20)
        if is_active:
            draw.rounded_rectangle((66, op_y - 8, 592, op_y - 8 + row_height), radius=10, fill=(19, 55, 29, 180))
        draw.rounded_rectangle((78, op_y - 1, 88, op_y + 9), radius=4, fill=badge_fill)
        line_y = op_y - 12
        for line in op_lines:
            draw.text((102, line_y), line, font=fonts["small"], fill=fill)
            line_y += 18
        op_y += row_height + 2


def draw_file_tree(
    draw: ImageDraw.ImageDraw,
    round_data: PromptRound,
    fonts: dict[str, ImageFont.FreeTypeFont],
    op_index: int,
) -> None:
    box = (42, 412, 618, 854)
    draw_panel(draw, box, "Document store", fonts["title"])
    active_op = round_data.ops[op_index] if round_data.ops else ""

    y = 464
    for entry in round_data.files:
        fill = tone_color(entry.tone)
        is_related = any(token in active_op for token in entry.path.replace(".md", "").split("/"))
        bg_fill = (18, 52, 30, 180) if is_related else PANEL_SOFT
        path_lines = fit_lines(
            draw,
            wrap_path_text(draw, entry.path, fonts["small"], 366),
            fonts["small"],
            366,
            2,
        )
        row_height = 16 + (len(path_lines) * 20)
        draw.rounded_rectangle((66, y - 8, 590, y - 8 + row_height), radius=10, fill=bg_fill)
        line_y = y - 10
        for line in path_lines:
            draw.text((82, line_y), line, font=fonts["small"], fill=fill)
            line_y += 18
        if entry.tone != "normal":
            badge_x = 466
            badge_text = entry.tone.upper()
            badge_width = badge_x + 102
            draw.rounded_rectangle((badge_x, y - 8, badge_width, y + 18), radius=10, outline=fill, width=2)
            draw.text((badge_x + 14, y - 10), badge_text, font=fonts["label"], fill=fill)
        y += row_height + 10


def draw_canvas(
    draw: ImageDraw.ImageDraw,
    round_data: PromptRound,
    fonts: dict[str, ImageFont.FreeTypeFont],
    pulse: float,
) -> None:
    box = (650, 42, 1556, 646)
    draw_panel(draw, box, "Obsidian canvas", fonts["title"])
    inner = (674, 92, 1532, 622)
    draw.rounded_rectangle(inner, radius=18, fill=(7, 20, 13, 255), outline=(36, 78, 41, 255), width=2)

    node_map = {node.id: node for node in round_data.nodes}
    for edge in round_data.edges:
        start = node_map[edge.start]
        end = node_map[edge.end]
        color = TENTATIVE if edge.tentative else TEXT_SOFT
        if edge.tentative:
            for offset in range(0, 16, 2):
                ratio = offset / 16
                x1 = start.x + 60
                y1 = start.y + 28
                x2 = end.x + 60
                y2 = end.y + 28
                sx = x1 + (x2 - x1) * ratio
                sy = y1 + (y2 - y1) * ratio
                ex = x1 + (x2 - x1) * min(1, ratio + 0.06)
                ey = y1 + (y2 - y1) * min(1, ratio + 0.06)
                draw.line((sx, sy, ex, ey), fill=color, width=2)
        else:
            draw.line(
                (start.x + 60, start.y + 28, end.x + 60, end.y + 28),
                fill=color,
                width=3,
            )

    for node in round_data.nodes:
        glow = 0.25 + (math.sin(pulse * math.pi) + 1) * 0.12 if node.tone != "normal" else 0.18
        outline = tone_color(node.tone)
        fill = blend_color((11, 36, 18, 255), outline, glow)
        card = (node.x, node.y, node.x + 190, node.y + 78)
        draw.rounded_rectangle(card, radius=16, fill=fill, outline=outline, width=2)
        label = node.title + (" ?" if node.hypothesis else "")
        text_lines = fit_lines(
            draw,
            wrap_text(draw, label, fonts["small"], 160),
            fonts["small"],
            160,
            2,
        )
        y = node.y + 18
        for line in text_lines:
            draw.text((node.x + 18, y), line, font=fonts["small"], fill=TEXT)
            y += 22

    hypothesis_lines = fit_lines(
        draw,
        wrap_text(draw, round_data.hypothesis_state, fonts["small"], 810),
        fonts["small"],
        810,
        2,
    )
    hypothesis_y = 570
    for line in hypothesis_lines:
        draw.text((692, hypothesis_y), line, font=fonts["small"], fill=TEXT_DIM)
        hypothesis_y += 22


def draw_timeline(
    draw: ImageDraw.ImageDraw,
    round_index: int,
    fonts: dict[str, ImageFont.FreeTypeFont],
) -> None:
    draw.text((676, 690), "Prompt rounds", font=fonts["label"], fill=TEXT_DIM)
    x = 676
    y = 726

    for index, round_data in enumerate(ROUNDS):
        active = index == round_index
        fill = ACCENT if active else TEXT_DIM
        border = CREATE if active else BORDER
        width = 190
        draw.rounded_rectangle((x, y, x + width, y + 52), radius=14, fill=PANEL_SOFT, outline=border, width=2)
        draw.text((x + 16, y + 8), round_data.title, font=fonts["small"], fill=fill)
        summary = ellipsize_text(draw, round_data.summary, fonts["label"], 156)
        draw.text((x + 16, y + 28), summary, font=fonts["label"], fill=TEXT_DIM)
        x += width + 14


def render_round_frame(
    round_index: int,
    op_index: int,
    op_progress: float,
    fonts: dict[str, ImageFont.FreeTypeFont],
) -> Image.Image:
    frame = Image.new("RGBA", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(frame)

    draw_prompt_panel(draw, ROUNDS[round_index], fonts, op_index)
    draw_file_tree(draw, ROUNDS[round_index], fonts, op_index)
    draw_canvas(draw, ROUNDS[round_index], fonts, op_progress)
    draw_timeline(draw, round_index, fonts)

    footer_lines = [
        "From left to right: prompt -> repo diff -> top-down Obsidian canvas.",
        "Creates, merges, deletes, and hypothesis changes accumulate across prompts.",
    ]
    footer_y = 830
    for footer in footer_lines:
        draw.text(
            (676, footer_y),
            ellipsize_text(draw, footer, fonts["label"], 848),
            font=fonts["label"],
            fill=TEXT_DIM,
        )
        footer_y += 22
    return frame


def build_sequence() -> list[Image.Image]:
    font_path = ensure_font()
    fonts = {
        "title": ImageFont.truetype(str(font_path), TITLE_FONT_SIZE),
        "label": ImageFont.truetype(str(font_path), LABEL_FONT_SIZE),
        "body": ImageFont.truetype(str(font_path), BODY_FONT_SIZE),
        "small": ImageFont.truetype(str(font_path), SMALL_FONT_SIZE),
    }
    frames: list[Image.Image] = []

    for round_index, round_data in enumerate(ROUNDS):
        for _ in range(PROMPT_HOLD_FRAMES):
            frames.append(render_round_frame(round_index, 0, 0.0, fonts))

        for op_index, _operation in enumerate(round_data.ops):
            for step in range(OPERATION_HOLD_FRAMES):
                progress = (step + 1) / OPERATION_HOLD_FRAMES
                frames.append(render_round_frame(round_index, op_index, progress, fonts))

        for _ in range(ROUND_SETTLE_FRAMES):
            frames.append(
                render_round_frame(
                    round_index,
                    max(0, len(round_data.ops) - 1),
                    1.0,
                    fonts,
                )
            )

    return frames


def main() -> None:
    frames = build_sequence()
    write_sequence(SEQUENCE_DIR, frames)
    try:
        encode_webp(SEQUENCE_DIR, OUTPUT_PATH, FRAME_DELAY_MS)
        encode_mp4(SEQUENCE_DIR, VIDEO_OUTPUT_PATH, FRAME_DELAY_MS)
    finally:
        cleanup(SEQUENCE_DIR)

    print(
        f"Rendered {OUTPUT_PATH} and {VIDEO_OUTPUT_PATH} from {len(frames)} source frames."
    )


if __name__ == "__main__":
    main()
