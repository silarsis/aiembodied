package com.silarsis.aiembodied.room

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
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
import android.widget.PopupMenu
import android.widget.TextView
import org.json.JSONObject

/**
 * One room of bija's world on a phone. The page (the web satellite) comes from bija through [HubProxy] on a secure
 * origin; this activity is the part of the privacy gate that the page cannot be trusted with:
 *
 * - It knows the foreground fact: the activity is resumed, the screen is on and the phone is unlocked.
 * - It keeps the "Close this room" kill switch (also across restarts).
 * - It decides every mic and camera request from the page: granted only while the page's last reported gate allows
 *   that device, and the app is in front, and the room is open. Anything else is denied.
 * - When the app leaves the foreground or the room is closed, it tells the page to stop capture. If the page does
 *   not confirm within a second, it reloads the WebView, which drops any media.
 *
 * It runs no service and holds no wake lock: nothing listens in the background.
 */
class MainActivity : Activity() {
    private lateinit var settings: RoomSettings
    private lateinit var power: PowerManager
    private lateinit var keyguard: KeyguardManager
    private lateinit var webView: WebView
    private lateinit var root: FrameLayout
    private lateinit var unpairedView: View
    private lateinit var offlineView: View
    private lateinit var offlineText: TextView
    private lateinit var closedCover: View
    private lateinit var closeButton: Button
    private lateinit var menuButton: Button

    private val handler = Handler(Looper.getMainLooper())
    private val proxy = HubProxy()
    private val tracker = CaptureStopTracker()

    /** The saved pairing (also given to the page's script through [ShellBridge.pairing]). */
    @Volatile
    private var pairing: Pairing? = null

    /** Written on the main thread, read on the page's thread: the foreground fact the page is told. */
    @Volatile
    private var pageForegroundNow = false

    /** What the page last reported about its gate. Null until it reports after each load. */
    private var report: GateReport? = null
    private var resumed = false
    private var loadedPairing: Pairing? = null
    private var pageFailed = false
    private var receiverRegistered = false

