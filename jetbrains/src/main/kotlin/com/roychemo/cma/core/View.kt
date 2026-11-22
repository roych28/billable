package com.roychemo.cma.core

import java.io.File

val LIMIT_NAMES = mapOf("five_hour" to "5-hour limit", "seven_day" to "Weekly limit")
const val WARN_PERCENT = 90.0

/**
 * What the status bar shows for a project, as in the VS Code extension: the account the folder is set to (so a
 * switch shows at once), usage from the latest session on that account, and a flag when a conversation is still
 * open on another account.
 */
data class View(
    val folder: String,
    val accounts: List<Account>,
    val currentName: String,
    val email: String,
    val status: SessionStatus?,
    val tokens: Tokens?,
    val openOn: String?,
    /** Set when the folder has a rule of its own: the account it would run on after "Use default". */
    val inherit: String?,
    /** Whether the folder's account is still signed in, from `claude auth status` (auth.json). */
    val signIn: SignIn = SignIn(LoginState.UNKNOWN, null, null),
    val now: Long = System.currentTimeMillis(),
    val shared: List<SharedSignIn> = emptyList(),
) {
    val topPercent: Double get() = status?.limits?.maxOfOrNull { it.percentUsed }?.coerceAtLeast(0.0) ?: 0.0
    val ending: Boolean get() = signIn.state == LoginState.ENDING && signIn.expiresAt != null
    val warn: Boolean get() = topPercent >= WARN_PERCENT || ending
    /** Red: claude said the account is signed out, so every conversation on it stops with a sign-in prompt. */
    val error: Boolean get() = signIn.ended

    fun statusText(): String {
        val parts = mutableListOf(
            when {
                error -> "$currentName signed out"
                ending -> "$currentName  ·  sign-in ends ${timeLeft(signIn.expiresAt!! - now)}"
                else -> currentName
            },
        )
        status?.let { s ->
            tokens?.let { parts.add(short(it.total)) }
            s.usd?.let { parts.add(money(it)) }
            if (s.limits.isNotEmpty()) parts.add("${jsNumber(topPercent)}%")
        }
        openOn?.let { parts.add("chat on $it") }
        return parts.joinToString("  ·  ")
    }

    /** The usage lines under the switch buttons. */
    fun usageLines(): List<String> {
        val s = status ?: return listOf("No session on $currentName in this folder yet. Start a conversation to see its usage.")
        val t = tokens
        return listOfNotNull(
            if (t != null) {
                "Tokens (latest session): ${short(t.total)}  input ${short(t.input)} · output ${short(t.output)} · " +
                    "cache read ${short(t.cacheRead)} · cache write ${short(t.cacheWrite)}"
            } else {
                "Tokens: transcript not found"
            },
            "Cost: ${s.usd?.let { money(it) } ?: "unknown"}",
        ) + s.limits.map { "${LIMIT_NAMES[it.kind] ?: it.kind}: ${jsNumber(it.percentUsed)}%" }
    }

    /** What the hover and the menu say about the folder's sign-in; null when it works (or was never checked). */
    fun signInLine(): String? = when {
        error -> "$currentName is signed out${signIn.expiresAt?.let { " since ${dateText(it)}" } ?: ""}. " +
            "Its conversations stop with a sign-in prompt."
        ending -> "$currentName's sign-in ends ${timeLeft(signIn.expiresAt!! - now)} (${dateText(signIn.expiresAt)}). " +
            "Sign in again before it ends."
        else -> null
    }

    companion object {
        fun compute(
            p: CmaPaths,
            roots: List<String>,
            transcripts: TranscriptReader,
            now: Long = System.currentTimeMillis(),
        ): View? {
            val folder = roots.firstOrNull() ?: return null
            val accounts = readAccounts(p)
            val rules = readRules(p)
            val latest = latestStatus(p, roots)
            // As the launchers decide it: the rule of the folder or of its real path (a project opened through a link).
            val current = launchedAccount(p, accountFor(listOf(folder, realPath(folder)), rules), accounts)
            val currentName = current.name
            val status = latestStatus(p, roots, currentName)
            // The sign-in the account has now, before the one its last session ran as: a new sign-in shows at once.
            val onFile = emailOf(current.dir, p.home).takeIf { it != NOT_SIGNED_IN }
            val email = onFile ?: status?.accountEmail ?: NOT_SIGNED_IN
            val openOn = latest?.accountName?.takeIf { it != currentName }
            val inherit = inheritedAccount(folder, rules)?.let { launchedAccount(p, it.account, accounts).name }
            val signIn = signInOf(p, current.dir, now)
            val tokens = status?.let { transcripts.sessionTokens(it.transcript) }
            val shared = sharedSignIns(p, accounts, now)
            return View(folder, accounts, currentName, email, status, tokens, openOn, inherit, signIn, now, shared)
        }
    }

    /** Accounts signed in as one Claude account share one plan and its limits: said in the hover. */
    fun sharedLines(): List<String> =
        shared.map { "${it.names.joinToString(" and ")} are signed in as the same Claude account, ${it.email}." }
}

/** The folder's real path, through links; the folder itself when it does not exist. */
fun realPath(folder: String): String = try {
    File(folder).toPath().toRealPath().toString()
} catch (_: Exception) {
    folder
}

/**
 * The account a new `claude` in the folder really runs on, as the launchers decide it: the account the rule names when
 * it is listed; otherwise the launcher changes nothing, so claude runs on ~/.claude, under its listed name or as
 * `~/.claude`. Never simply the first account of the file.
 */
fun launchedAccount(p: CmaPaths, ruled: String?, accounts: List<Account>): Account {
    accounts.find { it.name == ruled }?.let { return it }
    val dir = File(p.home, ".claude").path
    return accounts.find { pathKey(it.dir) == pathKey(dir) } ?: Account("~/.claude", dir)
}

/** A date and time as the user's locale writes it, e.g. "Dec 20, 2026, 8:05 PM". */
fun dateText(ms: Long, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String =
    java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM, java.time.format.FormatStyle.SHORT)
        .withZone(zone)
        .format(java.time.Instant.ofEpochMilli(ms))

/** The shell function from the README, so `claude` in the IDE's terminal starts on the folder's account. */
fun shellFunction(p: CmaPaths, windows: Boolean = false): String {
    if (windows) {
        val exe = File(File(p.bin), "cma.exe").path
        val shown = if (exe.startsWith(p.home)) "\$HOME" + exe.substring(p.home.length) else exe
        return "function claude { & \"$shown\" exec claude.exe @args }"
    }
    val cma = File(File(p.bin), "cma").path
    val underHome = cma.startsWith(p.home + "/")
    val rest = if (underHome) cma.substring(p.home.length + 1) else cma
    val plain = Regex("^[A-Za-z0-9_./-]+$").matches(rest)
    val shown = when {
        underHome && plain -> "~/$rest"
        underHome -> "\"\$HOME/$rest\""
        plain -> rest
        else -> "'" + rest.replace("'", "'\\''") + "'"
    }
    return "claude() { $shown exec claude \"\$@\"; }"
}
