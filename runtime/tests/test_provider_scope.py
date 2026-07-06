from app.models import ProfileRecord
from app.schemas.provider import ProviderScope
from app.services.batch_service import BatchService
from app.services.provider_service import ProviderService


def make_profile(profile_id: str, group_id: str) -> ProfileRecord:
    return ProfileRecord(
        provider_type="ixbrowser",
        external_profile_id=profile_id,
        display_name=f"Profile {profile_id}",
        group_summary={"id": group_id, "name": f"Group {group_id}"},
    )


def test_provider_scope_defaults_to_all_profiles() -> None:
    profile = make_profile("101", "g1")
    scope = ProviderScope(provider_type="ixbrowser", is_configured=False)

    managed, reason = ProviderService.evaluate_profile_management(profile, scope)

    assert managed is True
    assert reason == "default_all_profiles"


def test_provider_scope_uses_group_whitelist_and_profile_exceptions() -> None:
    profile = make_profile("101", "g1")
    excluded = make_profile("102", "g1")
    included = make_profile("201", "g9")
    outside = make_profile("301", "g9")
    scope = ProviderScope(
        provider_type="ixbrowser",
        managed_group_ids=["g1"],
        include_profile_ids=["201"],
        exclude_profile_ids=["102"],
        is_configured=True,
    )

    assert ProviderService.evaluate_profile_management(profile, scope) == (True, "group_whitelist")
    assert ProviderService.evaluate_profile_management(excluded, scope) == (False, "profile_excluded")
    assert ProviderService.evaluate_profile_management(included, scope) == (True, "profile_included")
    assert ProviderService.evaluate_profile_management(outside, scope) == (False, "group_not_managed")


def test_batch_profile_policy_filters_after_provider_scope() -> None:
    profiles = [make_profile("101", "g1"), make_profile("201", "g2")]

    assert BatchService.apply_profile_policy(
        profiles,
        {"selection_mode": "all_profiles"},
    ) == profiles
    assert BatchService.apply_profile_policy(
        profiles,
        {"selection_mode": "explicit_profiles", "profile_ids": []},
    ) == []
    assert BatchService.apply_profile_policy(
        profiles,
        {"selection_mode": "by_group", "group_ids": ["g2"]},
    ) == [profiles[1]]
    assert BatchService.apply_profile_policy(
        profiles,
        {"selection_mode": "explicit_profiles", "profile_ids": ["101"]},
    ) == [profiles[0]]