    private var pendingRequest: PermissionRequest? = null
    private var pendingOsAnswered = false
    private var pendingDeadline = 0L

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            foregroundMayHaveChanged()
        }
    }

    private val confirmWatchdog = Runnable {
        if (tracker.onTimeout()) {
            Log.w(TAG, "The page did not confirm that capture stopped; reloading it.")
            reloadPage()
        }
        if (!resumed) webView.onPause()
    }

    private val retryLoad = Runnable { reloadPage() }
    private val retryPending = Runnable { resolvePending() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = RoomSettings(this)
        power = getSystemService(Context.POWER_SERVICE) as PowerManager
        keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        buildViews()
        pairing = settings.pairing()
        proxy.pairing = pairing
        if (pairing == null) openSetup()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        webView.onResume()
        registerScreenReceiver()
        val saved = settings.pairing()
        pairing = saved
        proxy.pairing = saved
        unpairedView.visibility = if (saved == null) View.VISIBLE else View.GONE
        updateClosedUi()
        applyImmersive()
        // Tell the page first if the foreground came back (it reads the fact again when it asks).
        foregroundMayHaveChanged()
        if (saved != null && (saved != loadedPairing || webView.url == null)) loadPage(saved)
        applyKeepScreenOn()
        resolvePending()
    }

    override fun onPause() {
        resumed = false
        unregisterScreenReceiver()
        foregroundMayHaveChanged()
        // If the page still has to confirm that capture stopped, it needs to keep running for a moment.
        if (!tracker.waiting) webView.onPause()
        super.onPause()
    }

    override fun onStop() {
        if (!tracker.waiting) webView.onPause()
        super.onStop()
    }

    override fun onDestroy() {
        handler.removeCallbacks(confirmWatchdog)
        handler.removeCallbacks(retryLoad)
        handler.removeCallbacks(retryPending)
        unregisterScreenReceiver()
        pendingRequest?.deny()
        pendingRequest = null
        webView.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_MEDIA) return
        pendingOsAnswered = true
        // Usually the activity resumes right after this, and onResume decides. If it is already in front, decide now.
        if (resumed) resolvePending()
    }

    // -- The gate -----------------------------------------------------------------------------------

    private fun facts(): ForegroundFacts =
        ForegroundFacts(
            resumed = resumed,
            interactive = power.isInteractive,
            keyguardLocked = keyguard.isKeyguardLocked,
            closed = settings.closed,
        )

    private fun refreshForeground() {
        pageForegroundNow = Gate.pageForeground(facts())
    }

    /** Re-reads the foreground fact. On a change, tells the page, and on a loss makes sure capture stops. */
    private fun foregroundMayHaveChanged() {
        val was = pageForegroundNow
        refreshForeground()
        if (was == pageForegroundNow) return
        if (pageForegroundNow) {
            handler.removeCallbacks(confirmWatchdog)
            tracker.cancel()
            if (resumed) webView.onResume()
            notifyPage()
        } else {
            val mustWait = tracker.onLoss(report)
            // Nothing may be granted until the page reports again, after the foreground is back.
            report = null
            notifyPage()
            if (mustWait) {
                handler.removeCallbacks(confirmWatchdog)
                handler.postDelayed(confirmWatchdog, CaptureStopTracker.CONFIRM_TIMEOUT_MS)
            }
        }
        applyKeepScreenOn()
    }

    private fun notifyPage() {
        webView.evaluateJavascript(
            "window.__AIEMBODIED_SHELL_NATIVE__&&window.__AIEMBODIED_SHELL_NATIVE__.foregroundChanged()",
            null,
        )
    }

    /** The page told us its gate (main thread). */
    private fun onGateReport(parsed: GateReport?) {
        if (parsed == null) {
            // Not understood: grant nothing, confirm nothing.
            report = null
            return
        }
        report = parsed
        if (tracker.onReport(parsed)) {
            handler.removeCallbacks(confirmWatchdog)
            if (!resumed) webView.onPause()
        }
        applyKeepScreenOn()
    }

    private fun applyKeepScreenOn() {
        if (Gate.keepScreenOn(settings.keepScreenOn, report, facts())) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun setClosed(value: Boolean) {
        settings.closed = value
        updateClosedUi()
        foregroundMayHaveChanged()
    }

    private fun updateClosedUi() {
        val closed = settings.closed
        closedCover.visibility = if (closed) View.VISIBLE else View.GONE
        closeButton.visibility = if (closed) View.GONE else View.VISIBLE
    }

    private fun osPermissionFor(resource: String): String? =
        when (resource) {
            Gate.RESOURCE_AUDIO -> Manifest.permission.RECORD_AUDIO
            Gate.RESOURCE_VIDEO -> Manifest.permission.CAMERA
            else -> null
        }

    private fun hasOsPermission(resource: String): Boolean {
        val permission = osPermissionFor(resource) ?: return false
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun handlePermissionRequest(request: PermissionRequest) {
        val originOk = ProxyMapping.isAppOrigin(request.origin?.toString())
        val granted = Gate.grantable(request.resources.toList(), report, facts(), originOk)
        if (granted.isEmpty()) {
            request.deny()
            return
        }
        val missing = ArrayList<String>()
        for (resource in granted) {
            val permission = osPermissionFor(resource)
            if (permission != null && !hasOsPermission(resource) && !missing.contains(permission)) missing.add(permission)
        }
        if (missing.isEmpty()) {
            request.grant(granted.toTypedArray())
            return
        }
        // The first time: ask Android. The decision is made again, with the facts of that moment, when it answers.
        pendingRequest?.deny()
        pendingRequest = request
        pendingOsAnswered = false
        pendingDeadline = SystemClock.elapsedRealtime() + PENDING_WINDOW_MS
        requestPermissions(missing.toTypedArray(), REQUEST_MEDIA)
    }

    private fun resolvePending() {
        val request = pendingRequest ?: return
        if (!pendingOsAnswered || !resumed) return
        if (report == null && SystemClock.elapsedRealtime() < pendingDeadline) {
            // The page reports its gate again a moment after the app comes back.
            handler.removeCallbacks(retryPending)
            handler.postDelayed(retryPending, 100L)
            return
        }
        pendingRequest = null
        pendingOsAnswered = false
        val originOk = ProxyMapping.isAppOrigin(request.origin?.toString())
        val allowed = Gate.grantable(request.resources.toList(), report, facts(), originOk).filter { hasOsPermission(it) }
        if (allowed.isEmpty()) request.deny() else request.grant(allowed.toTypedArray())
    }

    // -- The page ---------------------------------------------------------------------------------

    private fun loadPage(saved: Pairing) {
        handler.removeCallbacks(retryLoad)
        loadedPairing = saved
        pageFailed = false
        report = null
        tracker.cancel()
        webView.loadUrl(ProxyMapping.START_URL)
    }

    private fun reloadPage() {
        val saved = pairing
        if (saved == null) return
        loadPage(saved)
    }

    private fun showOffline(message: String) {
        pageFailed = true
        offlineText.text = message + "\n\nTrying again every few seconds."
        offlineView.visibility = View.VISIBLE
        handler.removeCallbacks(retryLoad)
        handler.postDelayed(retryLoad, RETRY_MS)
    }

    private fun openSetup() {
        startActivity(Intent(this, SetupActivity::class.java))
    }

    private fun forgetPairing() {
        settings.forgetPairing()
        pairing = null
        proxy.pairing = null
        loadedPairing = null
        report = null
        tracker.cancel()
        handler.removeCallbacks(retryLoad)
        // Leaving the page drops any media it held.
        webView.loadUrl("about:blank")
        offlineView.visibility = View.GONE
        unpairedView.visibility = View.VISIBLE
        applyKeepScreenOn()
    }

    /** What the page's script may call. Runs on a WebView thread, so nothing here touches views directly. */
    inner class ShellBridge {
        @JavascriptInterface
        fun pairing(): String = PairingLogic.shellPairingJson(this@MainActivity.pairing)

        @JavascriptInterface
        fun foreground(): Boolean = pageForegroundNow

        @JavascriptInterface
        fun reportGate(json: String?) {
            val parsed = parseGate(json)
            handler.post { onGateReport(parsed) }
        }

        private fun parseGate(json: String?): GateReport? {
            if (json == null) return null
            return try {
                val o = JSONObject(json)
                GateReport(o.optBoolean("micAllowed", false), o.optBoolean("cameraAllowed", false), o.optBoolean("occupied", false))
            } catch (e: Exception) {
                null
            }
        }
    }

    // -- Views ------------------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildViews() {
        root = FrameLayout(this)
        root.setBackgroundColor(Color.rgb(11, 16, 32))
        root.setOnApplyWindowInsetsListener { _, insets ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                root.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                root.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }

        webView = WebView(this)
        webView.setBackgroundColor(Color.rgb(11, 16, 32))
        val s = webView.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.cacheMode = WebSettings.LOAD_DEFAULT
        s.allowFileAccess = false
        s.allowContentAccess = false
        // The page is https; the room link is ws:// to bija (see README). Without this the WebView blocks the socket.
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        webView.addJavascriptInterface(ShellBridge(), "AiembodiedShell")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = proxy.handle(request)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Stay on the room's page; nothing else opens inside the app.
                return !ProxyMapping.isAppOrigin(request.url.scheme + "://" + request.url.authority)
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                report = null
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOffline("Can't load the room from bija. ${error.description}")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame) {
                    showOffline("bija answered ${response.statusCode}. Is it running, and has the renderer been built (pnpm --filter @aiembodied/renderer build)?")
                }
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                handler.cancel()
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!pageFailed && url.startsWith(ProxyMapping.APP_ORIGIN)) offlineView.visibility = View.GONE
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                handlePermissionRequest(request)
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingRequest === request) {
                    pendingRequest = null
                    pendingOsAnswered = false
                }
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d("RoomPage", message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")")
                return true
            }
        }
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        offlineView = buildOfflineView()
        root.addView(offlineView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        unpairedView = buildUnpairedView()
        root.addView(unpairedView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        closedCover = buildClosedCover()
        root.addView(closedCover, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // The two small buttons that are always there, over everything.
        val bar = LinearLayout(this)
        bar.orientation = LinearLayout.HORIZONTAL
        closeButton = smallButton("Close this room")
        closeButton.setOnClickListener { setClosed(true) }
        menuButton = smallButton("Menu")
        menuButton.setOnClickListener { showMenu() }
        bar.addView(closeButton)
        bar.addView(menuButton)
        val barParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        barParams.gravity = Gravity.TOP or Gravity.END
        barParams.setMargins(dp(8), dp(8), dp(8), dp(8))
        root.addView(bar, barParams)
        setContentView(root)
    }

    private fun smallButton(label: String): Button {
        val button = Button(this)
        button.text = label
        button.textSize = 11f
        button.isAllCaps = false
        button.alpha = 0.75f
        button.minHeight = 0
        button.minimumHeight = 0
        button.setPadding(dp(10), dp(4), dp(10), dp(4))
        return button
    }

    private fun showMenu() {
        val popup = PopupMenu(this, menuButton)
        val menu = popup.menu
        menu.add(0, MENU_CLOSE, 0, if (settings.closed) "Open this room" else "Close this room")
        val keep = menu.add(0, MENU_KEEP_ON, 1, "Keep screen on while an avatar is here")
        keep.isCheckable = true
        keep.isChecked = settings.keepScreenOn
        val full = menu.add(0, MENU_IMMERSIVE, 2, "Full screen")
        full.isCheckable = true
        full.isChecked = settings.immersive
        menu.add(0, MENU_RELOAD, 3, "Reload the page")
        menu.add(0, MENU_REPAIR, 4, "Pair again")
        menu.add(0, MENU_FORGET, 5, "Forget pairing")
        popup.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                MENU_CLOSE -> setClosed(!settings.closed)
                MENU_KEEP_ON -> {
                    settings.keepScreenOn = !settings.keepScreenOn
                    applyKeepScreenOn()
                }
                MENU_IMMERSIVE -> {
                    settings.immersive = !settings.immersive
                    applyImmersive()
                }
                MENU_RELOAD -> reloadPage()
                MENU_REPAIR -> openSetup()
                MENU_FORGET -> forgetPairing()
            }
            true
        }
        popup.show()
    }

    private fun buildOfflineView(): View {
        val column = centeredColumn()
        column.visibility = View.GONE
        column.addView(heading("Waiting for bija"))
        offlineText = TextView(this)
        offlineText.setTextColor(Color.rgb(226, 232, 240))
        offlineText.textSize = 16f
        offlineText.gravity = Gravity.CENTER
        column.addView(offlineText)
        val retry = Button(this)
        retry.text = "Retry now"
        retry.setOnClickListener { reloadPage() }
        column.addView(retry)
        val pairAgain = Button(this)
        pairAgain.text = "Pair again"
        pairAgain.setOnClickListener { openSetup() }
        column.addView(pairAgain)
        return column
    }

    private fun buildUnpairedView(): View {
        val column = centeredColumn()
        column.visibility = View.GONE
        column.addView(heading("Not paired"))
        val note = TextView(this)
        note.text = "This phone is not a room yet. Pair it with bija to start."
        note.setTextColor(Color.rgb(226, 232, 240))
        note.textSize = 16f
        note.gravity = Gravity.CENTER
        column.addView(note)
        val button = Button(this)
        button.text = "Pair with bija"
        button.setOnClickListener { openSetup() }
        column.addView(button)
        return column
    }

    private fun buildClosedCover(): View {
        val column = centeredColumn()
        column.visibility = View.GONE
        column.addView(heading("This room is closed"))
        val note = TextView(this)
        note.text = "The microphone and camera are off. Nobody here can be seen or heard."
        note.setTextColor(Color.rgb(226, 232, 240))
        note.textSize = 16f
        note.gravity = Gravity.CENTER
        column.addView(note)
        val button = Button(this)
        button.text = "Open this room"
        button.setOnClickListener { setClosed(false) }
        column.addView(button)
        return column
    }

    private fun centeredColumn(): LinearLayout {
        val column = LinearLayout(this)
        column.orientation = LinearLayout.VERTICAL
        column.gravity = Gravity.CENTER
        column.setPadding(dp(32), dp(32), dp(32), dp(32))
        column.setBackgroundColor(Color.rgb(11, 16, 32))
        // Swallow taps so nothing behind a cover can be pressed.
        column.isClickable = true
        return column
    }

    private fun heading(value: String): TextView {
        val title = TextView(this)
        title.text = value
        title.setTextColor(Color.WHITE)
        title.textSize = 22f
        title.typeface = Typeface.DEFAULT_BOLD
        title.gravity = Gravity.CENTER
        title.setPadding(0, 0, 0, dp(12))
        return title
    }

    private fun applyImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val controller = window.insetsController ?: return
            if (settings.immersive) {
                controller.hide(WindowInsets.Type.systemBars())
                controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                controller.show(WindowInsets.Type.systemBars())
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                if (settings.immersive) {
                    (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        or View.SYSTEM_UI_FLAG_FULLSCREEN
                        or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
                } else {
                    View.SYSTEM_UI_FLAG_VISIBLE
                }
        }
    }

    private fun registerScreenReceiver() {
        if (receiverRegistered) return
        val filter = IntentFilter()
        filter.addAction(Intent.ACTION_SCREEN_OFF)
        filter.addAction(Intent.ACTION_SCREEN_ON)
        filter.addAction(Intent.ACTION_USER_PRESENT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(screenReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(screenReceiver, filter)
        }
        receiverRegistered = true
    }

    private fun unregisterScreenReceiver() {
        if (!receiverRegistered) return
        receiverRegistered = false
        try {
            unregisterReceiver(screenReceiver)
        } catch (e: IllegalArgumentException) {
            // Already gone.
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val TAG = "AiembodiedRoom"
        private const val REQUEST_MEDIA = 1
        private const val RETRY_MS = 5000L
        private const val PENDING_WINDOW_MS = 2000L
        private const val MENU_CLOSE = 1
        private const val MENU_KEEP_ON = 2
        private const val MENU_IMMERSIVE = 3
        private const val MENU_RELOAD = 4
        private const val MENU_REPAIR = 5
        private const val MENU_FORGET = 6
    }
}
