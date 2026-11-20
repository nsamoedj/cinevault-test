package nl.cinevault.media

import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.view.View
import java.lang.reflect.Proxy
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.UIManagerHelper
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Tells the app which codecs this device decodes, so it can choose between
 * direct play and letting the server convert (packages/shared/playback.ts),
 * moves the focus on a TV (the remote's D-pad follows the focus), and in a
 * car (Android Automotive OS) whether the driving restrictions are on: video
 * only plays while parked.
 */
class CinevaultMediaModule : Module() {
  private val decoders: List<MediaCodecInfo> by lazy {
    MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }
  }

  // Android Automotive OS: android.car through reflection, so the module builds
  // with the plain SDK and does nothing on phones and TVs.
  private var car: Any? = null
  private var uxManager: Any? = null

  private fun isAutomotive(): Boolean {
    val context = appContext.reactContext ?: return false
    return context.packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE)
  }

  /** CarUxRestrictionsManager, connected the first time (null off a car). */
  private fun restrictionsManager(): Any? {
    uxManager?.let { return it }
    val context = appContext.reactContext ?: return null
    if (!isAutomotive()) return null
    return try {
      val carClass = Class.forName("android.car.Car", true, context.classLoader)
      val connected = carClass.getMethod("createCar", Context::class.java).invoke(null, context)
        ?: return null
      val service = carClass.getField("CAR_UX_RESTRICTION_SERVICE").get(null) as String
      val manager = carClass.getMethod("getCarManager", String::class.java).invoke(connected, service)
      car = connected
      uxManager = manager
      manager
    } catch (_: Throwable) {
      null
    }
  }

  /** Whether the car requires distraction optimization now: the app must not play video. */
  private fun requiresOptimization(restrictions: Any?): Boolean = try {
    restrictions?.javaClass?.getMethod("isRequiresDistractionOptimization")?.invoke(restrictions) as? Boolean
      ?: false
  } catch (_: Throwable) {
    false
  }

  /**
   * Whether the restrictions allow video: no distraction optimization required
   * and no UX_RESTRICTIONS_NO_VIDEO. Unknown restrictions allow it, as before.
   */
  private fun videoAllowed(restrictions: Any?): Boolean {
    if (restrictions == null) return true
    if (requiresOptimization(restrictions)) return false
    return try {
      val noVideo = try {
        restrictions.javaClass.getField("UX_RESTRICTIONS_NO_VIDEO").getInt(null)
      } catch (_: Throwable) {
        NO_VIDEO
      }
      val active = restrictions.javaClass.getMethod("getActiveRestrictions").invoke(restrictions) as Int
      (active and noVideo) == 0
    } catch (_: Throwable) {
      true
    }
  }

  private fun currentRestrictions(): Any? {
    val manager = restrictionsManager() ?: return null
    return try {
      manager.javaClass.getMethod("getCurrentCarUxRestrictions").invoke(manager)
    } catch (_: Throwable) {
      null
    }
  }

  private fun drivingRestricted(): Boolean {
    val restrictions = currentRestrictions() ?: return false
    DrivingGate.videoAllowed = videoAllowed(restrictions)
    return requiresOptimization(restrictions)
  }

  private fun listenToRestrictions() {
    val manager = restrictionsManager() ?: return
    try {
      val listenerClass = Class.forName(
        "android.car.drivingstate.CarUxRestrictionsManager\$OnUxRestrictionsChangedListener",
        true,
        manager.javaClass.classLoader,
      )
      val listener = Proxy.newProxyInstance(listenerClass.classLoader, arrayOf(listenerClass)) { proxy, method, args ->
        when (method.name) {
          "onUxRestrictionsChanged" -> {
            val restrictions = args?.getOrNull(0)
            DrivingGate.videoAllowed = videoAllowed(restrictions)
            sendEvent(DRIVING_EVENT, mapOf("restricted" to requiresOptimization(restrictions)))
            null
          }
          "hashCode" -> System.identityHashCode(proxy)
          "equals" -> proxy === args?.getOrNull(0)
          "toString" -> "CinevaultUxRestrictionsListener"
          else -> null
        }
      }
      manager.javaClass.methods
        .first { it.name == "registerListener" && it.parameterTypes.size == 1 }
        .invoke(manager, listener)
      // It may have changed while nobody listened.
      DrivingGate.videoAllowed = videoAllowed(currentRestrictions())
    } catch (_: Throwable) {
      // No listener: the activity is still paused (covered) while driving.
    }
  }

  private fun stopListening() {
    val manager = uxManager ?: return
    try {
      manager.javaClass.getMethod("unregisterListener").invoke(manager)
    } catch (_: Throwable) {
    }
    try {
      car?.javaClass?.getMethod("disconnect")?.invoke(car)
    } catch (_: Throwable) {
    }
    uxManager = null
    car = null
    // Nobody watches the car any more (no player open): don't keep an old "driving".
    DrivingGate.videoAllowed = true
  }

  override fun definition() = ModuleDefinition {
    Name("CinevaultMedia")

    Events(DRIVING_EVENT)

    OnStartObserving { listenToRestrictions() }

    OnStopObserving { stopListening() }

    OnDestroy { stopListening() }

    /** A car with Android Automotive OS (Google built-in). */
    Function("isAutomotive") { isAutomotive() }

    /** True while the car is driving (the UX restrictions are on): no video then. */
    Function("drivingRestricted") { drivingRestricted() }

    /**
     * True when a decoder handles `mime` (e.g. "video/hevc"), with `profile`
     * (MediaCodecInfo.CodecProfileLevel) and the frame size when given.
     */
    Function("supports") { mime: String, profile: Int?, width: Int?, height: Int? ->
      decoders.any { info ->
        val type = info.supportedTypes.firstOrNull { it.equals(mime, ignoreCase = true) }
          ?: return@any false
        val capabilities = try {
          info.getCapabilitiesForType(type)
        } catch (_: IllegalArgumentException) {
          return@any false
        }
        val profileOk = profile == null || capabilities.profileLevels.any { it.profile == profile }
        val video = capabilities.videoCapabilities
        val sizeOk = width == null || height == null || video == null ||
          video.isSizeSupported(width, height) || video.isSizeSupported(height, width)
        profileOk && sizeOk
      }
    }

    /**
     * Gives the view with this React tag the focus, e.g. the play button when
     * a TV screen opens. False when the view is not there (any more).
     */
    AsyncFunction("focus") { viewTag: Int ->
      val context = appContext.reactContext as? ReactContext
      val view: View? = if (context == null) {
        null
      } else {
        try {
          UIManagerHelper.getUIManagerForReactTag(context, viewTag)?.resolveView(viewTag)
        } catch (_: RuntimeException) {
          null
        }
      }
      if (view == null) {
        false
      } else {
        view.isFocusable = true
        view.requestFocus()
      }
    }.runOnQueue(Queues.MAIN)

    // Notifications with the app closed (NotifyService). The app hands over
    // the server's addresses and the login; the service does the rest.

    /** The login and addresses for the service; starts it when notifications are on. */
    Function("notifySetup") { servers: List<String>, token: String?, admin: Boolean ->
      val context = appContext.reactContext ?: return@Function false
      val store = NotifyStore(context)
      store.configure(servers, token, admin)
      NotifyPoster.ensureChannels(context, admin)
      if (store.enabled && token != null) NotifyService.start(context) else false
    }

    /** Switches them on (a fresh start: what is there now counts as seen) or off for this phone. */
    Function("notifyEnable") { on: Boolean ->
      val context = appContext.reactContext ?: return@Function false
      val store = NotifyStore(context)
      if (on) {
        store.seen = null
        store.since = 0
        store.enabled = true
        NotifyService.start(context)
      } else {
        store.enabled = false
        NotifyService.stop(context)
        false
      }
    }

    /** Logged out: the service stops and forgets the login. */
    Function("notifyForget") {
      val context = appContext.reactContext ?: return@Function false
      NotifyService.stop(context)
      NotifyStore(context).forget()
      true
    }

    /** For Profiel → Meldingen. */
    Function("notifyStatus") {
      val context = appContext.reactContext ?: return@Function emptyMap<String, Any?>()
      val store = NotifyStore(context)
      val status = store.status()
      val power = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
      val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
      mapOf(
        "enabled" to store.enabled,
        "running" to NotifyService.running,
        "connected" to NotifyService.connected,
        "permitted" to notifications.areNotificationsEnabled(),
        "batteryExempt" to power.isIgnoringBatteryOptimizations(context.packageName),
        "server" to status.optString("server").ifEmpty { null },
        "connectedAt" to status.optLong("connectedAt").takeIf { it > 0 }?.toDouble(),
        "checkedAt" to status.optLong("checkedAt").takeIf { it > 0 }?.toDouble(),
        "shownAt" to status.optLong("shownAt").takeIf { it > 0 }?.toDouble(),
        "shown" to status.optInt("shown"),
        "error" to status.optString("error").ifEmpty { null },
        "errorAt" to status.optLong("errorAt").takeIf { it > 0 }?.toDouble(),
      )
    }

    /** One check now (the app open, the background task, a test): how many it showed. Starts the service too. */
    AsyncFunction("notifyCheck") {
      val context = appContext.reactContext ?: return@AsyncFunction 0
      if (!NotifyService.running) NotifyService.start(context)
      NotifyService.checkOnce(context)
    }

    /** Android's question to let CineVault run unrestricted in the background (battery). */
    Function("notifyAskBattery") {
      val context = appContext.reactContext ?: return@Function false
      try {
        val intent = android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
          .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
      } catch (_: Exception) {
        false
      }
    }

    /** The decoders, for the statistics screen: "c2.qti.hevc.decoder: video/hevc (hardware)". */
    Function("decoders") {
      decoders.map { info ->
        val kind = if (android.os.Build.VERSION.SDK_INT >= 29 && info.isHardwareAccelerated) "hardware" else "software"
        "${info.name}: ${info.supportedTypes.joinToString()} ($kind)"
      }
    }
  }
}

private const val DRIVING_EVENT = "onDrivingRestrictionChange"

/** CarUxRestrictions.UX_RESTRICTIONS_NO_VIDEO, if the field can't be read. */
private const val NO_VIDEO = 0x10
