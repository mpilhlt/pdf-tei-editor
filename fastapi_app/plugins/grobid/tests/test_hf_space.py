"""Tests for the Hugging Face Space preflight check."""

from unittest.mock import MagicMock, patch

import pytest
import requests

from fastapi_app.plugins.grobid import hf_space
from fastapi_app.plugins.grobid.hf_space import check_space_running

URL = "https://acme-grobid-server.hf.space"


def _response(status: int = 200, body: dict | None = None) -> MagicMock:
    response = MagicMock()
    response.status_code = status
    response.json.return_value = body or {}
    return response


def _runtime(stage: str, domain: str = "acme-grobid-server.hf.space") -> dict:
    return {"stage": stage, "domains": [{"domain": domain, "stage": "READY"}]}


@pytest.fixture(autouse=True)
def clear_cache():
    hf_space._resolved_spaces.clear()
    yield
    hf_space._resolved_spaces.clear()


def test_non_hf_url_makes_no_request():
    with patch.object(hf_space.requests, "get") as get:
        assert check_space_running("http://localhost:8070", 5) is None
    get.assert_not_called()


def test_running_space_passes():
    with patch.object(hf_space.requests, "get", return_value=_response(200, _runtime("RUNNING"))):
        assert check_space_running(URL, 5, "acme/grobid-server") is None


@pytest.mark.parametrize("stage", ["SLEEPING", "PAUSED", "STOPPED"])
def test_stopped_space_returns_start_message_with_link(stage):
    with patch.object(hf_space.requests, "get", return_value=_response(200, _runtime(stage))):
        message = check_space_running(URL, 5, "acme/grobid-server")
    assert message is not None
    assert stage.lower() in message
    assert "https://huggingface.co/spaces/acme/grobid-server" in message


def test_building_space_returns_not_ready_message():
    with patch.object(hf_space.requests, "get", return_value=_response(200, _runtime("BUILDING"))):
        message = check_space_running(URL, 5, "acme/grobid-server")
    assert message is not None
    assert "BUILDING" in message


def test_inaccessible_space_skips_check():
    with patch.object(hf_space.requests, "get", return_value=_response(401)):
        assert check_space_running(URL, 5, "acme/grobid-server") is None


def test_network_error_skips_check():
    with patch.object(hf_space.requests, "get", side_effect=requests.ConnectionError("down")):
        assert check_space_running(URL, 5, "acme/grobid-server") is None


def test_hyphen_split_resolution_finds_space_and_caches_it():
    def fake_get(url, **kwargs):
        if url.endswith("/acme/grobid-server/runtime"):
            return _response(200, _runtime("SLEEPING"))
        return _response(404)

    with patch.object(hf_space.requests, "get", side_effect=fake_get) as get:
        message = check_space_running(URL, 5)
        assert message is not None and "spaces/acme/grobid-server" in message
        first_call_count = get.call_count
        check_space_running(URL, 5)
    # cached: the second check needs a single request
    assert get.call_count == first_call_count + 1


def test_hyphen_split_rejects_space_serving_other_domain():
    with patch.object(hf_space.requests, "get", return_value=_response(200, _runtime("SLEEPING", "other.hf.space"))):
        assert check_space_running(URL, 5) is None


def test_unresolvable_space_skips_check():
    with patch.object(hf_space.requests, "get", return_value=_response(404)):
        assert check_space_running(URL, 5) is None
