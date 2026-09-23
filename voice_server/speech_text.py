"""Prepare selected Korean text so MeloTTS keeps natural dialogue pauses.

Mirrors prepareSpeechText() in background.js. Text selected across manhwa
speech bubbles arrives as bare lines with no punctuation; MeloTTS turns the
line breaks into spaces and reads every bubble as one run-on sentence. A
line break becomes a light clause pause (",") and a blank line a sentence
pause ("."). Existing punctuation is never changed.
"""
import re

_TRAILING_CLOSERS = re.compile(r"[\s\"'”’」』）)\]】》〉]+$")
_ENDS_WITH_PAUSE = re.compile(r"[.!?…,;:~\-—、。，！？；：～]$")
_PARAGRAPH_BREAK = re.compile(r"\n[ \t 　]*\n\s*")
_SPACES = re.compile(r"[ \t 　]+")


def _with_pause(line, mark):
    return line if _ENDS_WITH_PAUSE.search(_TRAILING_CLOSERS.sub("", line)) else line + mark


def prepare_speech_text(text):
    text = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = []
    for paragraph in _PARAGRAPH_BREAK.split(text):
        lines = [_SPACES.sub(" ", line).strip() for line in paragraph.split("\n")]
        lines = [line for line in lines if line]
        if lines:
            paragraphs.append(lines)

    spoken = []
    for p, lines in enumerate(paragraphs):
        for i, line in enumerate(lines):
            if i < len(lines) - 1:
                line = _with_pause(line, ",")
            elif p < len(paragraphs) - 1:
                line = _with_pause(line, ".")
            spoken.append(line)
    return " ".join(spoken)
