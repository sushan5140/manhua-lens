"""Standard-library tests for the Korean voice server's text preparation."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "voice_server"))

from speech_text import prepare_speech_text  # noqa: E402


class PrepareSpeechTextTest(unittest.TestCase):
    def test_bubble_lines_get_clause_pauses(self):
        self.assertEqual(
            prepare_speech_text("왜 이제 왔어\n한참 기다렸잖아\n진짜 걱정했단 말이야"),
            "왜 이제 왔어, 한참 기다렸잖아, 진짜 걱정했단 말이야",
        )

    def test_blank_line_gets_sentence_pause(self):
        self.assertEqual(prepare_speech_text("잠깐만요\r\n\r\n그게 무슨 뜻이에요?"), "잠깐만요. 그게 무슨 뜻이에요?")

    def test_existing_punctuation_is_untouched(self):
        for text in (
            "잠깐만요, 그게 무슨 뜻이에요? 설마 저를 버리고 가시려는 건 아니죠?",
            "그게... 사실은... 나도 몰라",
            "안녕하세요.",
        ):
            self.assertEqual(prepare_speech_text(text), text)
        self.assertEqual(prepare_speech_text("뭐라고?!\n말도 안 돼"), "뭐라고?! 말도 안 돼")
        self.assertEqual(prepare_speech_text("“가자!”\n\n응"), "“가자!” 응")

    def test_whitespace_only_is_empty(self):
        self.assertEqual(prepare_speech_text("  \n \t\n "), "")
        self.assertEqual(prepare_speech_text(None), "")

    def test_matches_extension_rules(self):
        self.assertEqual(prepare_speech_text("  황자님   믿어요  "), "황자님 믿어요")


if __name__ == "__main__":
    unittest.main()
