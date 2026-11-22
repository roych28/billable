package com.roychemo.cma.core

import java.io.File
import java.nio.file.Paths

// A port of vscode/lib.js from Claude Multi-Account. The files and their rules are shared with the VS Code
// extension, the `cma` launcher and the Claude Code plugin, so every reader must agree on them.

const val NOT_SIGNED_IN = "not signed in"

private val IS_WINDOWS = System.getProperty("os.name").orEmpty().startsWith("Windows")

/** Where the setup lives. `CLAUDE_MULTI_ACCOUNT_HOME` replaces the base folder; account dirs still expand `~` to home. */
data class CmaPaths(val home: String, val base: String) {
    val accounts get() = File(base, "accounts").path
    val folders get() = File(base, "folders").path
    val sessions get() = File(base, "sessions").path
    val ledger get() = File(base, "ledger").path
    val bin get() = File(base, "bin").path

    companion object {
        fun of(home: String = System.getProperty("user.home"), env: Map<String, String> = System.getenv()): CmaPaths {
            // A relative CLAUDE_MULTI_ACCOUNT_HOME is taken from the home folder, as in the extension, the launchers
            // and the plugin: each runs in another working folder, and they must all read the same files.
            val override = env["CLAUDE_MULTI_ACCOUNT_HOME"]
            val base = when {
                override.isNullOrEmpty() -> File(home, ".claude-multi-account").path
                File(override).isAbsolute -> override
                else -> Paths.get(home, override).normalize().toString()
            }
            return CmaPaths(home, base)
        }
    }
}

data class Account(val name: String, val dir: String)

data class Rule(val path: String, val account: String)

fun expand(p: String, home: String): String {
    val full = when {
        p == "~" -> home
        p.startsWith("~/") || p.startsWith("~\\") -> Paths.get(home, p.substring(2)).normalize().toString()
        else -> p
    }
    return full.replace(Regex("[\\\\/]+$"), "")
}

private fun readRows(file: String): List<List<String>> = try {
    File(file).readText()
        .removePrefix("﻿")
        .split('\n')
        .map { it.trim() }
        .filter { it.isNotEmpty() && !it.startsWith("#") }
        .map { l -> l.split('\t').map { it.trim() } }
        .filter { it.size >= 2 && it[0].isNotEmpty() && it[1].isNotEmpty() }
} catch (_: Exception) {
    emptyList()
}

/** A name listed twice counts once, the first line wins: the launchers resolve a name to its first line too. */
fun readAccounts(p: CmaPaths): List<Account> {
    val rows = readRows(p.accounts).distinctBy { it[0] }.map { Account(it[0], expand(it[1], p.home)) }
    return rows.ifEmpty { listOf(Account("default", File(p.home, ".claude").path)) }
}

fun readRules(p: CmaPaths): List<Rule> =
    readRows(p.folders).map { Rule(if (it[0] == "*") "*" else expand(it[0], p.home), it[1]) }

/** How two paths are compared: forward slashes, no trailing slash, and case-insensitive on Windows. */
fun pathKey(p: String, windows: Boolean = IS_WINDOWS): String {
    val k = p.replace('\\', '/').replace(Regex("/+$"), "")
    return if (windows) k.lowercase() else k
}

/** The account a folder runs on: the longest matching folder rule wins, then the `*` default, else null. */
fun accountFor(folder: String, rules: List<Rule>, windows: Boolean = IS_WINDOWS): String? = accountFor(listOf(folder), rules, windows)

/**
 * The same for several spellings of one folder (its path and its real path): the longest rule containing any of them
 * wins, as in the launchers.
 */
fun accountFor(spellings: List<String>, rules: List<Rule>, windows: Boolean = IS_WINDOWS): String? {
    val fs = spellings.map { pathKey(it, windows) }
    var best: Rule? = null
    var bestLen = -1
    for (r in rules) {
        if (r.path == "*") {
            if (bestLen < 0) {
                best = r
                bestLen = 0
            }
            continue
        }
        val p = pathKey(r.path, windows)
        if (fs.any { f -> f == p || f.startsWith("$p/") } && p.length > bestLen) {
            best = r
            bestLen = p.length
        }
    }
    return best?.account
}

/** What a folder falls back to once its own rule is dropped. */
data class Inherited(val account: String?)

