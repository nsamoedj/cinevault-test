package nl.cinevault.media

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/** The few requests the notification service makes, with the login of this phone. */
class NotifyHttp(private val token: String) {
  class Answer(val status: Int, val body: String, private val headers: Map<String?, List<String>>) {
    fun header(name: String): String? =
      headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value?.firstOrNull()
  }

  /** The request in progress: a lost network closes it (cancel), the service then reconnects. */
  @Volatile private var current: HttpURLConnection? = null

  fun cancel() {
    current?.disconnect()
  }

  private fun open(url: String, method: String, timeoutMs: Int): HttpURLConnection {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.requestMethod = method
    connection.connectTimeout = minOf(timeoutMs, CONNECT_TIMEOUT_MS)
    connection.readTimeout = timeoutMs
    connection.instanceFollowRedirects = true
    connection.setRequestProperty("Authorization", "Bearer $token")
    connection.setRequestProperty("User-Agent", USER_AGENT)
    connection.setRequestProperty("Accept", "application/json")
    return connection
  }

  @Throws(IOException::class)
  fun request(url: String, timeoutMs: Int, method: String = "GET"): Answer {
    val connection = open(url, method, timeoutMs)
    current = connection
    try {
      if (method == "PUT" || method == "POST") {
        connection.doOutput = true
        connection.setFixedLengthStreamingMode(0)
        connection.outputStream.close()
      }
      val status = connection.responseCode
      val stream = if (status >= 400) connection.errorStream else connection.inputStream
      val body = stream?.use { read(it, MAX_JSON) }?.toString(Charsets.UTF_8) ?: ""
      return Answer(status, body, connection.headerFields)
    } finally {
      connection.disconnect()
      if (current === connection) current = null
    }
  }

  /** An image from the server (with the login), or null. */
  fun bytes(url: String, max: Int = MAX_IMAGE): ByteArray? = try {
    val connection = open(url, "GET", IMAGE_TIMEOUT_MS)
    connection.setRequestProperty("Accept", "image/*")
    try {
      if (connection.responseCode != 200) null else connection.inputStream.use { read(it, max) }
    } finally {
      connection.disconnect()
    }
  } catch (_: Exception) {
    null
  }

  /**
   * The first address that answers /api/health (home first when it answered
   * last, else in the app's order): the domain away from home, the home
   * address at home.
   */
  fun pickServer(servers: List<String>, last: String?): String? {
    val order = (listOfNotNull(last?.takeIf { it in servers }) + servers).distinct()
    for (server in order) {
      try {
        val connection = URL("${server.trimEnd('/')}/api/health").openConnection() as HttpURLConnection
        connection.connectTimeout = HEALTH_TIMEOUT_MS
        connection.readTimeout = HEALTH_TIMEOUT_MS
        connection.setRequestProperty("User-Agent", USER_AGENT)
        try {
          if (connection.responseCode == 200) return server.trimEnd('/')
        } finally {
          connection.disconnect()
        }
      } catch (_: Exception) {
        // The next one.
      }
    }
    return null
  }

  private fun read(input: InputStream, max: Int): ByteArray? {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(16 * 1024)
    while (true) {
      val n = input.read(buffer)
      if (n < 0) break
      out.write(buffer, 0, n)
      if (out.size() > max) return null
    }
    return out.toByteArray()
  }

  companion object {
    const val USER_AGENT = "CineVault Android (meldingen)"
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val HEALTH_TIMEOUT_MS = 6_000
    private const val IMAGE_TIMEOUT_MS = 20_000
    private const val MAX_JSON = 2 * 1024 * 1024
    private const val MAX_IMAGE = 6 * 1024 * 1024
  }
}
