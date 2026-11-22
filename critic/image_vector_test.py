"""向量缓存与分组的行为：upsert、版本守卫、候选集过滤、聚类中心。"""

import unittest

from critic import image_vector


class ImageVectorTest(unittest.TestCase):
    def setUp(self):
        image_vector.reset()

    def tearDown(self):
        image_vector.reset()

    def test_sync_appends_and_overwrites(self):
        first = image_vector.sync({"a": [1, 0], "b": [0.9, 0.1]}, "v1")
        self.assertEqual(first["added"], 2)
        second = image_vector.sync({"a": [0, 1], "c": [0.2, 0.9]}, "v1")
        self.assertEqual(second["added"], 1)
        self.assertEqual(second["updated"], 1)
        self.assertEqual(image_vector.state()["count"], 3)
        near = image_vector.nearest("c", 1)
        self.assertEqual(near["neighbors"][0]["id"], "a")

    def test_sync_rejects_dimension_and_version_drift(self):
        image_vector.sync({"a": [1, 0]}, "v1")
        with self.assertRaisesRegex(ValueError, "维度不一致"):
            image_vector.sync({"b": [1, 0, 0]}, "v1")
        with self.assertRaisesRegex(ValueError, "模型不一致"):
            image_vector.sync({"b": [1, 0]}, "v2")

    def test_nearest_filters_candidates(self):
        image_vector.sync({"a": [1, 0], "b": [0.9, 0.1], "c": [0, 1]}, "v1")
        near = image_vector.nearest("a", 5, only=["a", "c"])
        self.assertEqual([item["id"] for item in near["neighbors"]], ["c"])
        far = image_vector.nearest("a", 5, order="far")
        self.assertEqual([item["id"] for item in far["neighbors"]], ["c", "b"])

    def test_nearest_rejects_unknown_id(self):
        image_vector.sync({"a": [1, 0]}, "v1")
        with self.assertRaisesRegex(ValueError, "不在缓存中"):
            image_vector.nearest("zzz", 1)

    def test_split_clusters_and_reports_medoid(self):
        vectors = {
            "a": [1.0, 0.0],
            "b": [0.95, 0.05],
            "c": [0.9, 0.1],
            "d": [0.0, 1.0],
            "e": [0.05, 0.95],
        }
        result = image_vector.split(list(vectors), 2, vectors=vectors)
        groups = result["groups"]
        self.assertEqual(len(groups), 2)
        self.assertEqual(sorted(groups[0]["ids"] + groups[1]["ids"]), sorted(vectors))
        biggest = max(groups, key=lambda group: len(group["ids"]))
        self.assertEqual(sorted(biggest["ids"]), ["a", "b", "c"])
        self.assertIn(biggest["centerId"], biggest["ids"])

    def test_split_even_keeps_sizes_balanced(self):
        vectors = {f"i{index:02d}": [float(index), 1.0] for index in range(10)}
        result = image_vector.split(
            list(vectors), 3, vectors=vectors, balance="even"
        )
        sizes = [len(group["ids"]) for group in result["groups"]]
        self.assertEqual(sizes, [4, 3, 3])

    def test_split_rejects_unknown_balance(self):
        vectors = {"a": [1.0, 0.0], "b": [0.0, 1.0]}
        with self.assertRaisesRegex(ValueError, "balance"):
            image_vector.split(list(vectors), 2, vectors=vectors, balance="kmeans")


if __name__ == "__main__":
    unittest.main()
