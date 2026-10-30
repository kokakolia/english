"""Сбор списка слов ozdic из sitemap.

Сайт — SPA на Nuxt: страницы `/browse/<буква>` наполняются на клиенте через
`/api/`, который закрыт в robots.txt. Легальный и предусмотренный самим сайтом
способ получить список статей — sitemap, на него же указывает robots.txt.
"""

from __future__ import annotations

import re
import time
from urllib.parse import unquote, urlparse

import requests

from . import storage
from .http import BASE_URL, make_session, source_get, validate_source_url, read_source_text

SITEMAP_INDEX = f"{BASE_URL}/sitemap_index.xml"

_LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.IGNORECASE)
_WORD_PATH_RE = re.compile(r"^/word/(.+)$")


def _fetch_text(session: requests.Session, url: str, timeout: int = 60) -> str:
    response = source_get(session, url, timeout, sitemap=True)
    try:
        response.raise_for_status()
        return read_source_text(response)
    finally:
        response.close()


def fetch_word_slugs(
    session: requests.Session | None = None, delay: float = 1.0
) -> list[str]:
    """Возвращает отсортированный список слагов всех статей `/word/<slug>`."""
    own_session = session is None
    session = session or make_session()
    try:
        index_xml = _fetch_text(session, SITEMAP_INDEX)
        shard_urls = _LOC_RE.findall(index_xml)
        print(f"sitemap: {len(shard_urls)} частей")

        slugs: set[str] = set()
        for number, shard_url in enumerate(shard_urls, 1):
            time.sleep(delay)
            shard_xml = _fetch_text(session, shard_url)
            found = 0
            for url in _LOC_RE.findall(shard_xml):
                validate_source_url(url)
                match = _WORD_PATH_RE.match(urlparse(url).path)
                if match:
                    slug = unquote(match.group(1)).strip().strip("/")
                    if slug:
                        slugs.add(slug)
                        found += 1
            print(f"  часть {number}/{len(shard_urls)}: +{found} слов")
        return sorted(slugs)
    finally:
        if own_session:
            session.close()


def load_word_slugs() -> list[str]:
    """Читает ранее сохранённый список слов."""
    if not storage.WORDS_FILE.exists():
        return []
    text = storage.WORDS_FILE.read_text(encoding="utf-8")
    return [line.strip() for line in text.splitlines() if line.strip()]


def save_word_slugs(slugs: list[str]) -> None:
    storage.WORDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    storage.WORDS_FILE.write_text("\n".join(slugs) + "\n", encoding="utf-8")


def ensure_word_slugs(refresh: bool = False, delay: float = 1.0) -> list[str]:
    """Список слов из кэша, при необходимости — со скачиванием sitemap."""
    if not refresh:
        cached = load_word_slugs()
        if cached:
            return cached
    slugs = fetch_word_slugs(delay=delay)
    save_word_slugs(slugs)
    return slugs
