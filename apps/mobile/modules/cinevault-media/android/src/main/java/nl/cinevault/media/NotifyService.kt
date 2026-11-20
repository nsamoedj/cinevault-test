package nl.cinevault.media

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * Keeps notifications coming with the app closed: a foreground service (so
 * Android leaves it running) that keeps one request open to the server,
 * GET /api/notifications/wait, which answers as soon as there is a new
 * notification. No Firebase and no Google account: the phone talks to the
 * own server only. Lost network: it waits (5 s up to 5 minutes, or until
 * Android says there is a network again), and asks again. It starts again
 * after a reboot or an update of the app (NotifyReceiver).
 */
class NotifyService : Service() {
  @Volatile private var stopped = false
  @Volatile private var http: NotifyHttp? = null
  private val wake = LinkedBlockingQueue<Unit>()
  private var thread: Thread? = null
  private var network: ConnectivityManager.NetworkCallback? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val store = NotifyStore(this)
    NotifyPoster.ensureChannels(this, store.config()?.admin ?: false)
    val notification = NotifyPoster.service(this, "Verbinden met de server…")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(
        NotifyPoster.SERVICE_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      )
    } else {
      startForeground(NotifyPoster.SERVICE_ID, notification)
    }
    running = true
    listenToNetwork()
    thread = Thread({ loop() }, "cinevault-notify").apply {
      isDaemon = true
      start()
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (NotifyStore(this).config() == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    // Asked again (the app opened, the network came back): look now.
    wake.offer(Unit)
    return START_STICKY
  }

  override fun onDestroy() {
    stopped = true
    running = false
    connected = false
    http?.cancel()
    wake.offer(Unit)
    network?.let {
      try {
        (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it)
      } catch (_: Exception) {
      }
    }
    super.onDestroy()
  }

  private fun listenToNetwork() {
    val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        // Another network (Wi-Fi → mobile): the open request is on the old one.
        http?.cancel()
        wake.offer(Unit)
      }

      override fun onLost(network: Network) {
        http?.cancel()
      }
    }
    try {
      manager.registerDefaultNetworkCallback(callback)
      network = callback
    } catch (_: Exception) {
      // Without it, the waiting just takes longer.
    }
  }

  /** Waits, unless the network comes back or the service is asked again. */
  private fun pause(ms: Long) {
    wake.clear()
    wake.poll(ms, TimeUnit.MILLISECONDS)
  }

  private fun show(text: String) {
    if (!stopped) NotifyPoster.updateService(this, text)
  }

  private fun loop() {
    val store = NotifyStore(this)
    var failures = 0
    while (!stopped) {
      val config = store.config()
      if (config == null) {
        stopSelf()
        return
      }
      val client = NotifyHttp(config.token)
      http = client
      val server = client.pickServer(config.servers, store.lastServer)
      if (server == null) {
        failures += 1
        connected = false
        store.updateStatus { it.put("error", "De server is niet bereikbaar").put("errorAt", System.currentTimeMillis()) }
        show("Geen verbinding met de server; probeert het zo opnieuw")
        pause(backoff(failures))
        continue
      }
      store.lastServer = server
      try {
        while (!stopped) {
          val seen = store.seen
          val after = seen?.maxOrNull() ?: 0
          val answer = client.request(
            "$server/api/notifications/wait?after=$after&since=${store.since}&timeout=$WAIT_S",
            (WAIT_S + 30) * 1000,
          )
          when (answer.status) {
            200 -> handle(this, server, client, answer)
            204 -> answer.header("x-checked-at")?.toLongOrNull()?.let { store.since = it }
            401 -> {
              // Logged out (or the session was ended): nothing to ask until the app logs in again.
              store.updateStatus { it.put("error", "Uitgelogd: log opnieuw in in de app").put("errorAt", System.currentTimeMillis()) }
              connected = false
              stopSelf()
              return
            }
            404 -> {
              // A server from before /wait: ask every minute instead.
              handle(this, server, client, client.request("$server/api/notifications?limit=30", 30_000))
              markConnected(store, server)
              pause(60_000)
              continue
            }
            else -> throw IOException("De server antwoordde ${answer.status}")
          }
          if (failures > 0 || !connected) markConnected(store, server)
          failures = 0
        }
      } catch (error: Exception) {
        if (stopped) return
        failures += 1
        connected = false
        store.updateStatus {
          it.put("error", error.message ?: error.javaClass.simpleName).put("errorAt", System.currentTimeMillis())
        }
        show("Verbinding verbroken; probeert het zo opnieuw")
        pause(backoff(failures))
      }
    }
  }

  private fun markConnected(store: NotifyStore, server: String) {
    connected = true
    store.updateStatus {
      it.remove("error")
      it.put("server", server).put("connectedAt", System.currentTimeMillis())
    }
    show("Verbonden. Nieuwe meldingen komen meteen binnen.")
  }

  companion object {
    /** How long the server holds a request open: under the few minutes a mobile network keeps an idle connection. */
    private const val WAIT_S = 170
    private val BACKOFF_S = longArrayOf(5, 10, 30, 60, 120, 300)
    private val lock = Any()

    @Volatile var running = false
      private set
    @Volatile var connected = false
      private set

    private fun backoff(failures: Int): Long =
      BACKOFF_S[minOf(failures, BACKOFF_S.size) - 1] * 1000

    /** Starts the service when notifications are on and the phone is logged in; false when Android didn't allow it. */
    fun start(context: Context): Boolean {
      if (NotifyStore(context).config() == null) return false
      val intent = Intent(context, NotifyService::class.java)
      return try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        true
      } catch (_: Exception) {
        // Android 12+ doesn't let an app in the background start one (ForegroundServiceStartNotAllowedException).
        false
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, NotifyService::class.java))
    }

    /** Shows what is new in an answer of the server (a NotificationList); how many. */
    fun handle(context: Context, server: String, http: NotifyHttp, answer: NotifyHttp.Answer): Int {
      if (answer.status != 200) throw IOException("De server antwoordde ${answer.status}")
      val store = NotifyStore(context)
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      val wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cinevault:notify")
      wakeLock.acquire(60_000)
      try {
        val items = JSONObject(answer.body).optJSONArray("items")
        val list = (0 until (items?.length() ?: 0)).map { items!!.getJSONObject(it) }
        val shown: List<JSONObject>
        val fresh: Int
        // One at a time (the service, and a check of the app): nothing shows twice.
        synchronized(lock) {
          val result = NotifyPick.pick(
            list.map {
              NotifyPick.Item(it.getInt("id"), it.optBoolean("read"), NotifyPoster.createdAt(it))
            },
            store.seen,
            System.currentTimeMillis(),
          )
          // Remembered first: an error halfway doesn't show them again.
          store.seen = result.seen
          answer.header("x-checked-at")?.toLongOrNull()?.let { store.since = it }
          val ids = result.show.toSet()
          shown = list.filter { it.getInt("id") in ids }.sortedBy { it.getInt("id") }
          fresh = result.fresh
        }
        for (n in shown) {
          try {
            NotifyPoster.post(context, server, http, n)
          } catch (_: Exception) {
            // One that can't be shown doesn't stop the rest.
          }
        }
        if (shown.isNotEmpty()) NotifyPoster.summarize(context, fresh)
        store.updateStatus {
          it.put("checkedAt", System.currentTimeMillis()).put("shown", fresh)
          if (fresh > 0) it.put("shownAt", System.currentTimeMillis())
        }
        return fresh
      } finally {
        if (wakeLock.isHeld) wakeLock.release()
      }
    }

    /**
     * One check now, outside the service: with the app open, from the
     * background task, or after a test notification. How many it showed.
     */
    fun checkOnce(context: Context): Int {
      val store = NotifyStore(context)
      val config = store.config() ?: return 0
      val http = NotifyHttp(config.token)
      val server = http.pickServer(config.servers, store.lastServer)
        ?: throw IOException("De server is niet bereikbaar")
      store.lastServer = server
      val answer = http.request("$server/api/notifications?limit=30", 30_000)
      if (answer.status == 401) throw IOException("Uitgelogd: log opnieuw in in de app")
      return handle(context, server, http, answer)
    }
  }
}
