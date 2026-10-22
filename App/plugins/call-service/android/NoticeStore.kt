package com.chatlocal.calls

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.URI
import java.security.KeyStore
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Device-scoped notice credentials. JWTs and message content are never stored. */
object NoticeStore {
  private const val PREFS = "chatlocal_notice_secure"
  private const val CONFIG = "encrypted_config"
  private const val KEY_ALIAS = "chatlocal.notice.config.v1"

  @Synchronized fun configure(context: Context, options: JSONObject) {
    if (!options.optBoolean("enabled", false)) { clear(context); return }
    val config = validated(options)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val ciphertext = cipher.doFinal(config.toString().toByteArray(Charsets.UTF_8))
    val envelope = JSONObject().put("version", 1)
      .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
      .put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
    if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(CONFIG, envelope.toString()).commit()) {
      throw IllegalStateException("No se pudo guardar la configuración de avisos.")
    }
  }

  @Synchronized fun read(context: Context): JSONObject? {
    val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val value = preferences.getString(CONFIG, null) ?: return null
    return try {
      require(value.length <= 32768)
      val envelope = JSONObject(value)
      require(envelope.getInt("version") == 1)
      val iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)
      val encrypted = Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP)
      require(iv.size == 12 && encrypted.size in 17..16384)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
      validated(JSONObject(String(cipher.doFinal(encrypted), Charsets.UTF_8)))
    } catch (_: Exception) {
      // A restored backup has no corresponding AndroidKeyStore key. Corrupted
      // or invalidated credentials are discarded instead of falling back to plaintext.
      preferences.edit().remove(CONFIG).commit()
      null
    }
  }

  @Synchronized fun clear(context: Context) {
    if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(CONFIG).commit()) {
      throw IllegalStateException("No se pudo retirar la credencial de avisos.")
    }
  }

  @Synchronized fun clearIfMatches(context: Context, expected: JSONObject): Boolean {
    val current = read(context) ?: return false
    if (listOf("userId", "deviceId", "token", "wsUrl", "authVersion").any { current.optString(it) != expected.optString(it) }) return false
    clear(context)
    return true
  }

  fun timestampMillis(value: String): Long? {
    val match = Regex("^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d{1,9}))?(Z|[+-]\\d{2}:\\d{2})$").matchEntire(value) ?: return null
    val fraction = match.groupValues[2].take(3).padEnd(3, '0')
    val zone = if (match.groupValues[3] == "Z") "+0000" else match.groupValues[3].replace(":", "")
    val normalized = "${match.groupValues[1]}.$fraction$zone"
    val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US).apply { isLenient = false }
    val position = ParsePosition(0)
    val date = parser.parse(normalized, position) ?: return null
    return if (position.index == normalized.length) date.time else null
  }

  private fun validated(options: JSONObject): JSONObject {
    try {
      require(options.opt("enabled") == true)
      val url = options.getString("wsUrl")
      require(url.length <= 2048)
      val uri = URI(url)
      require(uri.scheme in listOf("ws", "wss") && !uri.host.isNullOrBlank())
      require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
      require(uri.rawPath == "/ws/device-events/" && uri.port in -1..65535)
      val token = options.getString("token")
      require(token.length in 40..200 && token.startsWith("ndv_") && Regex("^[A-Za-z0-9_-]+$").matches(token))
      val userId = options.getString("userId")
      require(Regex("^[1-9][0-9]{0,18}$").matches(userId) && userId.toLongOrNull() != null)
      val deviceId = options.getString("deviceId")
      require(deviceId.length == 36 && UUID.fromString(deviceId).toString() == deviceId.lowercase(Locale.ROOT))
      val expiresAt = options.getString("expiresAt")
      require(timestampMillis(expiresAt) != null)
      val result = JSONObject().put("enabled", true).put("wsUrl", url).put("token", token)
        .put("userId", userId).put("deviceId", deviceId.lowercase(Locale.ROOT)).put("expiresAt", expiresAt)
      if (options.has("authVersion")) {
        val version = options.getString("authVersion")
        require(Regex("^[0-9]{1,19}$").matches(version) && version.toLongOrNull() != null)
        result.put("authVersion", version)
      }
      if (options.has("username") && !options.isNull("username")) {
        val username = options.getString("username")
        require(username.isNotEmpty() && username.length <= 150)
        result.put("username", username)
      }
      return result
    } catch (_: Exception) {
      throw IllegalArgumentException("La configuración de avisos no es válida.")
    }
  }

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(false).build())
    }.generateKey()
  }
}
