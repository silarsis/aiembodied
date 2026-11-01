package com.silarsis.aiembodied.companion

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.util.Log

/**
 * Full screen avatar. The page itself (avatar, background, conversation) comes from the desktop
 * app, so it is always the same renderer as on the desktop; this activity adds what a page
 * loaded over the LAN cannot do itself: the microphone, keeping the screen on, and the settings.
 */
class MainActivity : Activity() {
    private lateinit var settings: CompanionSettings
    private lateinit var webView: WebView
    private lateinit var offlineView: View
    private lateinit var offlineText: TextView
    private val handler = Handler(Looper.getMainLooper())
    private var loadedUrl: String? = null
    private var pageFailed = false
    private var micWanted = false
    private val retry = Runnable { load(force = true) }

    private val mic = MicRecorder(
        onChunk = { pcm, rate ->
            val base64 = Base64.encodeToString(pcm, Base64.NO_WRAP)
            handler.post {
                webView.evaluateJavascript("window.companionNative&&window.companionNative.onAudio('$base64',$rate)", null)
            }
        },
        onError = { message -> handler.post { sendMicError(message) } },
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = CompanionSettings(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        buildViews()
        if (!settings.isConfigured) {
            openSettings()
        }
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        webView.onResume()
        if (settings.isConfigured) load(force = false)
        webView.evaluateJavascript("window.companionNative&&window.companionNative.onResume&&window.companionNative.onResume()", null)
    }

    override fun onPause() {
        // The mic only runs in the foreground.
        if (mic.isRunning) {
            mic.stop()
            sendMicError("Paused while the app was in the background.")
        }
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacks(retry)
        mic.stop()
        webView.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_MIC) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            if (micWanted) mic.start()
        } else {
            micWanted = false
            sendMicError("Microphone permission was refused. Allow it in Android settings to talk.")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildViews() {
        val root = FrameLayout(this)
        root.setBackgroundColor(Color.rgb(11, 16, 32))

        webView = WebView(this)
        webView.setBackgroundColor(Color.rgb(11, 16, 32))
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
        }
        webView.addJavascriptInterface(Bridge(), "AndroidCompanion")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Stay on the desktop's page; nothing else opens inside the app.
                val base = settings.baseUrl ?: return true
                return !request.url.toString().startsWith(base)
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOffline("Can't reach the desktop at ${settings.baseUrl}.\n${error.description}")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame) showOffline("The desktop answered ${response.statusCode}. Is the phone companion turned on in Settings?")
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
                showOffline("The desktop's HTTPS certificate was not accepted.")
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!pageFailed) offlineView.visibility = View.GONE
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d("CompanionPage", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        offlineView = buildOfflineView()
        root.addView(offlineView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
    }

    private fun buildOfflineView(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
            setBackgroundColor(Color.rgb(11, 16, 32))
            visibility = View.GONE
        }
        offlineText = TextView(this).apply {
            setTextColor(Color.rgb(226, 232, 240))
            textSize = 16f
            gravity = Gravity.CENTER
        }
        val title = TextView(this).apply {
            text = "Waiting for the desktop"
            setTextColor(Color.WHITE)
            textSize = 22f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }
        val retryButton = Button(this).apply {
            text = "Retry now"
            setOnClickListener { load(force = true) }
        }
        val settingsButton = Button(this).apply {
            text = "Connection settings"
            setOnClickListener { openSettings() }
        }
        column.addView(title)
        column.addView(offlineText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
        column.addView(retryButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(24) })
        column.addView(settingsButton)
        return column
    }

    private fun load(force: Boolean) {
        handler.removeCallbacks(retry)
        val url = settings.pageUrl() ?: return openSettings()
        if (!force && url == loadedUrl && !pageFailed) return
        pageFailed = false
        loadedUrl = url
        webView.loadUrl(url)
    }

    private fun showOffline(message: String) {
        pageFailed = true
        offlineText.text = "$message\n\nRetrying every few seconds."
        offlineView.visibility = View.VISIBLE
        handler.removeCallbacks(retry)
        handler.postDelayed(retry, RETRY_MS)
    }

    private fun openSettings() {
        startActivity(Intent(this, SetupActivity::class.java))
    }

    private fun sendMicError(message: String) {
        val quoted = org.json.JSONObject.quote(message)
        webView.evaluateJavascript("window.companionNative&&window.companionNative.onMicError($quoted)", null)
    }

    private fun hideSystemBars() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    /** Called from the page's JavaScript (on a binder thread, so hop to the main thread). */
    inner class Bridge {
        @JavascriptInterface
        fun startMic() {
            handler.post {
                micWanted = true
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    mic.start()
                } else {
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MIC)
                }
            }
        }

        @JavascriptInterface
        fun stopMic() {
            handler.post {
                micWanted = false
                mic.stop()
            }
        }

        @JavascriptInterface
        fun openSettings() {
            handler.post { this@MainActivity.openSettings() }
        }

        @JavascriptInterface
        fun setKeepScreenOn(on: Boolean) {
            handler.post {
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    companion object {
        private const val REQUEST_MIC = 1
        private const val RETRY_MS = 5000L
    }
}
