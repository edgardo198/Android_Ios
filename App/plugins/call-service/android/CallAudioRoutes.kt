package com.chatlocal.calls

import android.Manifest
import android.content.*
import android.content.pm.PackageManager
import android.media.*
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.*

@Suppress("DEPRECATION")
class CallAudioRoutes(private val context: Context, private val video: Boolean,
  private val changed: () -> Unit, private val focusLost: () -> Unit) {
  private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val main = Handler(Looper.getMainLooper())
  private val previousMode = audio.mode
  private val previousSpeaker = audio.isSpeakerphoneOn
  private val previousSco = audio.isBluetoothScoOn
  private var focus: AudioFocusRequest? = null
  private var modern: ModernRoutes? = null
  private var closed = false
  private var requestedSco = false
  private var scoConnected = false
  private var scoPromise: Promise? = null
  private var scoTimeout: Runnable? = null
  private var receiverRegistered = false
  private val focusListener = AudioManager.OnAudioFocusChangeListener { if (it < 0 && !closed) focusLost() }
  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) { if (!closed) changed() }
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
      if (closed) return
      if (Build.VERSION.SDK_INT < 31 && requestedSco && !legacyDevices().any { routeType(it.type) == "bluetooth" }) {
        val waiting = scoPromise; scoPromise = null
        leaveSco()
        waiting?.reject("CALL_AUDIO_ROUTE_FAILED", "Los audífonos Bluetooth se desconectaron.")
      }
      changed()
    }
  }
  private val scoReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (closed) return
      when (intent?.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)) {
        AudioManager.SCO_AUDIO_STATE_CONNECTED -> {
          scoConnected = true
          if (requestedSco) {
            audio.isBluetoothScoOn = true
            scoTimeout?.let { main.removeCallbacks(it) }; scoTimeout = null
            scoPromise?.resolve(snapshot()); scoPromise = null
          }
          changed()
        }
        AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> {
          scoConnected = false
          if (requestedSco) {
            val promise = scoPromise; scoPromise = null
            leaveSco()
            promise?.reject("CALL_AUDIO_ROUTE_FAILED", "No se pudo conectar el audio Bluetooth.")
            changed()
          }
        }
      }
    }
  }

  fun start() {
    val granted = if (Build.VERSION.SDK_INT >= 26) {
      AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setAcceptsDelayedFocusGain(false).setOnAudioFocusChangeListener(focusListener, main).build()
        .also { focus = it }.let { audio.requestAudioFocus(it) }
    } else audio.requestAudioFocus(focusListener, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    check(granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "El audio está ocupado por otra aplicación." }
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    audio.registerAudioDeviceCallback(devices, main)
    if (Build.VERSION.SDK_INT >= 31) {
      modern = ModernRoutes(context, audio, changed)
      val routes = modern!!.devices()
      val preferred = routes.firstOrNull { routeType(it.type) == "wired" }
        ?: routes.firstOrNull { routeType(it.type) == if (video) "speaker" else "earpiece" }
        ?: routes.firstOrNull { routeType(it.type) == "speaker" }
      if (preferred != null) check(modern!!.select(preferred.id)) { "No se pudo preparar la salida de audio." }
    } else {
      val sticky = context.registerReceiver(scoReceiver, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
      receiverRegistered = true
      scoConnected = sticky?.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1) == AudioManager.SCO_AUDIO_STATE_CONNECTED
      audio.isSpeakerphoneOn = video && !legacyDevices().any { routeType(it.type) == "wired" }
    }
  }

  fun snapshot(): WritableMap {
    val list = Arguments.createArray()
    val routes = if (modern != null) modern!!.devices() else legacyDevices()
    val current = if (modern != null) modern!!.selected()?.takeIf { id -> routes.any { it.id == id } }?.let { "device:$it" }
      else legacySelectedRoute(routes)
    routes.filter { routeType(it.type) != null }.forEach { device ->
      val type = routeType(device.type)!!
      val id = if (modern != null) "device:${device.id}" else when (type) {
        "speaker", "earpiece", "bluetooth" -> type
        else -> "wired:${device.id}"
      }
      // Legacy bluetooth devices can expose the same SCO sink more than once.
      if (modern == null && type == "bluetooth" && (0 until list.size()).any { list.getMap(it)?.getString("id") == id }) return@forEach
      list.pushMap(Arguments.createMap().apply {
        putString("id", id); putString("type", type)
        putString("label", when (type) { "speaker" -> "Altavoz"; "earpiece" -> "Auricular"; "bluetooth" -> "Bluetooth"; else -> "Audífonos conectados" })
      })
    }
    return Arguments.createMap().apply { putArray("routes", list); putString("selectedRouteId", current) }
  }

  fun select(id: String, promise: Promise) {
    if (closed) { promise.reject("CALL_NATIVE_STOPPED", "La llamada ya terminó."); return }
    if (scoPromise != null) { promise.reject("CALL_AUDIO_ROUTE_BUSY", "Espera a que termine el cambio de audio."); return }
    try {
      if (modern != null) {
        val deviceId = id.removePrefix("device:").toIntOrNull() ?: error("Salida de audio no válida.")
        val device = modern!!.devices().firstOrNull { it.id == deviceId } ?: error("La salida de audio ya no está disponible.")
        if (routeType(device.type) == "bluetooth" && Build.VERSION.SDK_INT >= 31) {
          check(context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) { "Permite el acceso a Bluetooth para usar los audífonos." }
        }
        check(modern!!.select(deviceId)) { "No se pudo cambiar la salida de audio." }
        changed(); promise.resolve(snapshot()); return
      }
      val device = legacyDevices().firstOrNull { when (routeType(it.type)) {
        "speaker", "earpiece", "bluetooth" -> routeType(it.type) == id
        else -> "wired:${it.id}" == id
      } } ?: error("La salida de audio ya no está disponible.")
      if (routeType(device.type) == "bluetooth") {
        check(audio.isBluetoothScoAvailableOffCall) { "Este dispositivo no permite audio Bluetooth de llamada." }
        requestedSco = true; scoPromise = promise
        audio.isSpeakerphoneOn = false
        audio.startBluetoothSco()
        if (scoConnected) {
          audio.isBluetoothScoOn = true; scoPromise = null
          changed(); promise.resolve(snapshot())
        } else {
          scoTimeout = Runnable {
            val waiting = scoPromise; scoPromise = null
            leaveSco(); changed()
            waiting?.reject("CALL_AUDIO_ROUTE_FAILED", "No se pudo conectar el audio Bluetooth.")
          }.also { main.postDelayed(it, 6000) }
        }
      } else {
        leaveSco(); audio.isSpeakerphoneOn = id == "speaker"
        changed(); promise.resolve(snapshot())
      }
    } catch (error: Exception) {
      if (scoPromise === promise) { scoPromise = null; leaveSco() }
      promise.reject("CALL_AUDIO_ROUTE_FAILED", error.message ?: "No se pudo cambiar la salida de audio.", error)
    }
  }

  private fun legacyDevices() = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter { routeType(it.type) != null }
  private fun legacySelectedRoute(devices: List<AudioDeviceInfo>): String? {
    if (scoConnected && audio.isBluetoothScoOn && devices.any { routeType(it.type) == "bluetooth" }) return "bluetooth"
    if (audio.isSpeakerphoneOn && devices.any { routeType(it.type) == "speaker" }) return "speaker"
    devices.firstOrNull { routeType(it.type) == "wired" }?.let { return "wired:${it.id}" }
    if (devices.any { routeType(it.type) == "earpiece" }) return "earpiece"
    if (devices.any { routeType(it.type) == "speaker" }) return "speaker"
    return null
  }
  private fun leaveSco() {
    scoTimeout?.let { main.removeCallbacks(it) }; scoTimeout = null
    if (requestedSco) { try { audio.stopBluetoothSco() } catch (_: Exception) { } }
    requestedSco = false
    audio.isBluetoothScoOn = false
  }
  fun close() {
    if (closed) return
    closed = true
    scoPromise?.reject("CALL_NATIVE_STOPPED", "La llamada ya terminó."); scoPromise = null
    try { audio.unregisterAudioDeviceCallback(devices) } catch (_: Exception) { }
    if (receiverRegistered) { try { context.unregisterReceiver(scoReceiver) } catch (_: Exception) { }; receiverRegistered = false }
    try { modern?.close(); modern = null } catch (_: Exception) { }
    if (Build.VERSION.SDK_INT < 31) {
      try { leaveSco(); audio.isSpeakerphoneOn = previousSpeaker; audio.isBluetoothScoOn = previousSco } catch (_: Exception) { }
    }
    try { audio.mode = previousMode } catch (_: Exception) { }
    try { if (Build.VERSION.SDK_INT >= 26) focus?.let { audio.abandonAudioFocusRequest(it) } else audio.abandonAudioFocus(focusListener) } catch (_: Exception) { }
  }

  companion object {
    fun routeType(type: Int): String? = when (type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_HEARING_AID -> "bluetooth"
      AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE -> "wired"
      else -> null
    }
  }
  // This class is instantiated only on API31+, avoiding legacy SCO changes on
  // modern Android and keeping those absent platform types out of old devices.
  private class ModernRoutes(context: Context, private val audio: AudioManager, changed: () -> Unit) {
    private val listener = AudioManager.OnCommunicationDeviceChangedListener { changed() }
    init { audio.addOnCommunicationDeviceChangedListener(context.mainExecutor, listener) }
    fun devices() = audio.availableCommunicationDevices.filter { it.isSink && routeType(it.type) != null }
    fun selected() = audio.communicationDevice?.id
    fun select(id: Int) = devices().firstOrNull { it.id == id }?.let { audio.setCommunicationDevice(it) } ?: false
    fun close() {
      audio.removeOnCommunicationDeviceChangedListener(listener)
      audio.clearCommunicationDevice()
    }
  }
}
