"""标签分级：Danbooru 四档取标签下限和模型 rating 里更高的一档。"""

import unittest

from critic.tag import _select_tags, grade


class GradeTest(unittest.TestCase):
    def test_plain_tags_stay_general(self):
        result = grade([("1girl", 0.9), ("large_breasts", 0.8), ("swimsuit", 0.7)], {"general": 0.8})
        self.assertEqual(result["rating"], "general")
        self.assertEqual(result["rating_hits"], [])

    def test_tag_floor_raises_over_model(self):
        result = grade([("nipples", 0.8), ("nude", 0.6)], {"general": 0.9, "sensitive": 0.2})
        self.assertEqual(result["rating"], "questionable")
        self.assertEqual(result["rating_tags"], "questionable")
        self.assertEqual(result["rating_hits"], ["nipples", "nude"])

    def test_weak_explicit_tag_does_not_raise(self):
        result = grade([("penis", 0.2)], {"general": 0.9})
        self.assertEqual(result["rating"], "general")

    def test_explicit_tag_beats_sensitive_head(self):
        result = grade(
            [("penis", 0.6), ("cleavage", 0.7)],
            {"sensitive": 0.8, "explicit": 0.1},
        )
        self.assertEqual(result["rating"], "explicit")
        self.assertEqual(result["rating_hits"], ["penis"])

    def test_confident_head_raises_without_tags(self):
        result = grade([("1girl", 0.9)], {"explicit": 0.8, "general": 0.1})
        self.assertEqual(result["rating"], "explicit")
        self.assertEqual(result["rating_model"], "explicit")
        self.assertEqual(result["rating_hits"], [])

    def test_weak_head_is_ignored(self):
        result = grade([], {"explicit": 0.2, "general": 0.1})
        self.assertEqual(result["rating"], "general")
        self.assertEqual(result["rating_model"], "")

    def test_select_tags_grades_and_keeps_caption(self):
        entries = [("1girl", 0), ("nipples", 0), ("artist", 1), ("general", 9), ("explicit", 9)]
        result = _select_tags([0.9, 0.8, 0.7, 0.95, 0.1], entries)
        self.assertEqual(result["tags"], ["1girl", "nipples"])
        self.assertEqual(result["rating"], "questionable")

    def test_select_tags_reads_rating_explicit_name(self):
        entries = [("1girl", 0), ("rating_explicit", 9)]
        result = _select_tags([0.4, 0.7], entries)
        self.assertEqual(result["rating"], "explicit")
        self.assertEqual(result["rating_model"], "explicit")

    def test_excluded_sensitive_tag_does_not_raise(self):
        entries = [("nipples", 0), ("general", 9)]
        result = _select_tags([0.9, 0.8], entries, exclude_tags=["Nipples"])
        self.assertEqual(result["tags"], [])
        self.assertEqual(result["rating"], "general")


if __name__ == "__main__":
    unittest.main()
