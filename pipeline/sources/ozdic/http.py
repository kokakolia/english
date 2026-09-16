"""Общая HTTP-сессия для обращений к ozdic.com.

Правила вежливости, которых придерживаемся:
  * не трогаем `/api/`, `/search`, `/me`, `/saved`, `/preview` — они закрыты в robots.txt;
  * список слов берём из sitemap, как и предполагает сайт;
  * одна страница за запрос, с паузой между запросами и уважением к Retry-After.
"""

from __future__ import annotations

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_URL = "https://ozdic.com"

# Пути, закрытые в robots.txt — краулер в них не ходит.
DISALLOWED_PREFIXES = ("/api/", "/preview", "/me", "/saved", "/search")

USER_AGENT = (
    "collocation-srs-bot/0.1 (personal spaced-repetition deck builder; "
    "contact: razunikolai@gmail.com)"
)


def is_allowed(path: str) -> bool:
    """Проверяет путь по robots.txt сайта."""
    return not path.startswith(DISALLOWED_PREFIXES)


def _accept_encoding() -> str:
    """br объявляем только если urllib3 действительно умеет его разжать:
    иначе сервер пришлёт brotli, а на руках окажется мусор вместо текста."""
    encodings = ["gzip", "deflate"]
    try:
        import brotli  # noqa: F401
    except ImportError:
        try:
            import brotlicffi  # noqa: F401
        except ImportError:
            return ", ".join(encodings)
    return ", ".join(encodings + ["br"])


def make_session(total_retries: int = 3, backoff: float = 1.5) -> requests.Session:
    """Сессия с повторами на 429/5xx и экспоненциальной задержкой."""
    retry = Retry(
        total=total_retries,
        connect=total_retries,
        read=total_retries,
        status=total_retries,
        backoff_factor=backoff,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=8, pool_maxsize=8)

    session = requests.Session()
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": _accept_encoding(),
        }
    )
    return session
