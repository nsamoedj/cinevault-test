package nl.cinevault.media

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.StyleSpan
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import org.json.JSONObject

/**
 * The phone's notifications, in CineVault's look: the title's poster small
 * beside the text, its episode picture (or backdrop) large when opened, a
 * brass accent, a label per kind ("Nieuwe aflevering"), buttons that go
 * straight to what it is about (Afspelen, Bekijken, + Mijn lijst), and all of
 * them in one group with a summary.
 */
object NotifyPoster {
  const val GROUP = "nl.cinevault.notifications"
  const val SUMMARY_ID = Int.MAX_VALUE - 1
  const val SERVICE_ID = Int.MAX_VALUE - 2
  const val SERVICE_CHANNEL = "service"
  /** CineVault's brass. */
  private const val BRASS = 0xFFE0B04F.toInt()

  /** The channels (the same ids the app used before, so Android's settings for them stay). */
  private val CHANNEL = mapOf(
    "new-episodes" to "episodes",
    "airing" to "episodes",
    "recommended" to "tips",
    "new-login" to "account",
    "admin-unmatched" to "admin",
    "admin-transcoder" to "admin",
    "admin-health" to "admin",
    "request-new" to "admin",
    "request-update" to "requests",
    "test" to "account",
  )

  /** The small label in the header, per kind. */
  private val LABEL = mapOf(
    "new-episodes" to "Nieuwe aflevering",
    "airing" to "Vandaag",
    "recommended" to "Aanrader",
    "new-login" to "Account",
    "admin-unmatched" to "Beheer",
    "admin-transcoder" to "Beheer",
    "admin-health" to "Gezondheid",
    "request-new" to "Nieuw verzoek",
    "request-update" to "Je verzoek",
    "test" to "Test",
  )

