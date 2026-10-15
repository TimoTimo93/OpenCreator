import io
import json
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, PropertyMock, patch

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
API = "https://www.douyin.com/aweme/v1/web/aweme/detail/"
URL = "https://www.douyin.com/video/7693859410975690010"


class DouyinEdgeCasesAdversarialTest(unittest.TestCase):
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
    # Group 1: Empty & Degraded Cookies
    # =========================================================================

    def test_empty_string_cookie_values(self):
        """When cookies exist but values are empty strings, fallback to visitor session."""
        cookies = {
            "UIFID": SimpleNamespace(value=""),
            "UIFID_TEMP": SimpleNamespace(value=""),
            "s_v_web_id": SimpleNamespace(value=""),
            "ttwid": SimpleNamespace(value=""),
        }
        with patch.object(self.extractor, "_get_cookies", return_value=cookies), \
                patch.object(self.extractor, "_initialize_visitor_session", return_value="visitor_session_fallback") as mock_init, \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            mock_init.assert_called_once()
            self.assertEqual(mock_dl.call_args.kwargs["query"]["uifid"], "visitor_session_fallback")

    def test_none_cookie_values(self):
        """When cookies dictionary contains None values instead of objects with .value."""
        cookies = {
            "UIFID": None,
            "UIFID_TEMP": None,
            "s_v_web_id": None,
            "ttwid": None,
        }
        with patch.object(self.extractor, "_get_cookies", return_value=cookies), \
                patch.object(self.extractor, "_initialize_visitor_session", return_value="recovered_session") as mock_init, \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            mock_init.assert_called_once()
            self.assertEqual(mock_dl.call_args.kwargs["query"]["uifid"], "recovered_session")

    def test_cookiejar_with_real_http_cookies(self):
        """When cookiejar contains standard http.cookiejar.Cookie objects with unrelated domains."""
        import http.cookiejar
        cj = http.cookiejar.CookieJar()
        c1 = http.cookiejar.Cookie(0, "other_cookie", "123", None, False, ".example.com", True, True, "/", False, False, 0, False, None, None, {})
        c2 = http.cookiejar.Cookie(0, "ttwid", "cookiejar_real_token", None, False, ".bytedance.com", True, True, "/", False, False, 0, False, None, None, {})
        cj.set_cookie(c1)
        cj.set_cookie(c2)

        with patch.object(self.extractor, "_get_cookies", return_value={}), \
                patch.object(type(self.extractor), "cookiejar", new_callable=PropertyMock, return_value=cj), \
                patch.object(self.extractor, "_set_cookie") as mock_set, \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            self.assertEqual(mock_dl.call_args.kwargs["query"]["uifid"], "cookiejar_real_token")
            mock_set.assert_called_with(".douyin.com", "ttwid", "cookiejar_real_token")

    # =========================================================================
    # Group 2: Missing Session / Initialization Failures
    # =========================================================================

    def test_visitor_session_init_catches_all_exceptions(self):
        """_initialize_visitor_session must never raise even under violent failures."""
        with patch.object(self.extractor, "_request_webpage", side_effect=RuntimeError("Violent runtime failure")):
            res = self.extractor._initialize_visitor_session()
            self.assertIsNone(res)

    def test_visitor_session_init_empty_cookiejar_returns_none(self):
        """When registration request succeeds but response does not populate ttwid in cookiejar."""
        with patch.object(self.extractor, "_request_webpage"), \
                patch.object(type(self.extractor), "cookiejar", new_callable=PropertyMock, return_value=[]):
            res = self.extractor._initialize_visitor_session()
            self.assertIsNone(res)

    def test_no_identity_and_init_returns_none_proceeds_without_signature(self):
        """When no identity is available and visitor init returns None, upstream download is still attempted."""
        with patch.object(self.extractor, "_get_cookies", return_value={}), \
                patch.object(type(self.extractor), "cookiejar", new_callable=PropertyMock, return_value=[]), \
                patch.object(self.extractor, "_initialize_visitor_session", return_value=None), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={"aweme_detail": {}}) as mock_dl:
            res = self.extractor._download_json(API, "vid", query={"aweme_id": "111"})
            self.assertEqual(res, {"aweme_detail": {}})
            self.assertNotIn("uifid", mock_dl.call_args.kwargs["headers"])
            self.assertNotIn("uifid", mock_dl.call_args.kwargs["query"])
            self.assertNotIn("x-secsdk-web-signature", mock_dl.call_args.kwargs["query"])

    # =========================================================================
    # Group 3: Malformed Responses & HTTP Status Varieties
    # =========================================================================

    def test_403_empty_body(self):
        """When 403 response body is empty (0 bytes), it should re-raise cleanly when fatal=True."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="valid")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(b"")):
            with self.assertRaises(ExtractorError) as ctx:
                self.extractor._download_json(API, "vid", query={"aweme_id": "111"}, fatal=True)
            self.assertIn("Unable to download JSON metadata", str(ctx.exception))

    def test_403_empty_body_nonfatal(self):
        """When 403 response body is empty and fatal=False, it should warn and return None."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="valid")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(b"")), \
                patch.object(self.extractor, "report_warning") as mock_warn:
            res = self.extractor._download_json(API, "vid", query={"aweme_id": "111"}, fatal=False)
            self.assertIsNone(res)
            mock_warn.assert_called_once()

    def test_403_garbage_binary_body(self):
        """When 403 response contains arbitrary binary data (e.g. gzip stream, null bytes, random noise)."""
        garbage = bytes(range(256)) * 2
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="valid")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(garbage)):
            with self.assertRaises(ExtractorError) as ctx:
                self.extractor._download_json(API, "vid", query={"aweme_id": "111"}, fatal=True)
            self.assertIn("Unable to download JSON metadata", str(ctx.exception))

    def test_403_mixed_case_captcha_in_html(self):
        """When 403 response contains 'cApTcHAGateway' with arbitrary casing."""
        body = b"<html><head><title>cApTcHAGateway</title></head><body>Verify here</body></html>"
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="valid")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(body)):
            with self.assertRaises(ExtractorError) as ctx:
                self.extractor._download_json(API, "vid", query={"aweme_id": "111"}, fatal=True)
            msg = str(ctx.exception)
            self.assertIn("Website verification is required", msg)
            self.assertTrue(ctx.exception.expected)

    def test_500_internal_server_error(self):
        """500 Internal Server Error should not trigger 403 Argus mapping and should re-raise."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="valid")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(b"Internal Error", status=500)):
            with self.assertRaises(ExtractorError) as ctx:
                self.extractor._download_json(API, "vid", query={"aweme_id": "111"}, fatal=True)
            self.assertIn("Unable to download JSON metadata", str(ctx.exception))

    def test_502_bad_gateway_nonfatal(self):
        """502 Bad Gateway with fatal=False should report warning and return None."""
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="valid")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=self.make_http_error(b"Bad Gateway", status=502)), \
                patch.object(self.extractor, "report_warning") as mock_warn:
            res = self.extractor._download_json(API, "vid", query={"aweme_id": "111"}, fatal=False)
            self.assertIsNone(res)
            mock_warn.assert_called_once()

    def test_non_http_extractor_error(self):
        """ExtractorError without HTTPError cause (e.g. JSON decode error)."""
        generic_err = ExtractorError("Failed to parse JSON")
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="valid")}), \
                patch.object(UpstreamDouyinIE, "_download_json", side_effect=generic_err):
            with self.assertRaises(ExtractorError) as ctx:
                self.extractor._download_json(API, "vid", query={"aweme_id": "111"}, fatal=True)
            self.assertIn("Failed to parse JSON", str(ctx.exception))

    # =========================================================================
    # Group 4: Query Parameters & Signature Edge Cases
    # =========================================================================

    def test_unicode_and_special_characters_in_query(self):
        """Ensure signature computation handles unicode characters without encoding errors."""
        query = {"aweme_id": "123", "title": "视频标题 🚀 & 特殊字符 = ? #"}
        with patch.object(self.extractor, "_get_cookies", return_value={"UIFID": SimpleNamespace(value="unicode_user_💎")}), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query=query)
            sent_query = mock_dl.call_args.kwargs["query"]
            self.assertIn("x-secsdk-web-signature", sent_query)
            self.assertEqual(len(sent_query["x-secsdk-web-signature"]), 32)

    def test_existing_uifid_in_query_takes_precedence(self):
        """If query already explicitly contains 'uifid', it takes precedence over cookies."""
        query = {"aweme_id": "123", "uifid": "query_specified_id"}
        cookies = {"UIFID": SimpleNamespace(value="cookie_specified_id")}
        with patch.object(self.extractor, "_get_cookies", return_value=cookies), \
                patch.object(UpstreamDouyinIE, "_download_json", return_value={}) as mock_dl:
            self.extractor._download_json(API, "vid", query=query)
            sent_query = mock_dl.call_args.kwargs["query"]
            self.assertEqual(sent_query["uifid"], "query_specified_id")
            self.assertEqual(mock_dl.call_args.kwargs["headers"]["uifid"], "query_specified_id")


if __name__ == "__main__":
    unittest.main()
