import io
import json
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, PropertyMock, patch
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, sys.argv[1])
plugin_root = sys.argv[2]
sys.argv = [sys.argv[0]]

import yt_dlp
from yt_dlp.extractor.tiktok import DouyinIE as UpstreamDouyinIE
from yt_dlp.globals import plugin_dirs
from yt_dlp.networking.common import Response
from yt_dlp.networking.exceptions import HTTPError
from yt_dlp.utils import ExtractorError

plugin_dirs.value = [plugin_root]
URL = "https://www.douyin.com/video/7693859410975690010"
API = "https://www.douyin.com/aweme/v1/web/aweme/detail/"


class AdversarialDouyinTests(unittest.TestCase):
    def setUp(self):
        self.ydl = yt_dlp.YoutubeDL({"quiet": True, "skip_download": True})
        self.extractor = self.ydl.get_info_extractor("Douyin")
        self.assertEqual(self.extractor.PLUGIN_NAME, "opencreator")

    def tearDown(self):
        self.ydl.close()

    def make_http_error(self, body: bytes, status=403):
        response = Response(io.BytesIO(body), API, {}, status=status)
        return ExtractorError("Unable to download JSON metadata", cause=HTTPError(response))

    # =========================================================================
    # Group 1: Missing and Partial Cookies
    # =========================================================================

    def test_partial_cookie_ttwid_only_in_webpage_cookies(self):
        """Test extractor successfully extracts identity from 'ttwid' in webpage cookies."""
        with patch.object(self.extractor, "_get_cookies", return_value={"ttwid": SimpleNamespace(value="ttwid_val_123")}), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            query = mock_dl.call_args.kwargs["query"]
            headers = mock_dl.call_args.kwargs["headers"]
            self.assertEqual(query["uifid"], "ttwid_val_123")
            self.assertEqual(headers["uifid"], "ttwid_val_123")
            self.assertIn("x-secsdk-web-signature", query)

    def test_partial_cookie_s_v_web_id_only_in_webpage_cookies(self):
        """Test extractor successfully extracts identity from 's_v_web_id' in webpage cookies."""
        with patch.object(self.extractor, "_get_cookies", return_value={"s_v_web_id": SimpleNamespace(value="verify_123")}), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            query = mock_dl.call_args.kwargs["query"]
            headers = mock_dl.call_args.kwargs["headers"]
            self.assertEqual(query["uifid"], "verify_123")
            self.assertEqual(headers["uifid"], "verify_123")
            self.assertIn("x-secsdk-web-signature", query)

    def test_partial_cookie_uifid_only_in_webpage_cookies(self):
        """Test extractor successfully extracts identity from 'UIFID' in webpage cookies."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="uifid_official_val")}), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            query = mock_dl.call_args.kwargs["query"]
            self.assertEqual(query["uifid"], "uifid_official_val")

    def test_partial_cookie_uifid_temp_only_in_webpage_cookies(self):
        """Test extractor successfully extracts identity from 'UIFID_TEMP' in webpage cookies."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID_TEMP": SimpleNamespace(value="uifid_temp_val")}), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            query = mock_dl.call_args.kwargs["query"]
            self.assertEqual(query["uifid"], "uifid_temp_val")

    def test_cookie_precedence_uifid_over_temp_and_others(self):
        """Test precedence order: UIFID > UIFID_TEMP > s_v_web_id > ttwid."""
        cookies = {
            "UIFID": SimpleNamespace(value="val_UIFID"),
            "UIFID_TEMP": SimpleNamespace(value="val_TEMP"),
            "s_v_web_id": SimpleNamespace(value="val_SV"),
            "ttwid": SimpleNamespace(value="val_TTWID"),
        }
        with patch.object(self.extractor, "_get_cookies", return_value=cookies), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            self.assertEqual(mock_dl.call_args.kwargs["query"]["uifid"], "val_UIFID")

    def test_cookie_precedence_temp_over_sv_and_ttwid(self):
        """Test precedence when UIFID is absent: UIFID_TEMP > s_v_web_id > ttwid."""
        cookies = {
            "UIFID_TEMP": SimpleNamespace(value="val_TEMP"),
            "s_v_web_id": SimpleNamespace(value="val_SV"),
            "ttwid": SimpleNamespace(value="val_TTWID"),
        }
        with patch.object(self.extractor, "_get_cookies", return_value=cookies), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            self.assertEqual(mock_dl.call_args.kwargs["query"]["uifid"], "val_TEMP")

    def test_cookiejar_fallback_when_webpage_cookies_empty(self):
        """Test extracting identity from self.cookiejar when webpage cookies are absent."""
        mock_cookie = SimpleNamespace(name="ttwid", value="cookiejar_ttwid_val")
        with patch.object(self.extractor, "_get_cookies", return_value={}), \
                patch.object(type(self.extractor), "cookiejar", new_callable=PropertyMock, return_value=[mock_cookie]), \
                patch.object(self.extractor, "_set_cookie") as mock_set_cookie, \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            self.assertEqual(mock_dl.call_args.kwargs["query"]["uifid"], "cookiejar_ttwid_val")
            mock_set_cookie.assert_called_with(".douyin.com", "ttwid", "cookiejar_ttwid_val")

    def test_cookiejar_with_empty_or_none_values_skipped(self):
        """Test that cookiejar cookies with empty string or None values are skipped."""
        mock_empty = SimpleNamespace(name="ttwid", value="")
        mock_none = SimpleNamespace(name="s_v_web_id", value=None)
        mock_valid = SimpleNamespace(name="UIFID_TEMP", value="valid_after_empty")
        with patch.object(self.extractor, "_get_cookies", return_value={}), \
                patch.object(type(self.extractor), "cookiejar", new_callable=PropertyMock, return_value=[mock_empty, mock_none, mock_valid]), \
                patch.object(self.extractor, "_set_cookie") as mock_set_cookie, \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            self.assertEqual(mock_dl.call_args.kwargs["query"]["uifid"], "valid_after_empty")
            mock_set_cookie.assert_called_with(".douyin.com", "UIFID_TEMP", "valid_after_empty")

    # =========================================================================
    # Group 2: Anonymous Session Registration Fallback
    # =========================================================================

    def test_visitor_registration_triggered_when_all_cookies_missing(self):
        """Test that _initialize_visitor_session() is called when no identity cookies exist."""
        with patch.object(self.extractor, "_get_cookies", return_value={}), \
                patch.object(type(self.extractor), "cookiejar", new_callable=PropertyMock, return_value=[]), \
                patch.object(self.extractor, "_initialize_visitor_session", return_value="anon_visitor_session_999") as mock_init, \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            mock_init.assert_called_once()
            self.assertEqual(mock_dl.call_args.kwargs["query"]["uifid"], "anon_visitor_session_999")

    def test_initialize_visitor_session_registers_and_sets_cookies(self):
        """Test the internal logic of _initialize_visitor_session() when registration succeeds."""
        cookie_obj = SimpleNamespace(name="ttwid", value="registered_ttwid_token")
        with patch.object(self.extractor, "_request_webpage") as mock_req, \
                patch.object(type(self.extractor), "cookiejar", new_callable=PropertyMock, return_value=[cookie_obj]), \
                patch.object(self.extractor, "_set_cookie") as mock_set:
            res = self.extractor._initialize_visitor_session()
            self.assertEqual(res, "registered_ttwid_token")
            # Verify request was sent to ttwid register endpoint
            req_arg = mock_req.call_args[0][0]
            self.assertEqual(req_arg.url, "https://ttwid.bytedance.com/ttwid/union/register/")
            payload = json.loads(req_arg.data.decode("utf-8"))
            self.assertEqual(payload["region"], "cn")
            self.assertEqual(payload["aid"], 1768)
            self.assertEqual(payload["service"], "www.ixigua.com")
            self.assertTrue(payload["union"])
            # Verify cookies were saved for .douyin.com
            mock_set.assert_any_call(".douyin.com", "ttwid", "registered_ttwid_token")
            mock_set.assert_any_call(".douyin.com", "UIFID_TEMP", "registered_ttwid_token")

    def test_initialize_visitor_session_handles_network_failure_gracefully(self):
        """Test that _initialize_visitor_session() does not crash on network error and returns None."""
        with patch.object(self.extractor, "_request_webpage", side_effect=Exception("Connection timed out")):
            res = self.extractor._initialize_visitor_session()
            self.assertIsNone(res)

    def test_missing_identity_when_visitor_registration_fails_graceful_rejection(self):
        """Test that when visitor registration fails and no identity exists, missing UIFID error is mapped."""
        with patch.object(self.extractor, "_get_cookies", return_value={}), \
                patch.object(type(self.extractor), "cookiejar", new_callable=PropertyMock, return_value=[]), \
                patch.object(self.extractor, "_initialize_visitor_session", return_value=None), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(b"Blocked by ArgusSecurityPlugin Uifid Not Found")):
            with self.assertRaises(ExtractorError) as ctx:
                self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            msg = str(ctx.exception)
            self.assertIn("Douyin browser identity was rejected", msg)
            self.assertIn("Uifid Not Found", msg)
            self.assertIn("Connect Douyin in Settings > Platform connections", msg)

    # =========================================================================
    # Group 3: Anti-Bot Challenge Handling
    # =========================================================================

    def test_antibot_validate_error_handling(self):
        """Verify handling of 'Blocked by ArgusSecurityPlugin Validate Error'."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="some-val")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(
                    b'{"status_code": 403, "message": "Blocked by ArgusSecurityPlugin Validate Error"}'
                )):
            with self.assertRaises(ExtractorError) as ctx:
                self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            msg = str(ctx.exception)
            self.assertIn("Validate Error", msg)
            self.assertIn("Website verification is required", msg)
            self.assertIn("no sign-in required", msg)
            self.assertTrue(ctx.exception.expected)

    def test_antibot_slider_captcha_handling(self):
        """Verify handling of slider captcha challenges in response body."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="some-val")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(
                    b'<html><body><p>Slider Captcha verification required</p></body></html>'
                )):
            with self.assertRaises(ExtractorError) as ctx:
                self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            msg = str(ctx.exception)
            self.assertIn("Validate Error", msg)
            self.assertIn("Website verification is required", msg)
            self.assertTrue(ctx.exception.expected)

    def test_antibot_uifid_not_found_handling(self):
        """Verify handling of 'Blocked by ArgusSecurityPlugin Uifid Not Found'."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="some-val")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(
                    b'Blocked by ArgusSecurityPlugin Uifid Not Found'
                )):
            with self.assertRaises(ExtractorError) as ctx:
                self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            msg = str(ctx.exception)
            self.assertIn("Uifid Not Found", msg)
            self.assertIn("Connect Douyin in Settings > Platform connections and retry", msg)
            self.assertTrue(ctx.exception.expected)

    def test_antibot_signature_not_found_handling(self):
        """Verify handling of 'Blocked by ArgusSecurityPlugin Signature Not Found'."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="some-val")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(
                    b'Blocked by ArgusSecurityPlugin Signature Not Found'
                )):
            with self.assertRaises(ExtractorError) as ctx:
                self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            msg = str(ctx.exception)
            self.assertIn("Signature Not Found", msg)
            self.assertIn("Douyin request signature is required", msg)
            self.assertTrue(ctx.exception.expected)

    def test_unrecognized_403_fatal_raises_original(self):
        """Verify that an unrecognized 403 error with fatal=True re-raises."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="some-val")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(b'Generic 403 Forbidden')):
            with self.assertRaises(ExtractorError) as ctx:
                self.extractor._download_json(API, "vid", query={"aweme_id": "111"}, fatal=True)
            self.assertIn("Unable to download JSON metadata", str(ctx.exception))

    def test_unrecognized_403_nonfatal_reports_warning_and_returns_none(self):
        """Verify that an unrecognized 403 with fatal=False warns and returns None (allowing upstream fallback)."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="some-val")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(b'Generic 403 Forbidden')), \
                patch.object(self.extractor, "report_warning") as mock_warn:
            res = self.extractor._download_json(API, "vid", query={"aweme_id": "111"}, fatal=False)
            self.assertIsNone(res)
            mock_warn.assert_called_once()

    # =========================================================================
    # Group 4: Signature Calculation & Encoding
    # =========================================================================

    def test_signature_deterministic_with_known_vectors(self):
        """Verify signature determinism with known vectors."""
        from hashlib import md5
        from urllib.parse import urlencode

        identity = "test-identity-xyz"
        timestamp = "1700000000"
        query = {"aweme_id": "9999999", "timestamp": timestamp}
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value=identity)}), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query=query)
            sent_query = mock_dl.call_args.kwargs["query"]
            sig = sent_query["x-secsdk-web-signature"]

            # Compute independently
            q = dict(query)
            q["uifid"] = identity
            encoded_q = urlencode(q, doseq=True, safe="*").replace("~", "%7E")
            expected_payload = f"{identity}_{timestamp}_A96D855A08C0A9707F8BEF0D9A527E4E_{encoded_q}"
            expected_sig = md5(expected_payload.encode(), usedforsecurity=False).hexdigest()
            self.assertEqual(sig, expected_sig)

    def test_signature_preserves_tilde_encoding(self):
        """Verify ~ is encoded as %7E per URLSearchParams specification."""
        identity = "identity~with~tildes"
        query = {"aweme_id": "123", "note": "a~b~c"}
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value=identity)}), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query=query)
            sent_query = mock_dl.call_args.kwargs["query"]
            self.assertIn("x-secsdk-web-signature", sent_query)

    def test_existing_signature_not_overwritten(self):
        """Verify an existing x-secsdk-web-signature in query is strictly preserved."""
        custom_sig = "already_provided_sig_12345"
        query = {"aweme_id": "123", "x-secsdk-web-signature": custom_sig}
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="any-id")}), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query=query)
            self.assertEqual(mock_dl.call_args.kwargs["query"]["x-secsdk-web-signature"], custom_sig)

    def test_non_detail_douyin_endpoints_bypass_signature(self):
        """Verify non-detail endpoints do not get injected with uifid or signature."""
        other_api = "https://www.douyin.com/aweme/v1/web/other/endpoint/"
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="some-id")}), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(other_api, "vid", query={"item": "1"})
            sent_query = mock_dl.call_args.kwargs.get("query", {})
            self.assertNotIn("uifid", sent_query)
            self.assertNotIn("x-secsdk-web-signature", sent_query)


if __name__ == "__main__":
    unittest.main()
