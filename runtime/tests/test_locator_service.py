from app.services.locator_service import LocatorService


def test_locator_prefers_data_attribute() -> None:
    service = LocatorService()
    locator = service.build_locator_spec(
        tag_name="button",
        text="提交审核",
        attributes={"data-testid": "submit-review", "class": "btn primary"},
    )
    assert locator.primary_selector == '[data-testid="submit-review"]'
    assert locator.stability_score >= 0.6


def test_locator_keeps_auto_picked_fallbacks() -> None:
    service = LocatorService()
    locator = service.build_locator_spec(
        tag_name="button",
        text="Women",
        attributes={"aria-label": "Women"},
        candidate_selectors=[
            {
                "kind": "css-path",
                "value": "nav:nth-of-type(1) > button:nth-of-type(2)",
                "score": 0.58,
                "note": "structural fallback",
            }
        ],
    )

    all_selectors = [locator.primary_selector, *locator.fallback_selectors]

    assert locator.primary_selector == 'button[aria-label="Women"]'
    assert 'button:has-text("Women")' in all_selectors
    assert "nav:nth-of-type(1) > button:nth-of-type(2)" in all_selectors


def test_locator_deprioritizes_generic_analytics_button_attribute() -> None:
    service = LocatorService()
    locator = service.build_locator_spec(
        tag_name="a",
        text="View Closet",
        attributes={
            "data-et-name": "seller",
            "data-et-element-type": "button",
            "data-et-prop-content_type": "closet",
            "data-et-prop-listing_id": "dynamic-listing-id",
            "data-et-prop-lister_id": "dynamic-seller-id",
        },
    )

    assert locator.primary_selector == (
        'a[data-et-name="seller"][data-et-prop-content_type="closet"]:has-text("View Closet")'
    )
    assert locator.primary_selector != '[data-et-element-type="button"]'
    assert '[data-et-element-type="button"]' not in locator.fallback_selectors[:2]


def test_locator_combines_follow_button_business_name_with_text() -> None:
    service = LocatorService()
    locator = service.build_locator_spec(
        tag_name="button",
        text="Follow",
        attributes={
            "data-et-name": "follow_user",
            "data-et-element-type": "button",
        },
    )

    assert locator.primary_selector == 'button[data-et-name="follow_user"]:has-text("Follow")'