  private fun manager(context: Context) =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  /** The "Beheer" channel only for admins: members see nothing of the admin side. */
  fun ensureChannels(context: Context, admin: Boolean) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = manager(context)
    fun channel(id: String, name: String, description: String, importance: Int) =
      NotificationChannel(id, name, importance).apply {
        this.description = description
        lightColor = BRASS
        enableLights(importance >= NotificationManager.IMPORTANCE_DEFAULT)
      }
    val channels = mutableListOf(
      channel("episodes", "Nieuwe afleveringen", "Een nieuwe aflevering van een serie die je volgt", NotificationManager.IMPORTANCE_HIGH),
      channel("tips", "Aanraders", "Nieuwe titels die passen bij wat je keek", NotificationManager.IMPORTANCE_DEFAULT),
      channel("account", "Account", "Een nieuwe login op je account", NotificationManager.IMPORTANCE_HIGH),
      channel("requests", "Verzoeken", "Je verzoek is goedgekeurd, afgewezen of staat klaar", NotificationManager.IMPORTANCE_HIGH),
      // The service's own notification: as quiet as Android allows (no icon in the status bar).
      channel(SERVICE_CHANNEL, "Verbinding met de server", "Houdt de verbinding open, zodat meldingen meteen komen. Mag je verbergen.", NotificationManager.IMPORTANCE_MIN).apply {
        setShowBadge(false)
      },
    )
    if (admin) {
      channels += channel("admin", "Beheer", "De server vraagt aandacht", NotificationManager.IMPORTANCE_DEFAULT)
    } else {
      manager.deleteNotificationChannel("admin")
    }
    manager.createNotificationChannels(channels)
  }

  private fun builder(context: Context, channel: String): Notification.Builder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, channel)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }

  /** The monochrome logo of expo-notifications' setting, else the app's icon. */
  private fun smallIcon(context: Context): Int {
    val id = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (id != 0) id else context.applicationInfo.icon
  }

  /** Opens a screen of the app: cinevault://item/…, cinevault://play/…, cinevault://profile. */
  private fun open(context: Context, link: String, code: Int): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      code,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /** Where a tap goes, as openNotification in the app does. */
  private fun linkOf(n: JSONObject): String {
    n.optString("itemId").takeIf { it.isNotEmpty() }?.let { return "cinevault://item/$it" }
    return when (n.optString("path")) {
      "/profile" -> "cinevault://profile"
      "/requests" -> "cinevault://requests"
      "/attention" -> "cinevault://attention"
      "/admin" -> "cinevault://admin"
      else -> "cinevault://notifications"
    }
  }

  private fun time(iso: String): Long = try {
    val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", Locale.US)
    format.timeZone = TimeZone.getTimeZone("UTC")
    format.parse(iso)?.time ?: System.currentTimeMillis()
  } catch (_: Exception) {
    System.currentTimeMillis()
  }

  fun createdAt(n: JSONObject): Long = time(n.optString("createdAt"))

  /** An image of the server, scaled down to at most `width` wide. */
  private fun image(http: NotifyHttp, server: String, path: String, width: Int): Bitmap? {
    if (path.isEmpty()) return null
    val url = if (path.startsWith("http")) path else server + path
    val bytes = http.bytes(url) ?: return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= width) sample *= 2
    val bitmap = BitmapFactory.decodeByteArray(
      bytes,
      0,
      bytes.size,
      BitmapFactory.Options().apply { inSampleSize = sample },
    ) ?: return null
    if (bitmap.width <= width) return bitmap
    val height = bitmap.height * width / bitmap.width
    return Bitmap.createScaledBitmap(bitmap, width, height, true)
  }

  /** A wide picture cut to 2:1 (what Android shows), from the middle. */
  private fun wide(bitmap: Bitmap): Bitmap {
    val height = bitmap.width / 2
    if (bitmap.height <= height) return bitmap
    return Bitmap.createBitmap(bitmap, 0, (bitmap.height - height) / 2, bitmap.width, height)
  }

  /** The poster with rounded corners, as the app shows posters. */
  private fun rounded(bitmap: Bitmap): Bitmap {
    val out = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      shader = BitmapShader(bitmap, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
    }
    val radius = bitmap.width * 0.08f
    Canvas(out).drawRoundRect(RectF(0f, 0f, bitmap.width.toFloat(), bitmap.height.toFloat()), radius, radius, paint)
    return out
  }

  private fun action(context: Context, label: String, intent: PendingIntent): Notification.Action =
    Notification.Action.Builder(null as Icon?, label, intent).build()

  /** Shows one notification of the server (NotificationDto) on this phone. */
  fun post(context: Context, server: String, http: NotifyHttp, n: JSONObject) {
    val id = n.getInt("id")
    val type = n.optString("type")
    val title = n.optString("title")
    val body = n.optString("body")
    val itemId = n.optString("itemId")
    val fileId = n.optString("fileId")
    val builder = builder(context, CHANNEL[type] ?: "account")
      .setSmallIcon(smallIcon(context))
      .setColor(BRASS)
      .setContentTitle(title)
      .setContentText(body)
      .setSubText(LABEL[type] ?: "CineVault")
      .setWhen(createdAt(n))
      .setShowWhen(true)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setGroup(GROUP)
      .setCategory(
        when (type) {
          "recommended" -> Notification.CATEGORY_RECOMMENDATION
          "new-login" -> Notification.CATEGORY_STATUS
          "admin-unmatched", "admin-transcoder", "admin-health" -> Notification.CATEGORY_ERROR
          else -> Notification.CATEGORY_EVENT
        },
      )
      .setContentIntent(open(context, linkOf(n), id * 4))

    // The poster beside the text; the episode's picture (else the backdrop) when opened.
    val poster = image(http, server, n.optString("posterUrl"), 256)?.let { rounded(it) }
    val picture = image(http, server, n.optString("stillUrl").ifEmpty { n.optString("imageUrl") }, 1024)
    if (poster != null) builder.setLargeIcon(poster)
    if (picture != null) {
      val style = Notification.BigPictureStyle()
        .bigPicture(wide(picture))
        .setBigContentTitle(title)
        .setSummaryText(body)
      // Opened, the picture shows the title: no poster on top of it.
      style.bigLargeIcon(null as Icon?)
      builder.setStyle(style)
    } else {
      builder.setStyle(Notification.BigTextStyle().bigText(body).setBigContentTitle(title))
    }

    // Buttons to what it is about.
    if (fileId.isNotEmpty() && (type == "new-episodes" || type == "request-update")) {
      builder.addAction(action(context, "▶  Afspelen", open(context, "cinevault://play/$fileId", id * 4 + 1)))
    }
    if (itemId.isNotEmpty()) {
      builder.addAction(action(context, "Bekijken", open(context, "cinevault://item/$itemId", id * 4 + 2)))
      if (type == "recommended") {
        val add = Intent(context, NotifyReceiver::class.java)
          .setAction(NotifyReceiver.ADD_TO_LIST)
          .putExtra(NotifyReceiver.EXTRA_ITEM, itemId)
          .putExtra(NotifyReceiver.EXTRA_NOTIFICATION, id)
        val pending = PendingIntent.getBroadcast(
          context,
          id * 4 + 3,
          add,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        builder.addAction(action(context, "+  Mijn lijst", pending))
      }
    }
    when (type) {
      "new-login" -> builder.addAction(action(context, "Wachtwoord wijzigen", open(context, "cinevault://profile", id * 4 + 1)))
      "request-new" -> builder.addAction(action(context, "Verzoeken", open(context, "cinevault://requests", id * 4 + 1)))
    }
    manager(context).notify(id, builder.build())
  }

  /**
   * With two or more of them: one summary for the group, with a line per
   * notification (the title in bold), and how many came in.
   */
  fun summarize(context: Context, fresh: Int) {
    val manager = manager(context)
    val active = manager.activeNotifications.filter {
      it.notification.group == GROUP && it.id != SUMMARY_ID
    }
    if (active.size < 2) {
      if (active.isEmpty()) manager.cancel(SUMMARY_ID)
      return
    }
    val style = Notification.InboxStyle()
    for (entry in active.sortedByDescending { it.notification.`when` }.take(6)) {
      val extras = entry.notification.extras
      val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: continue
      val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
      val line = SpannableStringBuilder(title)
      line.setSpan(StyleSpan(Typeface.BOLD), 0, title.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      if (text.isNotEmpty()) line.append("  ").append(text)
      style.addLine(line)
    }
    val count = maxOf(active.size, fresh)
    val more = count - minOf(active.size, 6)
    style.setSummaryText(if (more > 0) "+$more meer" else "$count meldingen")
    val summary = builder(context, "episodes")
      .setSmallIcon(smallIcon(context))
      .setColor(BRASS)
      .setContentTitle("CineVault")
      .setContentText("$count nieuwe meldingen")
      .setStyle(style)
      .setGroup(GROUP)
      .setGroupSummary(true)
      .setAutoCancel(true)
      .setContentIntent(open(context, "cinevault://notifications", 3))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // The summary itself never rings: the notifications in it did.
      summary.setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
    }
    manager.notify(SUMMARY_ID, summary.build())
  }

  /** The service's own notification (Android requires one): quiet, at the bottom. */
  fun service(context: Context, text: String): Notification =
    builder(context, SERVICE_CHANNEL)
      .setSmallIcon(smallIcon(context))
      .setColor(BRASS)
      .setContentTitle("Meldingen staan aan")
      .setContentText(text)
      .setOngoing(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setContentIntent(open(context, "cinevault://profile", 1))
      .build()

  fun updateService(context: Context, text: String) {
    manager(context).notify(SERVICE_ID, service(context, text))
  }
}
