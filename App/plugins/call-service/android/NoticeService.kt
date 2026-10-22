package com.chatlocal.calls

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Own-server receiver; no JS timer, microphone, camera or external push provider. */
class NoticeService : Service() {
  var connected = false; private set
  val running: Boolean get() = started && !stopped
  private var stopped = false
  private var started = false
  private var config: JSONObject? = null
  private var socket: WebSocket? = null
  private var generation = 0L
  private var retryAttempt = 0
  private var lastServerFrame = 0L
  private var heartbeatSeconds = 15L
  private var lastDeliveredCursor = "0"
  private var serverClockMillis = System.currentTimeMillis()
  private var serverClockElapsed = SystemClock.elapsedRealtime()
  private lateinit var manager: NotificationManager
  private val main = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build()
  private val revisions = LinkedHashMap<String, Long>()
  private val callVersions = LinkedHashMap<String, Long>()
  private val ringing = LinkedHashMap<String, JSONObject>()
  private val expirations = mutableMapOf<String, Runnable>()
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private val reconnect = Runnable { if (!stopped) connect() }
  private val heartbeat = object : Runnable {
    override fun run() {
      if (stopped) return
      if (!ensureCurrentConfiguration()) {
        if (!stopped) main.postDelayed(this, heartbeatSeconds * 1000)
        return
      }
      val current = socket
      if (current != null && SystemClock.elapsedRealtime() - lastServerFrame > 60000) {
        dropSocket(); scheduleReconnect()
      } else if (connected && current?.send(JSONObject().put("type", "notification.ping").toString()) == false) {
        dropSocket(); scheduleReconnect()
      }
      if (!stopped) main.postDelayed(this, heartbeatSeconds * 1000)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() {
    super.onCreate()
    instance = this
    manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel(SERVICE_CHANNEL, "Recepción de avisos", NotificationManager.IMPORTANCE_LOW).apply {
        setSound(null, null); enableVibration(false); lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      })
      manager.createNotificationChannel(NotificationChannel(MESSAGE_CHANNEL, "Mensajes nuevos", NotificationManager.IMPORTANCE_DEFAULT).apply {
        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      })
      manager.createNotificationChannel(NotificationChannel(CALL_CHANNEL, "Llamadas entrantes", NotificationManager.IMPORTANCE_HIGH).apply {
        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      })
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == STOP) {
      try { NoticeStore.clear(this) } catch (_: Exception) { }
      shutdown("disabled"); return START_NOT_STICKY
    }
    if (intent != null && intent.action != START) {
      if (!started) shutdown("invalid_start")
      return if (started && !stopped) START_STICKY else START_NOT_STICKY
    }
    val stored = NoticeStore.read(this)
    if (stored == null) { shutdown("not_configured"); return START_NOT_STICKY }
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      shutdown("permission_denied"); return START_NOT_STICKY
    }
    if (stopped) { stopped = false; started = false; instance = this }
    try {
      if (!started) {
        config = stored
        val notification = serviceNotification()
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(NOTIFICATION_ID, notification)
        started = true
        watchNetwork()
        main.postDelayed(heartbeat, 15000)
        connect()
      } else if (!sameConfiguration(stored)) {
        replaceConfiguration(stored)
      }
      publish("started")
    } catch (_: Exception) { shutdown("start_failed"); return START_NOT_STICKY }
    return START_STICKY
  }

  private fun sameConfiguration(stored: JSONObject): Boolean = config?.let {
    it.optString("userId") == stored.optString("userId") && it.optString("deviceId") == stored.optString("deviceId") &&
      it.optString("token") == stored.optString("token") && it.optString("wsUrl") == stored.optString("wsUrl") &&
      it.optString("authVersion") == stored.optString("authVersion")
  } == true

  private fun replaceConfiguration(stored: JSONObject) {
    dropSocket(); clearNotices()
    config = stored; lastDeliveredCursor = "0"; retryAttempt = 0
    serverClockMillis = System.currentTimeMillis(); serverClockElapsed = SystemClock.elapsedRealtime()
    revisions.clear(); callVersions.clear(); connect()
  }

  private fun ensureCurrentConfiguration(): Boolean {
    val stored = NoticeStore.read(this)
    if (stored == null) { shutdown("not_configured"); return false }
    if (!sameConfiguration(stored)) { replaceConfiguration(stored); return false }
    return true
  }

  private fun connect() {
    if (stopped || !started) return
    main.removeCallbacks(reconnect)
    if (!ensureCurrentConfiguration()) return
    dropSocket()
    val ownGeneration = generation
    val currentConfig = config ?: return
    lastServerFrame = SystemClock.elapsedRealtime()
    val request = Request.Builder().url(currentConfig.getString("wsUrl"))
      .header("Authorization", "Bearer ${currentConfig.getString("token")}").build()
    try {
      socket = client.newWebSocket(request, object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = main.post {
          if (active(ownGeneration, webSocket)) lastServerFrame = SystemClock.elapsedRealtime()
        }.let { Unit }
        override fun onMessage(webSocket: WebSocket, text: String) = main.post {
          if (!active(ownGeneration, webSocket)) return@post
          if (!ensureCurrentConfiguration()) return@post
          try {
            require(text.length <= 262144)
            receive(JSONObject(text), webSocket)
          } catch (_: Exception) { protocolFailure() }
        }.let { Unit }
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = main.post {
          if (active(ownGeneration, webSocket)) protocolFailure()
        }.let { Unit }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) = main.post {
          if (!active(ownGeneration, webSocket)) return@post
          webSocket.close(code, "")
          if (code == 4401 || code == 4403) revoked() else { dropSocket(); scheduleReconnect() }
        }.let { Unit }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = main.post {
          if (!active(ownGeneration, webSocket)) return@post
          if (code == 4401 || code == 4403) revoked() else { dropSocket(); scheduleReconnect() }
        }.let { Unit }
        override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) = main.post {
          if (!active(ownGeneration, webSocket)) return@post
          if (response?.code == 401 || response?.code == 403) revoked()
          else { dropSocket(); scheduleReconnect() }
        }.let { Unit }
      })
    } catch (_: Exception) { dropSocket(); scheduleReconnect() }
  }

  private fun active(epoch: Long, candidate: WebSocket): Boolean {
    if (stopped || epoch != generation || socket !== candidate) return false
    return ensureCurrentConfiguration()
  }

  private fun receive(payload: JSONObject, current: WebSocket) {
    lastServerFrame = SystemClock.elapsedRealtime()
    when (payload.getString("type")) {
      "notification.ready" -> {
        require(payload.getString("deviceId") == config?.getString("deviceId"))
        require(NoticeStore.timestampMillis(payload.getString("expiresAt")) != null)
        payload.optString("serverTime").takeIf { it.isNotEmpty() }?.let { timestamp ->
          serverClockMillis = NoticeStore.timestampMillis(timestamp) ?: throw IllegalArgumentException()
          serverClockElapsed = SystemClock.elapsedRealtime()
        }
        heartbeatSeconds = payload.optLong("heartbeatSeconds", 15).coerceIn(10, 60)
        connected = true; retryAttempt = 0; publish("connected")
      }
      "notification.pong", "notification.acked" -> { }
      "notification.revoked" -> revoked()
      "notification.events" -> {
        require(connected)
        val events = payload.getJSONArray("events")
        require(events.length() <= 200)
        val cursor = decimal(payload.opt("cursor")) ?: throw IllegalArgumentException()
        var previous = "0"
        val batch = (0 until events.length()).map { index ->
          val event = events.getJSONObject(index)
          val id = decimal(event.opt("id")) ?: throw IllegalArgumentException()
          require(compareIds(id, previous) > 0 && compareIds(id, cursor) <= 0)
          validateEvent(event); previous = id; event
        }
        // Do not acknowledge a batch whose display failed midway. Tags/event IDs
        // make its replay safe if the connection dies before ACK reaches Django.
        for (event in batch) if (compareIds(event.getString("id"), lastDeliveredCursor) > 0) {
          deliver(event)
          lastDeliveredCursor = event.getString("id")
        }
        if (!stopped && socket === current && ensureCurrentConfiguration()) {
          if (current.send(JSONObject().put("type", "notification.ack").put("cursor", cursor).toString())) {
            if (compareIds(cursor, lastDeliveredCursor) > 0) lastDeliveredCursor = cursor
          } else { dropSocket(); scheduleReconnect() }
        }
      }
      else -> throw IllegalArgumentException()
    }
  }

  private fun validateEvent(event: JSONObject) {
    require(decimal(event.opt("connectionId"))?.let { it != "0" } == true)
    require(decimal(event.opt("revision")) != null)
    when (event.getString("type")) {
      "message" -> require(decimal(event.opt("messageId"))?.let { it != "0" } == true)
      "history.cleared" -> { }
      "call" -> {
        val callId = event.getString("callId")
        require(callId.length == 36 && UUID.fromString(callId).toString() == callId.lowercase())
        require(event.getString("kind") in listOf("audio", "video"))
        require(event.getString("status") in listOf("ringing", "connecting", "active", "ended"))
        require(event.getString("direction") in listOf("incoming", "outgoing"))
        require(decimal(event.opt("version")) != null)
        require(NoticeStore.timestampMillis(event.getString("expiresAt")) != null)
      }
      else -> throw IllegalArgumentException()
    }
  }

  private fun deliver(event: JSONObject) {
    val connection = decimal(event.opt("connectionId"))!!
    val revision = event.getLong("revision")
    when (event.getString("type")) {
      "history.cleared" -> {
        if (revision >= (revisions[connection] ?: 0)) {
          remember(revisions, connection, revision)
          manager.cancel(messageTag(connection), EVENT_ID)
          for ((id, pending) in ringing.toMap()) if (decimal(pending.opt("connectionId")) == connection) cancelCall(id)
        }
      }
      "message" -> {
        if (revision < (revisions[connection] ?: 0)) return
        remember(revisions, connection, revision)
        if (uiVisible && currentConnection == connection) return
        manager.notify(messageTag(connection), EVENT_ID, eventNotification(event, false))
      }
      "call" -> {
        val id = event.getString("callId")
        val version = event.getLong("version")
        if (version < (callVersions[id] ?: -1)) return
        remember(callVersions, id, version)
        val expires = NoticeStore.timestampMillis(event.getString("expiresAt"))!!
        if (revision < (revisions[connection] ?: 0) || event.getString("status") != "ringing" ||
            event.getString("direction") != "incoming" || expires <= serverNow()) {
          cancelCall(id); return
        }
        cancelCall(id)
        if (ringing.size >= 16) cancelCall(ringing.keys.first())
        ringing[id] = event
        val deadline = (expires - serverNow()).coerceIn(1, 60000)
        val remove = Runnable { cancelCall(id) }
        expirations[id] = remove; main.postDelayed(remove, deadline)
        if (!uiVisible) manager.notify(callTag(id), EVENT_ID, eventNotification(event, true, deadline))
      }
    }
  }

  private fun eventNotification(event: JSONObject, call: Boolean, timeout: Long = 0): Notification {
    val public = builder(if (call) CALL_CHANNEL else MESSAGE_CHANNEL)
      .setSmallIcon(android.R.drawable.sym_action_chat).setContentTitle("Mensajería").setContentText("Nuevo aviso").build()
    val result = builder(if (call) CALL_CHANNEL else MESSAGE_CHANNEL).setSmallIcon(android.R.drawable.sym_action_chat)
      .setContentTitle(if (call) "Llamada entrante" else "Nuevo mensaje")
      .setContentText(if (!call) "Tienes un mensaje nuevo." else if (event.getString("kind") == "video") "Abre la app para ver la videollamada." else "Abre la app para responder.")
      .setContentIntent(openApp(event)).setCategory(if (call) Notification.CATEGORY_CALL else Notification.CATEGORY_MESSAGE)
      .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(public).setAutoCancel(!call)
      .setOnlyAlertOnce(true).setPriority(if (call) Notification.PRIORITY_HIGH else Notification.PRIORITY_DEFAULT)
    if (call && Build.VERSION.SDK_INT >= 26) result.setTimeoutAfter(timeout)
    return result.build()
  }

  private fun serviceNotification(): Notification = builder(SERVICE_CHANNEL).setSmallIcon(android.R.drawable.sym_action_chat)
    .setContentTitle("Mensajería").setContentText("Recibiendo avisos del servidor propio")
    .setOngoing(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE)
    .setContentIntent(openApp(null)).setCategory(Notification.CATEGORY_SERVICE).build()

  private fun builder(channel: String): Notification.Builder =
    if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channel) else Notification.Builder(this)

  private fun openApp(event: JSONObject?): PendingIntent {
    val owner = config?.optString("userId") ?: ""
    val connection = event?.let { decimal(it.opt("connectionId")) }
    val callId = event?.optString("callId")?.takeIf { it.isNotEmpty() }
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: throw IllegalStateException()
    launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    // Data makes each owner/target PendingIntent distinct. It contains metadata
    // only; the RN module checks the authenticated owner before any navigation.
    launch.data = Uri.Builder().scheme("chatlocal-notice").authority("open").appendPath(owner)
      .appendPath(connection ?: "home").appendPath(callId ?: "messages").build()
    launch.putExtra("noticeUserId", owner)
    connection?.let { launch.putExtra("connectionId", it) }
    callId?.let { launch.putExtra("callId", it) }
    event?.optString("id")?.takeIf { it.isNotEmpty() }?.let { launch.putExtra("noticeEventId", it) }
    return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun foregroundChanged(visible: Boolean) {
    if (stopped || !ensureCurrentConfiguration()) return
    if (visible) {
      currentConnection?.let { manager.cancel(messageTag(it), EVENT_ID) }
      for (id in ringing.keys) manager.cancel(callTag(id), EVENT_ID)
    } else {
      for ((id, event) in ringing.toMap()) {
        val remaining = (NoticeStore.timestampMillis(event.getString("expiresAt"))!! - serverNow()).coerceAtMost(60000)
        if (remaining <= 0) cancelCall(id)
        else try { manager.notify(callTag(id), EVENT_ID, eventNotification(event, true, remaining)) }
        catch (_: Exception) { shutdown("permission_denied"); return }
      }
    }
  }

  private fun cancelCall(id: String) {
    expirations.remove(id)?.let { main.removeCallbacks(it) }
    ringing.remove(id)
    manager.cancel(callTag(id), EVENT_ID)
  }

  private fun clearNotices() {
    for (expiration in expirations.values) main.removeCallbacks(expiration)
    expirations.clear(); ringing.clear()
    for (notice in manager.activeNotifications) if (notice.tag?.startsWith(TAG_PREFIX) == true) manager.cancel(notice.tag, notice.id)
  }

  private fun dropSocket() {
    generation += 1; connected = false
    val previous = socket; socket = null; previous?.cancel()
  }

  private fun scheduleReconnect(delay: Long? = null) {
    if (stopped) return
    main.removeCallbacks(reconnect)
    val backoff = delay ?: (1000L shl retryAttempt.coerceAtMost(5)).coerceAtMost(30000)
    retryAttempt = (retryAttempt + 1).coerceAtMost(6)
    main.postDelayed(reconnect, backoff); publish("reconnecting")
  }

  private fun watchNetwork() {
    val connectivity = getSystemService(ConnectivityManager::class.java)
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) { main.post { if (!stopped && !connected && socket == null) scheduleReconnect(0) } }
    }
    try { connectivity.registerDefaultNetworkCallback(callback); networkCallback = callback } catch (_: Exception) { }
  }

  private fun protocolFailure() { dropSocket(); scheduleReconnect() }
  private fun revoked() {
    val expected = config ?: return
    val cleared = try { NoticeStore.clearIfMatches(this, expected) } catch (_: Exception) { false }
    val current = if (cleared) null else NoticeStore.read(this)
    if (cleared || current == null || sameConfiguration(current)) shutdown("revoked")
    else replaceConfiguration(current)
  }
  private fun serverNow(): Long = serverClockMillis + (SystemClock.elapsedRealtime() - serverClockElapsed)
  private fun publish(reason: String) {
    val state = JSONObject().put("enabled", NoticeStore.read(this) != null)
      .put("running", started && !stopped).put("connected", connected).put("reason", reason)
      .put("userId", config?.optString("userId") ?: JSONObject.NULL)
      .put("deviceId", config?.optString("deviceId") ?: JSONObject.NULL)
      .put("expiresAt", config?.optString("expiresAt") ?: JSONObject.NULL)
      .put("authVersion", config?.optString("authVersion") ?: JSONObject.NULL)
    try { NoticeModule.event("ChatLocalNoticeState", state) } catch (_: Exception) { }
  }

  fun shutdown(reason: String) {
    if (Looper.myLooper() != Looper.getMainLooper()) { main.post { shutdown(reason) }; return }
    if (stopped) return
    stopped = true; connected = false
    main.removeCallbacks(heartbeat); main.removeCallbacks(reconnect)
    dropSocket(); clearNotices()
    networkCallback?.let { callback -> try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(callback) } catch (_: Exception) { } }
    networkCallback = null
    publish(reason)
    if (started) { if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else stopForeground(true) }
    started = false; stopSelf()
    if (instance === this) instance = null
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    uiVisible = false; currentConnection = null
    foregroundChanged(false)
    // Deliberately keep this receiver running when the app task is dismissed.
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    shutdown("service_destroyed")
    if (instance === this) instance = null
    client.dispatcher.executorService.shutdown()
    client.connectionPool.evictAll()
    super.onDestroy()
  }

  companion object {
    const val START = "com.chatlocal.notices.START"
    const val STOP = "com.chatlocal.notices.STOP"
    const val NOTIFICATION_ID = 4072
    private const val EVENT_ID = 4073
    private const val SERVICE_CHANNEL = "chatlocal-notice-receiver"
    private const val MESSAGE_CHANNEL = "chatlocal-private-messages"
    private const val CALL_CHANNEL = "chatlocal-incoming-calls"
    private const val TAG_PREFIX = "chatlocal-notice:"
    var instance: NoticeService? = null; private set
    @Volatile var uiVisible = false
    @Volatile var currentConnection: String? = null
    fun onForegroundChanged(visible: Boolean) {
      uiVisible = visible
      instance?.let { service -> service.main.post { if (uiVisible == visible) service.foregroundChanged(visible) } }
    }
    private fun messageTag(connection: String) = "${TAG_PREFIX}message:$connection"
    private fun callTag(callId: String) = "${TAG_PREFIX}call:$callId"
    private fun decimal(value: Any?): String? {
      val text = value?.toString() ?: return null
      return if (Regex("^[0-9]{1,19}$").matches(text) && (text == "0" || !text.startsWith("0")) && text.toLongOrNull() != null) text else null
    }
    private fun compareIds(first: String, second: String): Int = if (first.length == second.length) first.compareTo(second) else first.length.compareTo(second.length)
    private fun remember(values: LinkedHashMap<String, Long>, key: String, value: Long) {
      values[key] = value
      while (values.size > 512) values.remove(values.keys.first())
    }
  }
}
