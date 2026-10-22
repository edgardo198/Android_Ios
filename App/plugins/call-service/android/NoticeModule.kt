package com.chatlocal.calls

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

/** The background receiver gets a revocable device credential, never an account JWT. */
class NoticeModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener, ActivityEventListener {
  private val main = Handler(Looper.getMainLooper())
  private var permissionPromise: Promise? = null
  private var pendingOpen: JSONObject? = null
  override fun getName() = "ChatLocalNotices"

  init {
    current = WeakReference(this)
    context.addLifecycleEventListener(this)
    context.addActivityEventListener(this)
  }

  @ReactMethod fun addListener(name: String) = Unit
  @ReactMethod fun removeListeners(count: Double) = Unit

  @ReactMethod fun getPermission(promise: Promise) { promise.resolve(permitted()) }
  @ReactMethod fun requestPermission(promise: Promise) {
    main.post {
      if (permitted()) { promise.resolve(true); return@post }
      val activity = context.currentActivity as? PermissionAwareActivity
      if (activity == null || context.lifecycleState != LifecycleState.RESUMED || permissionPromise != null) {
        promise.resolve(false); return@post
      }
      permissionPromise = promise
      try {
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), PERMISSION_REQUEST,
          PermissionListener { code, _, _ ->
            if (code != PERMISSION_REQUEST) false
            else { permissionPromise?.resolve(permitted()); permissionPromise = null; true }
          })
      } catch (_: Exception) { permissionPromise?.resolve(false); permissionPromise = null }
    }
  }

  @ReactMethod fun getPreference(username: String, promise: Promise) {
    if (!validUsername(username)) { promise.resolve(false); return }
    promise.resolve(preferences().getBoolean(preferenceKey(username), true))
  }
  @ReactMethod fun setPreference(username: String, enabled: Boolean, promise: Promise) {
    if (!validUsername(username)) { promise.reject("NOTICE_IDENTITY", "Abre tu perfil para cambiar los avisos."); return }
    promise.resolve(preferences().edit().putBoolean(preferenceKey(username), enabled).commit())
  }

  @ReactMethod fun getRegistration(promise: Promise) {
    main.post {
      val saved = NoticeStore.read(context)
      promise.resolve(Arguments.createMap().apply {
        putString("deviceId", installationId())
        putString("userId", saved?.optString("userId") ?: "")
        putString("expiresAt", saved?.optString("expiresAt") ?: "")
        putString("authVersion", saved?.optString("authVersion") ?: "")
      })
    }
  }

  @ReactMethod fun getState(promise: Promise) { main.post { promise.resolve(publicState()) } }

  @ReactMethod fun resume(userId: String, authVersion: String, promise: Promise) {
    main.post {
      try {
        check(context.lifecycleState == LifecycleState.RESUMED && context.currentActivity != null && permitted())
        val saved = NoticeStore.read(context) ?: error("No registration")
        check(saved.optString("userId") == userId && saved.optString("authVersion") == authVersion)
        check(saved.optString("deviceId") == installationId())
        NoticeService.onForegroundChanged(true)
        val intent = Intent(context, NoticeService::class.java).apply { action = NoticeService.START }
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        promise.resolve(true)
      } catch (_: Exception) {
        promise.reject("NOTICE_RESUME_FAILED", "Abre la app para restablecer la recepción de avisos.")
      }
    }
  }

  @ReactMethod fun configure(options: ReadableMap, promise: Promise) {
    main.post {
      try {
        check(context.lifecycleState == LifecycleState.RESUMED && context.currentActivity != null)
        check(permitted())
        val config = JSONObject(options.toHashMap())
        check(config.optBoolean("enabled"))
        check(config.optString("deviceId") == installationId())
        check(config.optString("authVersion").matches(Regex("[0-9]{1,19}")))
        // A running service atomically observes the new encrypted config in
        // onStartCommand. Stop/start here could reuse a destroyed OkHttp client.
        NoticeStore.configure(context, config)
        NoticeService.onForegroundChanged(true)
        val intent = Intent(context, NoticeService::class.java).apply { action = NoticeService.START }
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        promise.resolve(true)
      } catch (_: Exception) {
        NoticeStore.clear(context)
        NoticeService.instance?.shutdown("start_failed")
        promise.reject("NOTICE_START_FAILED", "No se pudo activar la recepción. Abre la app y permite las notificaciones.")
      }
    }
  }

  @ReactMethod fun stop(promise: Promise) {
    main.post {
      val captured = NoticeStore.read(context)
      NoticeStore.clear(context)
      NoticeService.instance?.shutdown("disabled")
      context.stopService(Intent(context, NoticeService::class.java))
      event("ChatLocalNoticeState", JSONObject().put("enabled", false).put("running", false).put("connected", false).put("reason", "disabled"))
      // Clear local delivery immediately; a network outage cannot delay logout.
      promise.resolve(true)
      if (captured != null) revoke(captured)
    }
  }

  @ReactMethod fun setForeground(visible: Boolean, connectionId: String?) {
    main.post {
      NoticeService.currentConnection = connectionId?.takeIf { it.matches(Regex("[1-9][0-9]{0,19}")) }
      NoticeService.onForegroundChanged(visible && context.lifecycleState == LifecycleState.RESUMED)
    }
  }

  @ReactMethod fun getPendingOpen(promise: Promise) {
    main.post {
      val intent = context.currentActivity?.intent
      val value = pendingOpen ?: extractOpen(intent)
      pendingOpen = null
      if (intent != null) OPEN_KEYS.forEach { intent.removeExtra(it) }
      promise.resolve(value?.let { writable(it) })
    }
  }

  override fun onHostResume() { NoticeService.onForegroundChanged(true) }
  override fun onHostPause() { NoticeService.onForegroundChanged(false) }
  override fun onHostDestroy() { NoticeService.onForegroundChanged(false) }
  override fun onActivityResult(activity: android.app.Activity, requestCode: Int, resultCode: Int, data: Intent?) = Unit
  override fun onNewIntent(intent: Intent) {
    val value = extractOpen(intent) ?: return
    pendingOpen = value
    event("ChatLocalNoticeOpen", value)
  }

  private fun extractOpen(intent: Intent?): JSONObject? {
    if (intent == null) return null
    val owner = intent.getStringExtra("noticeUserId") ?: return null
    val eventId = intent.getStringExtra("noticeEventId") ?: return null
    val connection = intent.getStringExtra("connectionId") ?: return null
    if (!listOf(owner, eventId, connection).all { it.matches(Regex("[1-9][0-9]{0,19}")) }) return null
    val call = intent.getStringExtra("callId")
    if (call != null && !call.matches(Regex("[a-fA-F0-9-]{36}"))) return null
    return JSONObject().put("noticeUserId", owner).put("noticeEventId", eventId).put("connectionId", connection).apply {
      if (call != null) put("callId", call)
    }
  }

  private fun permitted() = Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
  private fun preferences() = context.getSharedPreferences("mensajeria.notice.preferences", android.content.Context.MODE_PRIVATE)
  private fun validUsername(username: String) = username.length in 1..150
  private fun preferenceKey(username: String): String = "enabled." + MessageDigest.getInstance("SHA-256")
    .digest(username.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
  private fun installationId(): String {
    val prefs = preferences()
    val saved = prefs.getString("installation", null)
    if (saved != null && runCatching { UUID.fromString(saved) }.isSuccess) return saved
    return UUID.randomUUID().toString().also { prefs.edit().putString("installation", it).commit() }
  }

  private fun publicState(): WritableMap {
    val saved = NoticeStore.read(context)
    return Arguments.createMap().apply {
      putBoolean("enabled", saved != null)
      putBoolean("running", NoticeService.instance != null)
      putBoolean("connected", NoticeService.instance?.connected == true)
      putString("userId", saved?.optString("userId") ?: "")
      putString("deviceId", installationId())
      putString("expiresAt", saved?.optString("expiresAt") ?: "")
      putString("authVersion", saved?.optString("authVersion") ?: "")
    }
  }

  private fun revoke(config: JSONObject) {
    Thread({
      try {
        val wsUrl = config.getString("wsUrl")
        val base = wsUrl.replace(Regex("^ws"), "http").removeSuffix("/ws/device-events/")
        val id = UUID.fromString(config.getString("deviceId")).toString()
        val request = Request.Builder().url("$base/notifications/devices/$id/")
          .header("Authorization", "Bearer ${config.getString("token")}").delete().build()
        OkHttpClient.Builder().callTimeout(8, TimeUnit.SECONDS).build().newCall(request).execute().use { }
      } catch (_: Exception) { /* Remote expiry/auth revocation remains authoritative. */ }
    }, "MensajeriaNoticeRevoke").apply { isDaemon = true; start() }
  }

  override fun invalidate() {
    permissionPromise?.resolve(false); permissionPromise = null
    context.removeLifecycleEventListener(this)
    context.removeActivityEventListener(this)
    if (current?.get() === this) current = null
    // A UI/runtime restart must not stop the independent native receiver.
    super.invalidate()
  }

  companion object {
    private const val PERMISSION_REQUEST = 4073
    private val OPEN_KEYS = listOf("noticeUserId", "noticeEventId", "connectionId", "callId")
    private var current: WeakReference<NoticeModule>? = null
    private fun writable(value: JSONObject): WritableMap = Arguments.createMap().apply {
      value.keys().forEach { key ->
        when (val item = value.opt(key)) {
          is Boolean -> putBoolean(key, item)
          is Number -> putDouble(key, item.toDouble())
          is String -> putString(key, item)
          else -> putNull(key)
        }
      }
    }
    fun event(name: String, payload: JSONObject) {
      val module = current?.get() ?: return
      if (module.context.hasActiveReactInstance()) module.context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, writable(payload))
    }
  }
}
