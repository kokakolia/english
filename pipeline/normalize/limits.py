"""Бюджеты работы после распаковки сырья: входной размер сам по себе недостаточен."""
from dataclasses import dataclass

MAX_EXPRESSION_CHARS = 2048
MAX_VARIANTS = 256
MAX_CLUSTER_VARIANTS = 1024
MAX_PHRASE_TOKENS = 32
MAX_TOKEN_CHARS = 128
MAX_EXAMPLE_CHARS = 16_384
MAX_MATCH_STATES = 100_000
MAX_MATCH_INPUT_CHARS = 1_000_000


class NormalizationLimitError(ValueError):
    """Данные требуют ручной проверки, а не усечения с потерей вариантов."""


def require_budget(size: int, limit: int, description: str) -> None:
    if size > limit:
        raise NormalizationLimitError(f"{description}: {size} превышает предел {limit}")


@dataclass
class SearchBudget:
    """Общий бюджет для всех вариантов одного кластера, а не новый на каждый."""
    states: int = 0
    input_chars: int = 0

    def scan(self, size: int) -> None:
        self.input_chars += size
        require_budget(self.input_chars, MAX_MATCH_INPUT_CHARS, "суммарный ввод поиска")

    def advance(self) -> None:
        self.states += 1
        require_budget(self.states, MAX_MATCH_STATES, "состояния поиска фразы")
