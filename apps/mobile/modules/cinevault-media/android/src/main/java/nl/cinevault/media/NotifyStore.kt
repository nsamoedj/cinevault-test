package nl.cinevault.media

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the notification service needs, kept by the app's native side so the
 * service runs without the JavaScript side: the server's addresses, the login
 * (encrypted with a key in the Android Keystore, never in a backup), which
 * notifications were shown, and how the last check went (for Profiel).
 */
class NotifyStore(context: Context) {
  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  data class Config(
    val servers: List<String>,
    val token: String,
    val admin: Boolean,
  )

  var enabled: Boolean
    get() = prefs.getBoolean("enabled", false)
    set(value) = prefs.edit().putBoolean("enabled", value).apply()

  /** null: off, logged out, or no server. */
  fun config(): Config? {
    if (!enabled) return null
    val token = prefs.getString("token", null)?.let { decrypt(it) } ?: return null
    val servers = readStrings(prefs.getString("servers", null))
    if (servers.isEmpty()) return null
    return Config(servers, token, prefs.getBoolean("admin", false))
  }

  fun configure(servers: List<String>, token: String?, admin: Boolean) {
    val editor = prefs.edit()
      .putString("servers", JSONArray(servers).toString())
      .putBoolean("admin", admin)
    if (token == null) editor.remove("token") else editor.putString("token", encrypt(token))
    editor.apply()
  }

  /** Logged out, or switched off: forgets the login and what was shown. */
  fun forget() {
    prefs.edit().remove("token").remove("seen").remove("since").putBoolean("enabled", false).apply()
  }

  /** Ids already shown (or there before the phone started): null the first time. */
  var seen: List<Int>?
    get() = prefs.getString("seen", null)?.let { readInts(it) }
    set(value) {
      if (value == null) prefs.edit().remove("seen").apply()
      else prefs.edit().putString("seen", JSONArray(value).toString()).apply()
    }

  /** The server's time of its last answer: what became deliverable after it is new. */
  var since: Long
    get() = prefs.getLong("since", 0)
    set(value) = prefs.edit().putLong("since", value).apply()

  /** The address that answered last: tried first. */
  var lastServer: String?
    get() = prefs.getString("lastServer", null)
    set(value) = prefs.edit().putString("lastServer", value).apply()

  /** For Profiel → Meldingen. */
  fun status(): JSONObject = JSONObject(prefs.getString("status", null) ?: "{}")

  fun updateStatus(change: (JSONObject) -> Unit) {
    val status = status()
    change(status)
    prefs.edit().putString("status", status.toString()).apply()
  }

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build(),
    )
    return generator.generateKey()
  }

  private fun encrypt(text: String): String {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val data = cipher.doFinal(text.toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
      Base64.encodeToString(data, Base64.NO_WRAP)
  }

  /** null when it can't be read (a restored backup on another phone: the key isn't there). */
  private fun decrypt(stored: String): String? = try {
    val (iv, data) = stored.split(":", limit = 2)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
    String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), Charsets.UTF_8)
  } catch (_: Exception) {
    null
  }

  companion object {
    private const val PREFS = "cinevault.notify"
    private const val KEY_ALIAS = "cinevault.notify"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    fun readStrings(json: String?): List<String> = try {
      val array = JSONArray(json ?: "[]")
      (0 until array.length()).mapNotNull { array.optString(it).takeIf { s -> s.isNotBlank() } }
    } catch (_: Exception) {
      emptyList()
    }

    fun readInts(json: String): List<Int>? = try {
      val array = JSONArray(json)
      (0 until array.length()).map { array.getInt(it) }
    } catch (_: Exception) {
      null
    }
  }
}
