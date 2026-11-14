package com.silarsis.aiembodied.room

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProxyMappingTest {
    private fun decide(url: String, method: String = "GET") = ProxyMapping.decide(url, method, "bija", 8791)

    private fun forward(url: String): ProxyMapping.Decision.Forward {
        val decision = decide(url)
        assertTrue("expected a forward for $url", decision is ProxyMapping.Decision.Forward)
        return decision as ProxyMapping.Decision.Forward
    }

    @Test
    fun theStartPageIsForwardedAndGetsTheShellScript() {
        val page = forward("https://appassets.androidplatform.net/app/")
        assertEquals("http://bija:8791/app/", page.url)
        assertTrue(page.injectShell)
        assertFalse(page.withToken)
        assertEquals("http://bija:8791/app/", forward("https://appassets.androidplatform.net/app").url)
        assertEquals("http://bija:8791/app/?x=1", forward("https://appassets.androidplatform.net/app/?x=1").url)
    }

    @Test
    fun appFilesAreForwardedWithoutAToken() {
        val file = forward("https://appassets.androidplatform.net/app/assets/index-abc.js")
        assertEquals("http://bija:8791/app/assets/index-abc.js", file.url)
        assertFalse(file.injectShell)
        assertFalse(file.withToken)
    }

    @Test
    fun assetRequestsGetTheTokenAndKeepTheirQuery() {
        val asset = forward("https://appassets.androidplatform.net/v1/asset?url=aiembodied-asset%3A%2F%2Fa%2Fb.vrm")
        assertEquals("http://bija:8791/v1/asset?url=aiembodied-asset%3A%2F%2Fa%2Fb.vrm", asset.url)
        assertTrue(asset.withToken)
    }

    @Test
    fun theShellScriptIsMadeLocally() {
        assertTrue(decide("https://appassets.androidplatform.net/__aiembodied_shell.js") is ProxyMapping.Decision.ShellScript)
    }

    @Test
    fun otherPathsOnTheOriginAreRefused() {
        for (path in listOf("/v1/pair", "/v1/link", "/", "/application", "/v1/asset/x", "/etc/passwd")) {
            assertTrue(path, decide("https://appassets.androidplatform.net$path") is ProxyMapping.Decision.Block)
        }
    }

    @Test
    fun onlyGetIsForwarded() {
        assertTrue(decide("https://appassets.androidplatform.net/app/", "POST") is ProxyMapping.Decision.Block)
        assertTrue(decide("https://appassets.androidplatform.net/v1/asset?url=x", "PUT") is ProxyMapping.Decision.Block)
        assertTrue(decide("https://appassets.androidplatform.net/app/", "get") is ProxyMapping.Decision.Forward)
    }

    @Test
    fun pathTricksAreRefused() {
        for (path in listOf("/app/../v1/pair", "/app/%2e%2e/x", "/app/..%2fx", "/app//x", "/app/a%5cb", "/app/a\\b")) {
            assertTrue(path, decide("https://appassets.androidplatform.net$path") is ProxyMapping.Decision.Block)
        }
    }

    @Test
    fun otherHostsAreRefusedAndOtherSchemesLeftAlone() {
        assertTrue(decide("https://evil.example/app/") is ProxyMapping.Decision.Block)
        assertTrue(decide("http://appassets.androidplatform.net/app/") is ProxyMapping.Decision.Block)
        assertTrue(decide("https://appassets.androidplatform.net.evil.example/app/") is ProxyMapping.Decision.Block)
        assertTrue(decide("https://user@appassets.androidplatform.net/app/") is ProxyMapping.Decision.Block)
        assertTrue(decide("https://appassets.androidplatform.net:8443/app/") is ProxyMapping.Decision.Block)
        assertTrue(decide("data:text/html;base64,AAAA") is ProxyMapping.Decision.Pass)
        assertTrue(decide("blob:https://appassets.androidplatform.net/1234") is ProxyMapping.Decision.Pass)
        assertTrue(decide("not a url at all") is ProxyMapping.Decision.Block)
    }

    @Test
    fun theOriginCheckIsExact() {
        assertTrue(ProxyMapping.isAppOrigin("https://appassets.androidplatform.net"))
        assertTrue(ProxyMapping.isAppOrigin("https://appassets.androidplatform.net/"))
        assertTrue(ProxyMapping.isAppOrigin("https://APPASSETS.androidplatform.net:443"))
        assertFalse(ProxyMapping.isAppOrigin(null))
        assertFalse(ProxyMapping.isAppOrigin(""))
        assertFalse(ProxyMapping.isAppOrigin("http://appassets.androidplatform.net"))
        assertFalse(ProxyMapping.isAppOrigin("https://appassets.androidplatform.net.evil.example"))
        assertFalse(ProxyMapping.isAppOrigin("https://bija:8791"))
    }

    @Test
    fun contentTypeIsSplit() {
        assertEquals(Pair("text/html", "utf-8"), ProxyMapping.splitContentType("text/html; charset=utf-8"))
        assertEquals(Pair("application/wasm", null), ProxyMapping.splitContentType("application/wasm"))
        assertEquals(Pair("text/css", "utf-8"), ProxyMapping.splitContentType("text/css;charset=\"utf-8\""))
        assertEquals(Pair("application/octet-stream", null), ProxyMapping.splitContentType(null))
    }

    @Test
    fun theShellScriptIsPutFirstInHead() {
        val html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>x</title></head><body></body></html>"
        val out = ProxyMapping.injectShellScript(html)
        assertTrue(out.contains("<head><script src=\"/__aiembodied_shell.js\"></script><meta charset"))
        assertEquals(1, Regex("__aiembodied_shell").findAll(out).count())
        assertTrue(ProxyMapping.injectShellScript("<HEAD lang=\"en\">x").startsWith("<HEAD lang=\"en\"><script"))
        assertTrue(ProxyMapping.injectShellScript("<p>no head</p>").startsWith("<script src="))
    }

    @Test
    fun theShellScriptSetsTheHookTheWebSatelliteReads() {
        val script = ProxyMapping.SHELL_SCRIPT
        for (needle in listOf("__AIEMBODIED_SHELL__", "hubUrl", "deviceId", "token", "deviceName", "kind: 'phone'", "foreground:", "onForeground:", "onGate:", "foregroundChanged", "AiembodiedShell")) {
            assertTrue(needle, script.contains(needle))
        }
        // Unknown means "not foreground".
        assertTrue(script.contains("=== true"))
    }

    @Test
    fun reasonPhrasesAreNeverEmpty() {
        for (status in listOf(200, 206, 401, 404, 418, 500, 502)) {
            assertFalse(ProxyMapping.reasonPhrase(status).isEmpty())
        }
    }
}
