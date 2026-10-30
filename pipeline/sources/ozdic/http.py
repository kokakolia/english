"""Общая HTTP-сессия для обращений к ozdic.com.

Правила вежливости, которых придерживаемся:
  * не трогаем `/api/`, `/search`, `/me`, `/saved`, `/preview` — они закрыты в robots.txt;
  * список слов берём из sitemap, как и предполагает сайт;
  * одна страница за запрос, с паузой между запросами и уважением к Retry-After.
"""

from __future__ import annotations

import requests
import math
import time
from email.utils import parsedate_to_datetime
from urllib.parse import unquote, urljoin, urlsplit
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_URL = "https://ozdic.com"
MAX_RESPONSE_BYTES = 16 * 1024 * 1024


class ResponseLimitError(ValueError):
    """Ответ целиком превышает разрешённый распакованный объём."""


def read_source_text(response: requests.Response, max_bytes: int = MAX_RESPONSE_BYTES) -> str:
    """iter_content отдаёт распакованные байты; .text/.content до лимита не читаем."""
    body = bytearray()
    try:
        for chunk in response.iter_content(chunk_size=64 * 1024, decode_unicode=False):
            if len(body) + len(chunk) > max_bytes:
                raise ResponseLimitError("превышен размер HTTP-ответа источника")
            body.extend(chunk)
        try:
            return body.decode(response.encoding or "utf-8", errors="replace")
        except LookupError as exc:
            raise ResponseLimitError("неизвестная кодировка HTTP-ответа") from exc
    finally:
        response.close()


class SourceUrlError(ValueError):
    """URL вне разрешённого HTTPS-источника или небезопасный redirect."""


def validate_source_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        allowed = (parsed.scheme == "https" and parsed.hostname == "ozdic.com"
                   and parsed.port in (None, 443) and parsed.username is None
                   and parsed.password is None and not parsed.fragment
                   and not any(character.isspace() or ord(character) < 32 for character in url)
                   and "\\" not in url and is_allowed(unquote(parsed.path)))
    except (ValueError, TypeError) as exc:
        raise SourceUrlError("неверный URL источника") from exc
    if not allowed:
        raise SourceUrlError(f"URL вне разрешённого источника: {url}")
    return url


def source_get(session: requests.Session, url: str, timeout: int = 60,
               *, sitemap: bool = False) -> requests.Response:
    """Проверяет каждый адрес ДО запроса, включая все перенаправления."""
    for _ in range(6):
        validate_source_url(url)
        if sitemap:
            path = urlsplit(url).path
            if not path.startswith("/sitemap") or not path.endswith(".xml") or "%" in path or ".." in path:
                raise SourceUrlError(f"ожидался sitemap XML: {url}")
        retries = getattr(session, "_source_status_retries", 0)
        retries = retries if isinstance(retries, int) else 0
        for attempt in range(retries + 1):
            response = session.get(url, timeout=timeout, allow_redirects=False, stream=True)
            if response.status_code not in (429, 500, 502, 503, 504) or attempt == retries:
                break
            # urllib3 автоматически дочитывает тело перед повтором. Закрываем
            # поток сами, чтобы большой ответ 503 тоже не попал в память.
            retry_after = response.headers.get("Retry-After")
            response.close()
            delay = float(getattr(session, "_source_backoff", 1.5)) * (2 ** attempt)
            if retry_after:
                try:
                    seconds = float(retry_after) if retry_after.isdigit() else parsedate_to_datetime(retry_after).timestamp() - time.time()
                    if math.isfinite(seconds):
                        delay = max(delay, seconds)
                except (ValueError, TypeError, OverflowError):
                    pass
            time.sleep(min(60, max(0, delay)))
        if response.status_code not in (301, 302, 303, 307, 308):
            return response
        location = response.headers.get("Location")
        response.close()
        if not location:
            raise SourceUrlError("redirect без адреса назначения")
        url = urljoin(url, location)
    raise SourceUrlError("слишком много перенаправлений источника")

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
        status=0,
        backoff_factor=backoff,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=8, pool_maxsize=8)

    session = requests.Session()
    session._source_status_retries = total_retries
    session._source_backoff = backoff
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
