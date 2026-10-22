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
import com.oney.WebRTCModule.WebRTCModule
import java.lang.ref.WeakReference

class CallSessionModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val main = Handler(Looper.getMainLooper())
  override fun getName() = "ChatLocalCallSession"

  init {
    main.post {
      val previous = current?.get()
      if (previous != null && previous !== this) {
        CallService.instance?.shutdown("runtime_stopped")
        previous.cancelPending()
        previous.releaseMedia()
        ownerToken = null
      }
      current = WeakReference(this)
    }
  }

  @ReactMethod fun addListener(name: String) = Unit
  @ReactMethod fun removeListeners(count: Double) = Unit

  @ReactMethod fun start(options: ReadableMap, promise: Promise) {
    main.post {
      val token = options.getString("token") ?: ""
      val kind = options.getString("kind") ?: ""
      try {
        require(token.matches(Regex("[a-zA-Z0-9:-]{8,128}")) && kind in listOf("audio", "video"))
        check(context.lifecycleState == LifecycleState.RESUMED && context.currentActivity != null) { "Abre la app para iniciar la llamada." }
        check(hasPermission(Manifest.permission.RECORD_AUDIO)) { "Permite el acceso al micrófono antes de iniciar la llamada." }
        if (kind == "video") check(hasPermission(Manifest.permission.CAMERA)) { "Permite el acceso a la cámara antes de iniciar la llamada." }
        if (Build.VERSION.SDK_INT >= 33) check(hasPermission(Manifest.permission.POST_NOTIFICATIONS)) { "Permite las notificaciones para controlar la llamada con la pantalla bloqueada." }
        check(ownerToken == null && CallService.instance == null) { "Espera a que termine la llamada anterior." }
        val ownResources = NativeResources.read(options.getMap("nativeResources"))
          ?: error("No se pudieron proteger los recursos de la llamada.")
        ownerToken = token
        resources = ownResources
        pending = promise
        startDeadline = Runnable {
          if (ownerToken == token && pending != null) {
            pending?.reject("CALL_NATIVE_START_FAILED", "No se pudo mantener la llamada en segundo plano.")
            pending = null
            CallService.instance?.shutdown("start_failed")
            if (ownerToken == token) { releaseMedia(); ownerToken = null }
          }
        }.also { main.postDelayed(it, 8000) }
        val intent = Intent(context, CallService::class.java).apply {
          action = CallService.START
          putExtra("token", token); putExtra("kind", kind)
          putExtra("peerName", options.stringOrNull("peerName") ?: "Contacto")
          putExtra("callId", options.stringOrNull("callId"))
        }
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
      } catch (error: Exception) {
        if (ownerToken == token) {
          startDeadline?.let { main.removeCallbacks(it) }; startDeadline = null
          pending = null
          releaseMedia(); ownerToken = null
        }
        promise.reject("CALL_NATIVE_START_FAILED", error.message ?: "No se pudo iniciar el servicio de llamada.", error)
      }
    }
  }

  @ReactMethod fun confirmKeepAlive(token: String, promise: Promise) {
    main.post {
      val service = CallService.instance
      if (ownerToken != token || service?.token != token) { promise.resolve(false); return@post }
      service.pulse()
      startDeadline?.let { main.removeCallbacks(it) }; startDeadline = null
      pending?.resolve(service.routes()); pending = null
      promise.resolve(true)
    }
  }

  @ReactMethod fun heartbeat(token: String) { main.post { if (ownerToken == token) CallService.instance?.pulse() } }

  @ReactMethod fun update(token: String, options: ReadableMap, promise: Promise) {
    main.post {
      val service = CallService.instance
      if (ownerToken != token || service?.token != token) { promise.reject("CALL_NATIVE_STOPPED", "La llamada ya terminó."); return@post }
      try {
        if (options.hasKey("nativeResources")) {
          val updated = NativeResources.read(options.getMap("nativeResources")) ?: error("Recursos no válidos.")
          check(updated.peerConnectionId == resources?.peerConnectionId && updated.streamId == resources?.streamId) { "La llamada cambió." }
          resources = updated
        }
        service.update(options)
        promise.resolve(true)
      } catch (error: Exception) { promise.reject("CALL_NATIVE_UPDATE_FAILED", "No se pudo actualizar la llamada.", error) }
    }
  }

  @ReactMethod fun stop(token: String, promise: Promise) {
    main.post {
      if (ownerToken == token) {
        cancelPending()
        val service = CallService.instance
        if (service?.token == token) service.shutdown("stopped")
        else { ownerToken = null; releaseMedia() }
      }
      promise.resolve(true)
    }
  }

  @ReactMethod fun getAudioRoutes(token: String, promise: Promise) {
    main.post {
      val service = CallService.instance
      if (ownerToken != token || service?.token != token) promise.reject("CALL_NATIVE_STOPPED", "La llamada ya terminó.")
      else promise.resolve(service.routes())
    }
  }

  @ReactMethod fun selectAudioRoute(token: String, id: String, promise: Promise) {
    main.post {
      val service = CallService.instance
      if (ownerToken != token || service?.token != token) promise.reject("CALL_NATIVE_STOPPED", "La llamada ya terminó.")
      else service.selectRoute(id, promise)
    }
  }

  private fun hasPermission(name: String) = context.checkSelfPermission(name) == PackageManager.PERMISSION_GRANTED
  private fun cancelPending() {
    startDeadline?.let { main.removeCallbacks(it) }; startDeadline = null
    pending?.reject("CALL_NATIVE_CANCELLED", "La llamada se cerró."); pending = null
  }
  private fun releaseMedia() {
    val ids = resources ?: return
    resources = null
    val rtc = context.getNativeModule(WebRTCModule::class.java) ?: return
    try { rtc.peerConnectionClose(ids.peerConnectionId) } catch (_: Exception) { }
    ids.trackIds.forEach { try { rtc.mediaStreamTrackRelease(it) } catch (_: Exception) { } }
    try { rtc.mediaStreamRelease(ids.streamId) } catch (_: Exception) { }
  }
  private fun emit(name: String, payload: WritableMap) {
    if (context.hasActiveReactInstance()) context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, payload)
  }

  override fun invalidate() {
    main.post { if (current?.get() === this) { CallService.instance?.shutdown("runtime_stopped"); cancelPending(); ownerToken = null; releaseMedia(); current = null } }
    super.invalidate()
  }

  companion object {
    private var current: WeakReference<CallSessionModule>? = null
    private var ownerToken: String? = null
    private var pending: Promise? = null
    private var startDeadline: Runnable? = null
    private var resources: NativeResources? = null
    fun expected(token: String) = ownerToken == token
    fun event(name: String, token: String, payload: WritableMap = Arguments.createMap()) {
      payload.putString("token", token)
      current?.get()?.emit(name, payload)
    }
    fun ended(token: String, reason: String) {
      if (ownerToken != token) return
      current?.get()?.cancelPending()
      current?.get()?.releaseMedia()
      ownerToken = null
      event("ChatLocalCallServiceStopped", token, Arguments.createMap().apply { putString("reason", reason) })
    }
  }
}

private fun ReadableMap.stringOrNull(key: String) = if (hasKey(key) && !isNull(key)) getString(key) else null
private data class NativeResources(val peerConnectionId: Int, val streamId: String, val trackIds: List<String>) {
  companion object {
    fun read(value: ReadableMap?): NativeResources? {
      if (value == null) return null
      val peer = value.getInt("peerConnectionId")
      val stream = value.getString("streamId") ?: return null
      val ids = value.getArray("trackIds") ?: return null
      require(peer >= 0 && stream.length in 1..200 && ids.size() in 1..4)
      val tracks = (0 until ids.size()).map { ids.getString(it) ?: "" }
      require(tracks.all { it.length in 1..200 })
      return NativeResources(peer, stream, tracks)
    }
  }
}
