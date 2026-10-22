package com.chatlocal.calls

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.*
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class CallService : HeadlessJsTaskService() {
  var token: String = ""; private set
  private var kind = "audio"
  private var peerName = "Contacto"
  private var callId: String? = null
  private var muted = false
  private var videoEnabled = true
  private var stopped = false
  private var lastPulse = 0L
  private var audio: CallAudioRoutes? = null
  private val main = Handler(Looper.getMainLooper())
  private val watchdog = object : Runnable {
    override fun run() {
      if (stopped) return
      if (SystemClock.elapsedRealtime() - lastPulse > 45000) shutdown("runtime_unresponsive")
      else main.postDelayed(this, 15000)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val requested = intent?.getStringExtra("token") ?: return START_NOT_STICKY
    if (intent.action == HANGUP) {
      if (requested == token && !stopped) { CallSessionModule.event("ChatLocalCallHangup", token); shutdown("notification_hangup") }
      else if (token.isEmpty()) stopSelf(startId)
      return START_NOT_STICKY
    }
    if (intent.action != START || !CallSessionModule.expected(requested)) {
      if (token.isEmpty()) stopSelf(startId)
      return START_NOT_STICKY
    }
    if (token.isNotEmpty()) return START_NOT_STICKY
    token = requested
    kind = intent.getStringExtra("kind") ?: "audio"
    peerName = (intent.getStringExtra("peerName") ?: "Contacto").take(80)
    callId = intent.getStringExtra("callId")
    instance = this
    try {
      if (Build.VERSION.SDK_INT >= 26) {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
          NotificationChannel(CHANNEL, "Llamadas activas", NotificationManager.IMPORTANCE_LOW).apply { setSound(null, null); enableVibration(false) })
      }
      val notification = notification()
      if (Build.VERSION.SDK_INT >= 30) {
        val types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or if (kind == "video") ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0
        startForeground(NOTIFICATION_ID, notification, types)
      } else if (Build.VERSION.SDK_INT >= 29 && kind == "video") {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
      } else startForeground(NOTIFICATION_ID, notification)
      audio = CallAudioRoutes(this, kind == "video", { publishRoutes() }, { shutdown("audio_focus_lost") })
      audio!!.start()
      pulse(); main.postDelayed(watchdog, 15000)
      // Headless active tasks keep RN86 JavaTimerManager running while Host is
      // paused; a foreground service alone does not keep JS heartbeat timers.
      startTask(HeadlessJsTaskConfig("chatlocal.callKeepAlive", Arguments.createMap().apply { putString("token", token) }, 0, true))
    } catch (_: Exception) { shutdown("start_failed") }
    // Never restart captures or a call automatically after process death.
    return START_NOT_STICKY
  }

  fun pulse() { if (!stopped) lastPulse = SystemClock.elapsedRealtime() }
  fun routes(): WritableMap = audio?.snapshot() ?: Arguments.createMap().apply { putArray("routes", Arguments.createArray()); putNull("selectedRouteId") }
  fun selectRoute(id: String, promise: Promise) { audio?.select(id, promise) ?: promise.reject("CALL_NATIVE_STOPPED", "La llamada ya terminó.") }
  private fun publishRoutes() { if (!stopped) CallSessionModule.event("ChatLocalCallAudioRoutes", token, routes()) }
  fun update(options: ReadableMap) {
    if (stopped) return
    if (options.hasKey("peerName") && !options.isNull("peerName")) peerName = (options.getString("peerName") ?: "Contacto").take(80)
    if (options.hasKey("callId") && !options.isNull("callId")) callId = options.getString("callId")
    if (options.hasKey("muted")) muted = options.getBoolean("muted")
    if (options.hasKey("videoEnabled")) videoEnabled = options.getBoolean("videoEnabled")
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification())
  }
  private fun notification(): Notification {
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val launch = packageManager.getLaunchIntentForPackage(packageName)!!.apply { addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP) }
    val returnApp = PendingIntent.getActivity(this, 101, launch, flags)
    val hangup = PendingIntent.getService(this, 102, Intent(this, CallService::class.java).apply { action = HANGUP; putExtra("token", token) }, flags)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    return builder.setSmallIcon(android.R.drawable.sym_call_incoming).setContentTitle(peerName)
      .setContentText(if (muted) "Llamada activa · Micrófono silenciado" else if (kind == "video" && videoEnabled) "Videollamada activa" else "Llamada activa")
      .setContentIntent(returnApp).setOngoing(true).setCategory(Notification.CATEGORY_CALL).setOnlyAlertOnce(true)
      .setVisibility(Notification.VISIBILITY_PRIVATE).addAction(Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "COLGAR", hangup).build()).build()
  }
  fun shutdown(reason: String) {
    if (stopped) return
    stopped = true
    main.removeCallbacks(watchdog)
    CallSessionModule.ended(token, reason)
    audio?.close(); audio = null
    if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else stopForeground(true)
    stopSelf()
  }
  // Swiping the UI keeps the active foreground call and its headless JS task.
  // Process death still closes media; we never restart microphone/camera capture.
  override fun onTaskRemoved(rootIntent: Intent?) { super.onTaskRemoved(rootIntent) }
  override fun onDestroy() {
    shutdown("service_destroyed")
    if (instance === this) instance = null
    super.onDestroy()
  }
  companion object {
    const val START = "com.chatlocal.calls.START"
    const val HANGUP = "com.chatlocal.calls.HANGUP"
    const val CHANNEL = "chatlocal-active-call"
    const val NOTIFICATION_ID = 4071
    var instance: CallService? = null; private set
  }
}
