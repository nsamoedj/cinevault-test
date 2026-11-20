package nl.cinevault.media

/**
 * Which notifications from the server the phone shows itself (as
 * src/notifications/pick.ts did on the JavaScript side). Pure, for tests.
 */
object NotifyPick {
  /** Older ones are not shown any more (the phone was off for days). */
  const val MAX_AGE_MS = 2L * 86_400_000
  /** Shown one by one; more than this at once: the newest ones, and the group says how many. */
  const val MAX_SINGLE = 6
  /** How many shown ids the phone remembers. */
  const val REMEMBER = 200

  data class Item(val id: Int, val read: Boolean, val createdAt: Long)

  data class Result(
    /** Oldest first, at most MAX_SINGLE. */
    val show: List<Int>,
    /** All new ones, also those not shown one by one. */
    val fresh: Int,
    val seen: List<Int>,
  )

  /**
   * `seen` null: the first time after switching on or logging in. Everything
   * that is there is then seen, so nothing old pops up.
   */
  fun pick(items: List<Item>, seen: List<Int>?, now: Long): Result {
    val ids = items.map { it.id }
    if (seen == null) return Result(emptyList(), 0, ids.take(REMEMBER))
    val known = seen.toHashSet()
    val fresh = items
      .filter { it.id !in known && !it.read && now - it.createdAt <= MAX_AGE_MS }
      .sortedBy { it.id }
    val remember = (ids + seen).distinct().sortedDescending().take(REMEMBER)
    return Result(fresh.takeLast(MAX_SINGLE).map { it.id }, fresh.size, remember)
  }
}
