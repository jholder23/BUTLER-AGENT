from __future__ import annotations

import web_fetcher
from search_planner import prepend_subject_priority_queries


def test_subject_profile_detects_coding_docs() -> None:
    profile = web_fetcher._query_subject_source_profile(
        "python requests session api docs and reference"
    )
    assert profile
    assert profile["key"] == "coding_dev_docs"
    assert "docs.python.org" in profile["domains"]


def test_subject_profile_detects_health_sources() -> None:
    profile = web_fetcher._query_subject_source_profile(
        "measles symptoms treatment and vaccine guidance"
    )
    assert profile
    assert profile["key"] == "health_medical"
    assert "cdc.gov" in profile["domains"]
    assert "nih.gov" in profile["domains"]


def test_prepend_subject_priority_queries_seeds_trusted_domains() -> None:
    out = prepend_subject_priority_queries(
        "react useeffect cleanup docs",
        ["react useeffect cleanup explanation", "react useeffect cleanup reddit"],
        max_queries=6,
    )
    assert out
    assert any("site:react.dev" in q.lower() for q in out[:3])


def test_rank_search_results_prefers_trusted_domain() -> None:
    rows = [
        {
            "title": "Random blog on React useEffect cleanup",
            "url": "https://example-blog.com/react-useeffect-cleanup",
            "snippet": "React useEffect cleanup article and examples.",
        },
        {
            "title": "Synchronizing with Effects - React",
            "url": "https://react.dev/learn/synchronizing-with-effects",
            "snippet": "Official React docs covering effects and cleanup.",
        },
    ]
    profile = web_fetcher._query_subject_source_profile("react useeffect cleanup docs")
    ranked = web_fetcher._rank_search_results(
        "react useeffect cleanup docs", rows, profile
    )
    assert ranked[0]["url"].startswith("https://react.dev/")


def test_gather_web_answer_context_expands_with_trusted_health_sources(monkeypatch) -> None:
    def fake_search(query: str, max_results: int = 5) -> list[dict[str, str]]:
        q = query.lower()
        if "site:cdc.gov" in q:
            return [
                {
                    "title": "CDC measles symptoms",
                    "url": "https://www.cdc.gov/measles/signs-symptoms/index.html",
                    "snippet": "Official measles signs and symptoms guidance.",
                }
            ]
        if "site:medlineplus.gov" in q:
            return [
                {
                    "title": "MedlinePlus measles",
                    "url": "https://medlineplus.gov/measles.html",
                    "snippet": "Patient-friendly measles treatment information.",
                }
            ]
        return [
            {
                "title": "General blog post",
                "url": "https://example.com/measles-overview",
                "snippet": "Short overview.",
            }
        ]

    monkeypatch.setattr(web_fetcher, "search_web", fake_search)
    monkeypatch.setattr(
        web_fetcher,
        "fetch_page",
        lambda url: f"Detailed trusted content from {url}. " + ("evidence " * 40),
    )
    monkeypatch.setattr(
        web_fetcher, "wikipedia_context_from_queries", lambda *args, **kwargs: ""
    )
    monkeypatch.setenv("BUTLER_WEB_MAX_PAGE_FETCHES", "1")

    text = web_fetcher.gather_web_answer_context(
        "measles symptoms treatment guidance", max_chars=3200
    )

    assert "cdc.gov" in text.lower()
    assert "medlineplus.gov" in text.lower()
    assert "trusted source page" in text.lower()
