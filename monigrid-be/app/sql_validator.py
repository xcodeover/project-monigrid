"""SQL validation: patterns, typo detection, and SELECT-only enforcement."""
from __future__ import annotations

import logging
import os
import re
from typing import Any

from .exceptions import SqlFileNotFoundError


SELECT_LIKE_PATTERN = re.compile(r"^\s*(select\b|with\b[\s\S]*\bselect\b)", re.IGNORECASE)
FORBIDDEN_SQL_PATTERN = re.compile(
    r"\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|call|exec|execute)\b",
    re.IGNORECASE,
)
FOR_UPDATE_PATTERN = re.compile(r"\bfor\s+update\b", re.IGNORECASE)
FROM_PATTERN = re.compile(r"\bfrom\b", re.IGNORECASE)
ORDER_WITHOUT_BY_PATTERN = re.compile(r"\border\b(?!\s+by\b)", re.IGNORECASE)
WHERE_NO_CONDITION_PATTERN = re.compile(
    r"\bwhere\b\s*(group\s+by\b|order\s+by\b|limit\b|$)",
    re.IGNORECASE,
)
ORDER_BY_NO_TARGET_PATTERN = re.compile(r"\border\s+by\b\s*(limit\b|$)", re.IGNORECASE)

DEFAULT_SQL_TYPO_PATTERNS: dict[str, tuple[str, ...]] = {
    "where": ("whre", "wehre", "wher", "wheer", "wherre", "werhe"),
    "order_by": ("oder", "odrer", "ordder", "ordr"),
    "group_by": ("gorup", "gruop", "gropu", "grup"),
    "having": ("havng", "hvaing", "havign", "haivng"),
    "join": ("jion", "joim", "jnio", "joni"),
}

SQL_TYPO_LABELS: dict[str, str] = {
    "where": "WHERE",
    "order_by": "ORDER BY",
    "group_by": "GROUP BY",
    "having": "HAVING",
    "join": "JOIN",
}


def _escape_word(word: str) -> str:
    return re.escape(str(word or "").strip().lower())


def normalize_typo_patterns(raw_typo_patterns: Any) -> dict[str, tuple[str, ...]]:
    normalized: dict[str, tuple[str, ...]] = {}
    source = raw_typo_patterns if isinstance(raw_typo_patterns, dict) else {}

    for key, defaults in DEFAULT_SQL_TYPO_PATTERNS.items():
        raw_values = source.get(key, defaults)

        if isinstance(raw_values, str):
            candidates = [token.strip() for token in re.split(r"[;,\n]", raw_values) if token.strip()]
        elif isinstance(raw_values, (list, tuple, set)):
            candidates = [str(item).strip() for item in raw_values if str(item).strip()]
        else:
            candidates = list(defaults)

        seen: set[str] = set()
        ordered: list[str] = []
        for candidate in candidates:
            lowered = candidate.lower()
            if lowered not in seen:
                seen.add(lowered)
                ordered.append(lowered)

        normalized[key] = tuple(ordered) if ordered else defaults

    return normalized


def build_typo_regexes(typo_patterns: dict[str, tuple[str, ...]] | None) -> dict[str, re.Pattern]:
    resolved = normalize_typo_patterns(typo_patterns or {})
    result: dict[str, re.Pattern] = {}

    where_terms = "|".join(_escape_word(w) for w in resolved["where"])
    order_by_terms = "|".join(_escape_word(w) for w in resolved["order_by"])
    group_by_terms = "|".join(_escape_word(w) for w in resolved["group_by"])
    having_terms = "|".join(_escape_word(w) for w in resolved["having"])
    join_terms = "|".join(_escape_word(w) for w in resolved["join"])

    result["where"] = re.compile(rf"\b({where_terms})\b", re.IGNORECASE)
    result["order_by"] = re.compile(rf"\b({order_by_terms})\s+by\b", re.IGNORECASE)
    result["group_by"] = re.compile(rf"\b({group_by_terms})\s+by\b", re.IGNORECASE)
    result["having"] = re.compile(rf"\b({having_terms})\b", re.IGNORECASE)
    result["join"] = re.compile(rf"\b({join_terms})\b", re.IGNORECASE)

    return result


def validate_select_only_sql(
    sql: str,
    typo_patterns: dict[str, tuple[str, ...]] | None = None,
) -> None:
    """Validate that SQL is a safe SELECT-only query. Raises ValueError on violations."""
    normalized_sql = str(sql or "").replace("\r\n", "\n").strip()
    normalized_sql_for_check = re.sub(r"\s+", " ", normalized_sql)
    typo_regexes = build_typo_regexes(typo_patterns)

    if not normalized_sql:
        raise ValueError("SQL script cannot be empty")

    normalized_without_trailing_semicolon = normalized_sql.rstrip("; ")
    if ";" in normalized_without_trailing_semicolon:
        raise ValueError("Only a single SELECT statement is allowed")

    if not SELECT_LIKE_PATTERN.match(normalized_sql):
        raise ValueError("Only SELECT queries are allowed")

    if not FROM_PATTERN.search(normalized_sql):
        raise ValueError("FROM clause is required")

    for key, pattern in typo_regexes.items():
        typo_match = pattern.search(normalized_sql)
        if not typo_match:
            continue
        keyword_label = SQL_TYPO_LABELS.get(key, key.upper())
        suffix = " BY" if key in {"order_by", "group_by"} else ""
        raise ValueError(
            f"Possible {keyword_label} typo detected: {typo_match.group(1).upper()}{suffix}"
        )

    if ORDER_WITHOUT_BY_PATTERN.search(normalized_sql_for_check):
        raise ValueError("ORDER keyword must be used as ORDER BY")

    if WHERE_NO_CONDITION_PATTERN.search(normalized_sql_for_check):
        raise ValueError("WHERE clause must include a condition")

    if ORDER_BY_NO_TARGET_PATTERN.search(normalized_sql_for_check):
        raise ValueError("ORDER BY clause must include sort columns")

    if FOR_UPDATE_PATTERN.search(normalized_sql):
        raise ValueError("SELECT ... FOR UPDATE is not allowed")

    forbidden_match = FORBIDDEN_SQL_PATTERN.search(normalized_sql)
    if forbidden_match:
        raise ValueError(
            f"Forbidden SQL keyword detected: {forbidden_match.group(1).upper()}"
        )


def load_sql_file(sql_id: str, sql_dir: str, logger: logging.Logger) -> str:
    """Read SQL from <sql_dir>/<sql_id>.sql on every call (no caching)."""
    sql_path = os.path.join(sql_dir, f"{sql_id}.sql")
    if not os.path.isfile(sql_path):
        logger.warning("SQL file not found sqlId=%s expectedPath=%s", sql_id, sql_path)
        raise SqlFileNotFoundError(sql_id, sql_path)
    with open(sql_path, "r", encoding="utf-8") as f:
        return f.read()
