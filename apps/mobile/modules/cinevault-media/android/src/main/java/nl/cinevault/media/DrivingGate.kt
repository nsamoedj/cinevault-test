package nl.cinevault.media

/**
 * Whether video may play now, for the guard in expo-video's media sessions
 * (patches/expo-video@58.0.11.patch, VideoGate): that one refuses play from
 * outside the app (steering wheel, the car's media controls, the Assistant)
 * while the car drives. CinevaultMediaModule is the only one that reads the
 * car's restrictions and writes it here; expo-video reads it through
 * reflection (it doesn't depend on this module), so the name of the class and
 * the field are fixed (and kept by R8, app.json extraProguardRules).
 *
 * Play from inside the app (the player's buttons, the next episode) doesn't go
 * through a media session: Player.tsx pauses that itself while driving.
 */
object DrivingGate {
  @Volatile @JvmField var videoAllowed: Boolean = true
}
