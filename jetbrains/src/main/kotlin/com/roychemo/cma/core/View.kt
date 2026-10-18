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
) {
    val topPercent: Double get() = status?.limits?.maxOfOrNull { it.percentUsed }?.coerceAtLeast(0.0) ?: 0.0
    val warn: Boolean get() = topPercent >= WARN_PERCENT

    fun statusText(): String {
        val parts = mutableListOf(currentName)
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

    companion object {
        fun compute(p: CmaPaths, roots: List<String>, transcripts: TranscriptReader): View? {
            val folder = roots.firstOrNull() ?: return null
            val accounts = readAccounts(p)
            val rules = readRules(p)
            val latest = latestStatus(p, roots)
            val currentName = accountFor(folder, rules) ?: latest?.accountName ?: accounts[0].name
            val current = accounts.find { it.name == currentName }
            val status = latestStatus(p, roots, currentName)
            val email = status?.accountEmail ?: current?.let { emailOf(it.dir, p.home) } ?: NOT_SIGNED_IN
            val openOn = latest?.accountName?.takeIf { it != currentName }
            val inherit = inheritedAccount(folder, rules)?.let { it.account ?: accounts[0].name }
            return View(folder, accounts, currentName, email, status, status?.let { transcripts.sessionTokens(it.transcript) }, openOn, inherit)
        }
    }
}

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
