from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from app.schemas.workflow import LocatorCandidate, LocatorSpec


@dataclass
class LocatorValidationResult:
    valid: bool
    uniqueness_score: float
    stability_score: float
    warnings: list[str]
    normalized_locator: LocatorSpec


class LocatorService:
    def generate_candidates(
        self,
        *,
        tag_name: str,
        text: str | None,
        attributes: dict[str, str],
        candidate_selectors: list[dict[str, Any]] | None = None,
    ) -> list[LocatorCandidate]:
        candidates: list[LocatorCandidate] = []
        normalized_tag = (tag_name or "*").lower()
        short_text = self._short_text(text)

        if short_text:
            candidates.extend(self._combined_text_attribute_candidates(normalized_tag, short_text, attributes))

        for key in self._stable_attribute_keys(attributes):
            candidates.append(
                LocatorCandidate(
                    kind="data-attribute",
                    value=f'[{key}="{attributes[key]}"]',
                    score=self._attribute_score(key),
                    note="stable data attribute" if self._attribute_score(key) >= 0.8 else "broad data attribute",
                )
            )
        for key, score, note in [
            ("id", 0.93, "id-based selector"),
            ("name", 0.88, "form name selector"),
            ("aria-label", 0.86, "accessibility label selector"),
            ("placeholder", 0.82, "input placeholder selector"),
            ("title", 0.72, "title attribute selector"),
        ]:
            if attributes.get(key):
                candidates.append(
                    LocatorCandidate(
                        kind=key,
                        value=f'{normalized_tag}[{key}="{self._escape_attr_value(attributes[key])}"]',
                        score=score,
                        note=note,
                    )
                )
        if short_text:
            candidates.append(
                LocatorCandidate(
                    kind="tag-text",
                    value=f'{normalized_tag}:has-text("{short_text}")',
                    score=0.81,
                    note="tag with visible text",
                )
            )
            candidates.append(
                LocatorCandidate(
                    kind="text",
                    value=f'text="{short_text}"',
                    score=0.78,
                    note="text anchor candidate",
                )
            )

        for item in candidate_selectors or []:
            value = str(item.get("value") or "").strip()
            if not value:
                continue
            try:
                score = float(item.get("score", 0.5))
            except (TypeError, ValueError):
                score = 0.5
            candidates.append(
                LocatorCandidate(
                    kind=str(item.get("kind") or "picked"),
                    value=value,
                    score=max(0.0, min(score, 0.99)),
                    note=str(item.get("note") or "selector captured from DOM picker"),
                )
            )

        candidates.append(
            LocatorCandidate(
                kind="css",
                value=normalized_tag,
                score=0.2,
                note="generic fallback",
            )
        )
        return self._dedupe_candidates(candidates)

    def build_locator_spec(
        self,
        *,
        tag_name: str,
        text: str | None,
        attributes: dict[str, str],
        neighbors: dict[str, Any] | None = None,
        list_context: dict[str, Any] | None = None,
        frame_path: list[str] | None = None,
        candidate_selectors: list[dict[str, Any]] | None = None,
    ) -> LocatorSpec:
        candidates = self.generate_candidates(
            tag_name=tag_name,
            text=text,
            attributes=attributes,
            candidate_selectors=candidate_selectors,
        )
        primary = candidates[0].value
        fallbacks = [candidate.value for candidate in candidates[1:4]]
        stability = self._score_locator(
            primary,
            text=text,
            attributes=attributes,
            neighbors=neighbors,
            list_context=list_context,
        )
        return LocatorSpec(
            primary_selector=primary,
            fallback_selectors=fallbacks,
            frame_path=frame_path or [],
            tag_name=tag_name,
            text_signature=self._hash_text_signature(text),
            attribute_signature=attributes,
            neighbor_anchor_signature=neighbors or {},
            list_context_signature=list_context or {},
            stability_score=stability,
            candidates=candidates,
        )

    def validate_locator(self, locator: LocatorSpec) -> LocatorValidationResult:
        warnings: list[str] = []
        if locator.primary_selector.startswith("/html"):
            warnings.append("Avoid absolute XPath as a primary selector.")
        if locator.stability_score < 0.5:
            warnings.append("Locator stability is low. Consider adding data attributes or neighbor anchors.")
        uniqueness_score = 1.0 if locator.primary_selector not in locator.fallback_selectors else 0.2
        return LocatorValidationResult(
            valid=not warnings or "low" not in " ".join(warnings).lower(),
            uniqueness_score=uniqueness_score,
            stability_score=locator.stability_score,
            warnings=warnings,
            normalized_locator=locator,
        )

    @staticmethod
    def _hash_text_signature(text: str | None) -> dict[str, Any]:
        if not text:
            return {}
        normalized = " ".join(text.split())
        return {
            "normalized": normalized[:120],
            "sha1": hashlib.sha1(normalized.encode("utf-8")).hexdigest(),
            "length": len(normalized),
        }

    @staticmethod
    def _score_locator(
        primary_selector: str,
        *,
        text: str | None,
        attributes: dict[str, str],
        neighbors: dict[str, Any] | None = None,
        list_context: dict[str, Any] | None = None,
    ) -> float:
        score = 0.2
        if any(key.startswith("data-") for key in attributes):
            score += 0.45
        if attributes.get("id"):
            score += 0.25
        if attributes.get("name") or attributes.get("aria-label") or attributes.get("placeholder"):
            score += 0.18
        if text:
            score += min(len(text.strip()) / 80.0, 0.15)
        if neighbors:
            score += 0.08
        if list_context:
            score += 0.08
        if len(primary_selector) < 80:
            score += 0.1
        return round(min(score, 0.99), 2)

    @staticmethod
    def _short_text(text: str | None) -> str:
        if not text:
            return ""
        return " ".join(text.strip().replace('"', '\\"').split())[:60]

    @classmethod
    def _combined_text_attribute_candidates(
        cls,
        normalized_tag: str,
        short_text: str,
        attributes: dict[str, str],
    ) -> list[LocatorCandidate]:
        candidates: list[LocatorCandidate] = []
        data_et_name = attributes.get("data-et-name")
        data_et_content_type = attributes.get("data-et-prop-content_type")
        if data_et_name and data_et_content_type:
            candidates.append(
                LocatorCandidate(
                    kind="data-text-composite",
                    value=(
                        f'{normalized_tag}[data-et-name="{cls._escape_attr_value(data_et_name)}"]'
                        f'[data-et-prop-content_type="{cls._escape_attr_value(data_et_content_type)}"]'
                        f':has-text("{short_text}")'
                    ),
                    score=0.985,
                    note="business analytics attributes plus visible text",
                )
            )
        if data_et_name:
            candidates.append(
                LocatorCandidate(
                    kind="data-text-composite",
                    value=f'{normalized_tag}[data-et-name="{cls._escape_attr_value(data_et_name)}"]:has-text("{short_text}")',
                    score=0.975,
                    note="business analytics name plus visible text",
                )
            )
        if data_et_content_type:
            candidates.append(
                LocatorCandidate(
                    kind="data-text-composite",
                    value=(
                        f'{normalized_tag}[data-et-prop-content_type="{cls._escape_attr_value(data_et_content_type)}"]'
                        f':has-text("{short_text}")'
                    ),
                    score=0.94,
                    note="content type plus visible text",
                )
            )
        return candidates

    @staticmethod
    def _attribute_score(key: str) -> float:
        if key in {"data-testid", "data-test", "data-cy", "data-qa", "data-automation-id", "data-opctrl-id"}:
            return 0.96
        if key == "data-et-name":
            return 0.9
        if key in {"data-et-prop-content_type", "data-et-prop-location"}:
            return 0.82
        if key == "data-et-element-type":
            return 0.35
        if key.startswith("data-et-prop-listing_") or key in {
            "data-et-prop-lister_id",
            "data-et-prop-buyer_id",
            "data-et-prop-listing_price",
        }:
            return 0.42
        if key.startswith("data-"):
            return 0.72
        return 0.5

    @staticmethod
    def _stable_attribute_keys(attributes: dict[str, str]) -> list[str]:
        preferred = [
            "data-testid",
            "data-test",
            "data-cy",
            "data-qa",
            "data-automation-id",
            "data-opctrl-id",
        ]
        keys = [key for key in preferred if attributes.get(key)]
        keys.extend(
            sorted(
                (key for key in attributes if key.startswith("data-") and key not in keys),
                key=lambda key: (-LocatorService._attribute_score(key), key),
            )
        )
        return keys

    @staticmethod
    def _escape_attr_value(value: str) -> str:
        return str(value).replace("\\", "\\\\").replace('"', '\\"')

    @staticmethod
    def _dedupe_candidates(candidates: list[LocatorCandidate]) -> list[LocatorCandidate]:
        seen: set[str] = set()
        result: list[LocatorCandidate] = []
        for candidate in sorted(candidates, key=lambda item: item.score, reverse=True):
            if candidate.value in seen:
                continue
            seen.add(candidate.value)
            result.append(candidate)
        return result
