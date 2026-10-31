"""Маленький словарный ввод не должен создавать экспоненциальную работу."""
import subprocess
import sys
import unittest

from .build import normalize_entry
from .inflect import find_span, phrase_regex, sequence_regex
from .limits import MAX_MATCH_STATES, NormalizationLimitError, SearchBudget
from .variants import expand


class ExpansionBudgetTest(unittest.TestCase):
    def test_slashes_optional_and_combined_expansion_fail_explicitly(self):
        for expression in (" ".join(["a/b"] * 16), " ".join(["(a)"] * 16),
                           " ".join(["(a/b)"] * 6), "a" * 2049):
            with self.subTest(expression=expression), self.assertRaises(NormalizationLimitError):
                expand(expression)

    def test_budget_is_shared_by_all_members_of_a_cluster(self):
        entry = {"word": "word", "collocations": [{"groups": [{"cat": "PHRASES", "clusters": [
            {"words": [f"word{i} " + " ".join(["a/b"] * 8) for i in range(5)]}]}]}]}
        with self.assertRaisesRegex(NormalizationLimitError, "варианты кластера"):
            normalize_entry(entry, "word", None)

    def test_exact_limit_is_allowed_and_does_not_silently_truncate(self):
        variants, _ = expand(" ".join(["a/b"] * 8))
        self.assertEqual(len(variants), 256)
        self.assertEqual(variants[0], " ".join(["a"] * 8))
        self.assertEqual(variants[-1], " ".join(["b"] * 8))


class PhraseBudgetTest(unittest.TestCase):
    def test_adversarial_templates_complete_through_both_production_callers(self):
        # Отдельный процесс: регрессия не должна повесить сам набор проверок.
        program = """
from pipeline.deck.build import other_cluster_members
from pipeline.normalize.inflect import sequence_regex
phrase = ' '.join(['sb'] * 24 + ['finish'])
answer = ' '.join(['word'] * 48 + ['missing'])
assert other_cluster_members([phrase], None, answer) == [phrase]
assert sequence_regex(phrase.split(), (24, 25)).search(answer) is None
"""
        result = subprocess.run([sys.executable, "-c", program], capture_output=True,
                                text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_phrase_example_and_token_limits_are_enforced(self):
        for operation in (lambda: phrase_regex(" ".join(["sb"] * 33)),
                          lambda: phrase_regex("a" * 129),
                          lambda: phrase_regex("word").search("x " * 8193),
                          lambda: phrase_regex("sb").search("a" * 129),
                          lambda: phrase_regex("sb").search("İ" * 129)):
            with self.assertRaises(NormalizationLimitError):
                operation()

    def test_budget_is_shared_across_searches_and_production_candidates(self):
        from .build import _locate
        from .patterns import PHRASE
        from ..deck.build import other_cluster_members
        pattern = phrase_regex("word")
        budget = SearchBudget(states=MAX_MATCH_STATES - 1)
        self.assertIsNotNone(pattern.search("word", budget=budget))
        with self.assertRaisesRegex(NormalizationLimitError, "состояния"):
            pattern.search("word", budget=budget)
        candidates = [f"word{i}" for i in range(100)]
        long_answer = ("a" * 120 + " ") * 130
        for operation in (lambda: _locate(long_answer, "word", PHRASE, candidates),
                          lambda: other_cluster_members(candidates, None, long_answer)):
            with self.assertRaisesRegex(NormalizationLimitError, "суммарный ввод"):
                operation()

    def test_placeholders_backtrack_over_states_without_losing_boundaries(self):
        text = "Yesterday I heard my neighbor play the violin."
        pattern = sequence_regex(["hear", "sb", "play"], (0, 1))
        matched = pattern.search(text)
        self.assertEqual(text[slice(*matched.span(1))], "heard")
        self.assertEqual(text[slice(*matched.span())], "heard my neighbor play")
        self.assertIsNotNone(phrase_regex("sb sb finish").fullmatch("one two finish"))
        self.assertEqual(find_span("A real-life event.", "real life"), (2, 11))
        self.assertIsNotNone(phrase_regex("sb home").fullmatch("my-neighbor-home"))
        self.assertIsNotNone(phrase_regex("squatters' right").fullmatch("squatters' rights"))
        self.assertIsNone(phrase_regex("make decision").fullmatch("make a decision extra"))


if __name__ == "__main__":
    unittest.main()
