package nl.cinevault.media

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.widget.Toast

/**
 * Starts the notification service again after a reboot and after an update
 * of the app, and handles "+ Mijn lijst" on a notification (without opening
 * the app).
 */
class NotifyReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> NotifyService.start(context)
      ADD_TO_LIST -> addToList(context, intent)
    }
  }

  private fun addToList(context: Context, intent: Intent) {
    val itemId = intent.getStringExtra(EXTRA_ITEM) ?: return
    val notification = intent.getIntExtra(EXTRA_NOTIFICATION, 0)
    val pending = goAsync()
    val app = context.applicationContext
    Thread {
      val added = try {
        val store = NotifyStore(app)
        val config = store.config()
        val server = config?.let { NotifyHttp(it.token).pickServer(it.servers, store.lastServer) }
        if (config == null || server == null) {
          false
        } else {
          NotifyHttp(config.token).request("$server/api/my-list/$itemId", 20_000, "PUT").status in 200..299
        }
      } catch (_: Exception) {
        false
      }
      if (added) {
        (app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notification)
        NotifyPoster.summarize(app, 0)
      }
      Handler(Looper.getMainLooper()).post {
        Toast.makeText(
          app,
          if (added) "Toegevoegd aan Mijn lijst" else "Mijn lijst: de server is niet bereikbaar",
          Toast.LENGTH_SHORT,
        ).show()
        pending.finish()
      }
    }.start()
  }

  companion object {
    const val ADD_TO_LIST = "nl.cinevault.media.ADD_TO_LIST"
    const val EXTRA_ITEM = "itemId"
    const val EXTRA_NOTIFICATION = "notificationId"
  }
}