/** Null when the folder has no rule of its own; otherwise the account it would inherit (which may itself be null). */
fun inheritedAccount(folder: String, rules: List<Rule>, windows: Boolean = IS_WINDOWS): Inherited? {
    val own = rules.filter { it.path != "*" && pathKey(it.path, windows) == pathKey(folder, windows) }
    if (own.isEmpty()) return null
    return Inherited(accountFor(folder, rules.filter { it !in own }, windows))
}

/** The email on file. A sign-in that ended keeps it: [signInOf] says whether the account still works. */
fun emailOf(dir: String, home: String): String {
    return try {
        Json.parse(loginFileOf(dir, home).readText()).field("oauthAccount").str("emailAddress") ?: NOT_SIGNED_IN
    } catch (_: Exception) {
        NOT_SIGNED_IN
    }
}

/** Sets the folder's own rule to [name], keeping every other line; `auto` drops the folder's own rule. */
fun pin(p: CmaPaths, folder: String, name: String, windows: Boolean = IS_WINDOWS) {
    val file = File(p.folders)
    val lines = try {
        file.readText().split('\n').filter { it.isNotBlank() }
    } catch (_: Exception) {
        emptyList()
    }
    val kept = lines.filter { l ->
        val first = l.split('\t')[0].trim()
        l.trim().startsWith("#") || first == "*" || pathKey(expand(first, p.home), windows) != pathKey(folder, windows)
    }.toMutableList()
    if (name != "auto") kept.add("$folder\t$name")
    File(p.base).mkdirs()
    writeAtomic(file, kept.joinToString("\n") + "\n")
}

/** Replaces the file in one step, so a reader (a launcher, another IDE) never sees it half written. */
fun writeAtomic(file: File, text: String) {
    val tmp = File(file.parentFile, "${file.name}.${ProcessHandle.current().pid()}.${System.nanoTime()}.tmp")
    try {
        tmp.writeText(text)
        try {
            java.nio.file.Files.move(tmp.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE)
        } catch (_: Exception) {
            java.nio.file.Files.move(tmp.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
        }
    } finally {
        tmp.delete()
    }
}

fun isInside(dir: String, root: String, windows: Boolean = IS_WINDOWS): Boolean {
    val d = pathKey(dir, windows)
    val r = pathKey(root, windows)
    return d == r || d.startsWith("$r/")
}

data class Limit(val kind: String, val percentUsed: Double)

/** One session's report, as the Claude Code plugin writes it to `sessions/<id>.json`. */
data class SessionStatus(
    val sessionId: String?,
    val cwd: String,
    val transcript: String?,
    val accountName: String?,
    val accountEmail: String?,
    val usd: Double?,
    val limits: List<Limit>,
    val updatedAt: Double,
)

fun parseStatus(text: String): SessionStatus? {
    val o = Json.parseOrNull(text).obj() ?: return null
    val cwd = o.str("cwd") ?: return null
    val usage = o["usage"]
    val limits = (usage.field("limits") as? List<*>).orEmpty().mapNotNull { l ->
        val kind = l.str("kind") ?: return@mapNotNull null
        Limit(kind, l.num("percentUsed") ?: return@mapNotNull null)
    }
    return SessionStatus(
        sessionId = o.str("sessionId"),
        cwd = cwd,
        transcript = o.str("transcript"),
        accountName = o["account"].str("name"),
        accountEmail = o["account"].str("email"),
        usd = usage.num("usd"),
        limits = limits,
        updatedAt = o.num("updatedAt") ?: 0.0,
    )
}

/** The latest session under any of [roots], optionally on one account. */
fun latestStatus(p: CmaPaths, roots: List<String>, account: String? = null): SessionStatus? {
    val files = File(p.sessions).list()?.filter { it.endsWith(".json") }?.sorted() ?: return null
    var best: SessionStatus? = null
    for (f in files) {
        val s = try {
            parseStatus(File(p.sessions, f).readText())
        } catch (_: Exception) {
            null
        } ?: continue
        if (roots.none { isInside(s.cwd, it) }) continue
        if (account != null && s.accountName != account) continue
        if (best == null || s.updatedAt > best.updatedAt) best = s
    }
    return best
}

fun pruneSessions(p: CmaPaths, maxAgeMs: Long = 7L * 24 * 60 * 60 * 1000, now: Long = System.currentTimeMillis()) {
    File(p.sessions).listFiles()?.forEach { f ->
        try {
            if (now - f.lastModified() > maxAgeMs) f.delete()
        } catch (_: Exception) {
        }
    }
}
