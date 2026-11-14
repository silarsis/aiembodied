package com.silarsis.aiembodied.room

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Answers the WebView's requests to https://appassets.androidplatform.net by fetching them from bija's hub over
 * plain http (see ProxyMapping for which paths). Called on a WebView background thread, so it may block.
 */
class HubProxy {
    @Volatile
    var pairing: Pairing? = null

    /** Null means "let the WebView handle it" (data: and blob: URLs). */
    fun handle(request: WebResourceRequest): WebResourceResponse? {
        val current = pairing
        val decision = if (current == null) {
            ProxyMapping.Decision.Block
        } else {
            ProxyMapping.decide(request.url.toString(), request.method ?: "GET", current.host, current.port)
        }
        return when (decision) {
            is ProxyMapping.Decision.Pass -> null
            is ProxyMapping.Decision.Block -> text(403, "Blocked")
            is ProxyMapping.Decision.ShellScript -> shellScript()
            is ProxyMapping.Decision.Forward -> forward(decision, request, current)
        }
    }

    private fun text(status: Int, message: String): WebResourceResponse {
        val headers = HashMap<String, String>()
        headers["Cache-Control"] = "no-store"
        return WebResourceResponse(
            "text/plain", "utf-8", status, ProxyMapping.reasonPhrase(status), headers,
            ByteArrayInputStream(message.toByteArray(Charsets.UTF_8)),
        )
    }

    private fun shellScript(): WebResourceResponse {
        val headers = HashMap<String, String>()
        headers["Cache-Control"] = "no-store"
        return WebResourceResponse(
            "application/javascript", "utf-8", 200, "OK", headers,
            ByteArrayInputStream(ProxyMapping.SHELL_SCRIPT.toByteArray(Charsets.UTF_8)),
        )
    }

    private fun forward(decision: ProxyMapping.Decision.Forward, request: WebResourceRequest, current: Pairing?): WebResourceResponse {
        var connection: HttpURLConnection? = null
        try {
            val conn = URL(decision.url).openConnection() as HttpURLConnection
            connection = conn
            conn.instanceFollowRedirects = false
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.requestMethod = "GET"
            // Never compressed, so the body can be streamed and rewritten as it is.
            conn.setRequestProperty("Accept-Encoding", "identity")
            val sent = request.requestHeaders
            if (sent != null) {
                for (name in listOf("Accept", "Range")) {
                    val value = sent[name]
                    if (value != null) conn.setRequestProperty(name, value)
                }
            }
            if (decision.withToken && current != null) {
                conn.setRequestProperty("Authorization", "Bearer " + current.token)
            }
            val status = conn.responseCode
            if (status in 300..399) {
                conn.disconnect()
                return text(502, "bija redirected the request.")
            }
            val (mime, charset) = ProxyMapping.splitContentType(conn.contentType)
            val headers = HashMap<String, String>()
            for (name in ProxyMapping.PASS_HEADERS) {
                val value = conn.getHeaderField(name)
                if (value != null) headers[name] = value
            }
            val raw: InputStream? = if (status >= 400) conn.errorStream else conn.inputStream
            val body: InputStream = if (raw == null) {
                conn.disconnect()
                ByteArrayInputStream(ByteArray(0))
            } else if (decision.injectShell && status == 200) {
                val html = String(raw.readBytes(), Charsets.UTF_8)
                conn.disconnect()
                ByteArrayInputStream(ProxyMapping.injectShellScript(html).toByteArray(Charsets.UTF_8))
            } else {
                Closing(raw, conn)
            }
            return WebResourceResponse(mime, if (decision.injectShell) "utf-8" else charset, status, ProxyMapping.reasonPhrase(status), headers, body)
        } catch (e: Exception) {
            connection?.disconnect()
            val message = e.message ?: e.javaClass.simpleName
            return text(502, "Could not reach bija: $message")
        }
    }

    /** Closes the connection together with the stream the WebView reads. */
    private class Closing(input: InputStream, private val connection: HttpURLConnection) : FilterInputStream(input) {
        override fun close() {
            try {
                super.close()
            } finally {
                connection.disconnect()
            }
        }
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 5000
        private const val READ_TIMEOUT_MS = 30000
    }
}
