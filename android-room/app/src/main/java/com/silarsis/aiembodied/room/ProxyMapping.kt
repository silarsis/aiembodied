package com.silarsis.aiembodied.room

import java.net.URI

/**
 * How the WebView's secure origin maps to bija's plain-http hub. Pure Kotlin so it can be tested on the JVM.
 *
 * The page is loaded from https://appassets.androidplatform.net/app/ (a secure context, so getUserMedia works).
 * Every request to that origin is answered by the shell, which fetches it from http://<hub>:<port> and passes the
 * answer on. Only the paths the web satellite needs are forwarded; everything else on that origin is refused.
 */
object ProxyMapping {
    const val APP_HOST = "appassets.androidplatform.net"
    const val APP_ORIGIN = "https://appassets.androidplatform.net"
    const val START_URL = "https://appassets.androidplatform.net/app/"
    const val SHELL_SCRIPT_PATH = "/__aiembodied_shell.js"

    /** What to do with one WebView request. */
    sealed class Decision {
        /** Not ours (data:, blob:, ...): let the WebView handle it. */
        object Pass : Decision()

        /** Answer with a refusal. */
        object Block : Decision()

        /** Answer with the shell script, made locally. */
        object ShellScript : Decision()

        /** Fetch [url] from the hub. [withToken]: add the device token. [injectShell]: this is the page; add the shell script to it. */
        class Forward(val url: String, val withToken: Boolean, val injectShell: Boolean) : Decision()
    }

    /** Is this the origin the shell serves (as `PermissionRequest.getOrigin` or a page address)? */
    fun isAppOrigin(origin: String?): Boolean {
        if (origin == null) return false
        val uri = parse(origin) ?: return false
        return uri.scheme == "https" && uri.host?.lowercase() == APP_HOST && (uri.port == -1 || uri.port == 443) && uri.userInfo == null
    }

    fun decide(url: String, method: String, hubHost: String, hubPort: Int): Decision {
        val uri = parse(url) ?: return Decision.Block
        val scheme = uri.scheme?.lowercase() ?: return Decision.Block
        if (scheme != "http" && scheme != "https") return Decision.Pass
        if (!isAppOrigin("$scheme://${uri.rawAuthority ?: ""}")) return Decision.Block
        if (!method.equals("GET", ignoreCase = true)) return Decision.Block
        val path = uri.rawPath ?: ""
        // No way out of the folder, however it is spelled.
        val lower = path.lowercase()
        if (lower.contains("..") || lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") || lower.contains("\\") || lower.contains("//")) {
            return Decision.Block
        }
        val query = if (uri.rawQuery != null) "?" + uri.rawQuery else ""
        val base = "http://$hubHost:$hubPort"
        return when {
            path == SHELL_SCRIPT_PATH -> Decision.ShellScript
            path == "/app" || path == "/app/" -> Decision.Forward("$base/app/$query", withToken = false, injectShell = true)
            path.startsWith("/app/") -> Decision.Forward("$base$path$query", withToken = false, injectShell = false)
            path == "/v1/asset" -> Decision.Forward("$base$path$query", withToken = true, injectShell = false)
            else -> Decision.Block
        }
    }

    private fun parse(text: String): URI? =
        try {
            URI(text)
        } catch (e: Exception) {
            null
        }

    /** Splits `text/html; charset=utf-8` into the type and the charset (null when absent). */
    fun splitContentType(header: String?): Pair<String, String?> {
        if (header == null) return Pair("application/octet-stream", null)
        val parts = header.split(";")
        val mime = parts[0].trim().ifEmpty { "application/octet-stream" }
        var charset: String? = null
        for (i in 1 until parts.size) {
            val piece = parts[i].trim()
            if (piece.lowercase().startsWith("charset=")) {
                charset = piece.substring(8).trim().trim('"').ifEmpty { null }
            }
        }
        return Pair(mime, charset)
    }

    /** Adds the shell script as the first thing in `<head>`, so it runs before the page's own (deferred module) script. */
    fun injectShellScript(html: String): String {
        val tag = "<script src=\"$SHELL_SCRIPT_PATH\"></script>"
        val head = Regex("<head[^>]*>", RegexOption.IGNORE_CASE).find(html)
        if (head == null) return tag + html
        val at = head.range.last + 1
        return html.substring(0, at) + tag + html.substring(at)
    }

    /** Response headers worth passing on. Content-Length is left out on purpose (the page is rewritten, and the body is streamed). */
    val PASS_HEADERS: List<String> = listOf("Cache-Control", "Content-Range", "Accept-Ranges", "Cross-Origin-Resource-Policy", "X-Content-Type-Options")

    fun reasonPhrase(status: Int): String =
        when (status) {
            200 -> "OK"
            206 -> "Partial Content"
            401 -> "Unauthorized"
            403 -> "Forbidden"
            404 -> "Not Found"
            502 -> "Bad Gateway"
            503 -> "Service Unavailable"
            else -> if (status in 200..299) "OK" else "Error"
        }

    /**
     * The script that sets `window.__AIEMBODIED_SHELL__` before the page boots (see docs/features/satellite.md,
     * "For the Android shell"). It only calls the narrow `AiembodiedShell` object; `foreground()` is read each
     * time so a stale value is never kept in the page, and anything unexpected counts as "not foreground".
     */
    val SHELL_SCRIPT: String = """
        (function () {
          var native = window.AiembodiedShell;
          if (!native) { return; }
          var pairing = {};
          try { pairing = JSON.parse(native.pairing()); } catch (e) { pairing = {}; }
          var listeners = [];
          window.__AIEMBODIED_SHELL_NATIVE__ = {
            foregroundChanged: function () {
              var copy = listeners.slice();
              for (var i = 0; i < copy.length; i++) { try { copy[i](); } catch (e) {} }
            }
          };
          window.__AIEMBODIED_SHELL__ = {
            hubUrl: pairing.hubUrl,
            deviceId: pairing.deviceId,
            token: pairing.token,
            deviceName: pairing.deviceName,
            kind: 'phone',
            foreground: function () { try { return native.foreground() === true; } catch (e) { return false; } },
            onForeground: function (listener) {
              listeners.push(listener);
              return function () {
                var at = listeners.indexOf(listener);
                if (at >= 0) { listeners.splice(at, 1); }
              };
            },
            onGate: function (state) { try { native.reportGate(JSON.stringify(state)); } catch (e) {} }
          };
        })();
    """.trimIndent()
}
