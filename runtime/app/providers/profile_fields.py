from __future__ import annotations

from typing import Any


REMARK_FIELD_KEYS = (
    "remark",
    "remarks",
    "profile_remark",
    "profileRemark",
    "browserRemark",
    "note",
    "notes",
    "profile_note",
    "profileNote",
    "memo",
    "comment",
    "comments",
    "description",
)


def first_text(row: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = row.get(key)
        if value in (None, ""):
            continue
        if isinstance(value, (str, int, float)):
            text = str(value).strip()
            if text:
                return text
    return None


def profile_remark(row: dict[str, Any]) -> str | None:
    return first_text(row, REMARK_FIELD_KEYS)
