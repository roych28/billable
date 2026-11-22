package com.roychemo.cma.core

import java.io.File
import java.time.OffsetDateTime
import java.util.concurrent.TimeUnit

// ---- Whether a sign-in still works ----
// A port of the sign-in checks in vscode/lib.js (0.9.0). A Claude sign-in has a fixed end (`loginExpiresAt` in
// `claude auth status`): after it, it cannot be renewed, only signed in again. Claude Code then drops the tokens, but
// the email stays in .claude.json, so the email alone says nothing about whether the account still works.
// `claude auth status` does: the answer is kept in auth.json, one entry per account folder, which every VS Code window,
// this plugin and the Claude Code plugin read, so each does not run claude on its own. Same file, same format.

const val LOGIN_WARN_MS = 3L * 24 * 3600_000
/** How long a check holds before it is run again; a signed-out account is checked sooner, to see a new sign-in quickly. */
const val AUTH_FRESH_MS = 10L * 60_000
const val AUTH_FRESH_SIGNED_OUT_MS = 2L * 60_000

private val IS_WINDOWS_AUTH = System.getProperty("os.name").orEmpty().startsWith("Windows")

/** One answer of `claude auth status --json`, as auth.json keeps it: `{at, loggedIn, email, expiresAt}`. */
data class AuthCheck(val at: Long, val loggedIn: Boolean, val email: String?, val expiresAt: Long?)

enum class LoginState { OK, ENDING, SIGNED_OUT, UNKNOWN }

/** What is known about an account's sign-in. [checkedAt] is null when claude was never asked: then only the email is known. */
data class SignIn(val state: LoginState, val expiresAt: Long?, val checkedAt: Long?) {
    /** Signed out by claude's own word, or past its end: not an account that simply never signed in. */
    val ended: Boolean get() = state == LoginState.SIGNED_OUT && checkedAt != null
}

private fun parseTime(s: String): Long? = try {
    OffsetDateTime.parse(s).toInstant().toEpochMilli()
} catch (_: Exception) {
    null
}

/**
 * The answer of `claude auth status --json`, or null when it is not one (claude missing, an old claude, a crash), or
 * when it is about another folder than [dir]: a claude on the way that picks the account by folder answers for that one.
 */
fun parseAuthStatus(stdout: String?, now: Long = System.currentTimeMillis(), dir: String? = null): AuthCheck? {
    val j = Json.parseOrNull(stdout.orEmpty().trim()).obj() ?: return null
    val loggedIn = j["loggedIn"] as? Boolean ?: return null
    val config = j["configDirectory"] as? String
    if (dir != null && config != null && pathKey(config) != pathKey(dir)) return null
    val end = (j["loginExpiresAt"] as? String)?.let { parseTime(it) }
    return AuthCheck(now, loggedIn, if (loggedIn) j["email"] as? String else null, end)
}

/** ok, ending (within [warnMs] of its end), signed-out, or unknown (never checked: then only the email is known). */
fun loginState(auth: AuthCheck?, now: Long = System.currentTimeMillis(), warnMs: Long = LOGIN_WARN_MS): LoginState {
    if (auth == null) return LoginState.UNKNOWN
    if (!auth.loggedIn) return LoginState.SIGNED_OUT
    val end = auth.expiresAt ?: return LoginState.OK
    if (end <= now) return LoginState.SIGNED_OUT
    return if (end - now <= warnMs) LoginState.ENDING else LoginState.OK
}

fun authFile(p: CmaPaths) = File(p.base, "auth.json")

/** Every check on file, keyed by the account folder's [pathKey]; a missing or broken file reads as none. */
fun readAuth(p: CmaPaths): Map<String, Any?> = try {
    Json.parseOrNull(authFile(p).readText()).obj() ?: emptyMap()
} catch (_: Exception) {
    emptyMap()
}

fun authOf(p: CmaPaths, dir: String, all: Map<String, Any?> = readAuth(p)): AuthCheck? {
    val a = all[pathKey(dir)].obj() ?: return null
    val loggedIn = a["loggedIn"] as? Boolean ?: return null
    val at = (a["at"] as? Double) ?: return null
    return AuthCheck(at.toLong(), loggedIn, a["email"] as? String, (a["expiresAt"] as? Double)?.toLong())
}

/** Keeps every other account's entry as it is, and replaces the file in one step. */
fun recordAuth(p: CmaPaths, dir: String, auth: AuthCheck) {
    File(p.base).mkdirs()
    val all = LinkedHashMap(readAuth(p))
    all[pathKey(dir)] = linkedMapOf("at" to auth.at, "loggedIn" to auth.loggedIn, "email" to auth.email, "expiresAt" to auth.expiresAt)
    writeAtomic(authFile(p), Json.stringify(all))
}

/** The file Claude Code keeps the sign-in's email in: `~/.claude.json` for `~/.claude`, else inside the folder. */
fun loginFileOf(dir: String, home: String): File =
    if (pathKey(dir) == pathKey(File(home, ".claude").path)) File(home, ".claude.json") else File(dir, ".claude.json")

/**
 * Whether the account is checked again: never checked, the check is old, or its login file changed after it (a sign-in
 * in a terminal writes it, and the account must not stay "signed out" for minutes after).
 */
fun authDue(p: CmaPaths, dir: String, now: Long = System.currentTimeMillis(), auth: AuthCheck? = authOf(p, dir)): Boolean {
    if (auth == null) return true
    val fresh = if (auth.loggedIn) AUTH_FRESH_MS else AUTH_FRESH_SIGNED_OUT_MS
    if (now - auth.at >= fresh) return true
    val f = loginFileOf(dir, p.home)
    return f.exists() && f.lastModified() > auth.at
}

/**
 * The environment that points claude at the account: ~/.claude is the account with no CLAUDE_CONFIG_DIR, and naming
 * it would make claude look for another sign-in (it then reports "not logged in").
 */
fun accountEnv(dir: String, home: String, env: Map<String, String>): Map<String, String> {
    val out = LinkedHashMap(env)
    out.keys.removeIf { it.equals("CLAUDE_CONFIG_DIR", ignoreCase = true) }
    if (pathKey(dir) != pathKey(File(home, ".claude").path)) out["CLAUDE_CONFIG_DIR"] = dir
    return out
}

/** The check when there is one, else only whether an email is on file. */
fun signInOf(p: CmaPaths, dir: String, now: Long = System.currentTimeMillis(), all: Map<String, Any?> = readAuth(p)): SignIn {
    val auth = authOf(p, dir, all)
    val state = when {
        auth != null -> loginState(auth, now)
        emailOf(dir, p.home) == NOT_SIGNED_IN -> LoginState.SIGNED_OUT
        else -> LoginState.UNKNOWN
    }
    return SignIn(state, auth?.expiresAt, auth?.at)
}

fun signedOut(p: CmaPaths, dir: String, now: Long = System.currentTimeMillis()) = signInOf(p, dir, now).state == LoginState.SIGNED_OUT

/** The first other account that still works: where a folder on a signed-out account can go meanwhile. */
fun liveAccount(p: CmaPaths, accounts: List<Account>, except: String, now: Long = System.currentTimeMillis()): Account? {
    val all = readAuth(p)
    return accounts.find { it.name != except && signInOf(p, it.dir, now, all).state != LoginState.SIGNED_OUT }
}

data class SharedSignIn(val email: String, val names: List<String>)

/**
 * Accounts signed in as the same Claude account. A sign-in typed in a terminal goes to the folder's account, so
 * signing in "the new one" from the wrong folder silently replaces another account's sign-in.
 */
fun sharedSignIns(p: CmaPaths, accounts: List<Account>, now: Long = System.currentTimeMillis()): List<SharedSignIn> {
    val all = readAuth(p)
    val byEmail = LinkedHashMap<String, Pair<String, MutableList<String>>>()
    for (a in accounts) {
        val email = emailOf(a.dir, p.home)
        // A sign-in that ended shares nothing: its email only stays on file.
        if (email == NOT_SIGNED_IN || signInOf(p, a.dir, now, all).state == LoginState.SIGNED_OUT) continue
        byEmail.getOrPut(email.lowercase()) { email to mutableListOf() }.second.add(a.name)
    }
    return byEmail.values.filter { it.second.size > 1 }.map { SharedSignIn(it.first, it.second) }
}

/** "in 2 days", "in 5 hours", "in 20 minutes". */
fun timeLeft(ms: Long): String {
    fun unit(n: Long, w: String) = "$n $w${if (n == 1L) "" else "s"}"
    val day = 24 * 3600_000L
    return when {
        ms >= day -> "in ${unit(ms / day, "day")}"
        ms >= 3600_000L -> "in ${unit(ms / 3600_000L, "hour")}"
        else -> "in ${unit(maxOf(1L, ms / 60_000L), "minute")}"
    }
}

/** After an account's name in a list: why picking it would not just work. */
fun signInNote(s: SignIn, now: Long = System.currentTimeMillis()): String = when {
    // No email on file and never checked: an account that never signed in, not one whose sign-in ended.
    s.state == LoginState.SIGNED_OUT -> if (s.checkedAt == null) " (not signed in)" else " (signed out)"
    s.state == LoginState.ENDING && s.expiresAt != null -> " (sign-in ends ${timeLeft(s.expiresAt - now)})"
    else -> ""
}

/**
 * Where `claude` is: on the IDE's PATH (the login shell's, on macOS), then the places its installers use. Null when
 * there is none, so no check runs and no sign-in terminal opens for a program that cannot start.
 */
fun findClaude(home: String, env: Map<String, String>, windows: Boolean = IS_WINDOWS_AUTH): String? {
    val names = if (windows) listOf("claude.exe", "claude.cmd", "claude") else listOf("claude")
    val path = env.entries.firstOrNull { it.key.equals("PATH", ignoreCase = true) }?.value.orEmpty()
    val nvm = File(home, ".nvm/versions/node").listFiles()?.sortedByDescending { it.name }?.map { File(it, "bin").path }.orEmpty()
    val dirs = path.split(if (windows) ';' else ':').filter { it.isNotBlank() } +
        listOf(File(home, ".local/bin").path, File(home, ".claude/local").path) +
        (if (windows) emptyList() else listOf("/opt/homebrew/bin", "/usr/local/bin")) + nvm
    for (d in dirs) {
        for (n in names) {
            val f = File(d, n)
            if (f.isFile && (windows || f.canExecute())) return f.path
        }
    }
    return null
}

/**
 * Asks [claude] whether the account in [dir] is signed in. Null when there is no answer in [timeoutMs] or it is not
 * one. Runs claude itself, not a shell, so a `claude()` wrapper in the shell profile cannot pick another account.
 */
fun runAuthStatus(
    claude: String,
    dir: String,
    home: String,
    env: Map<String, String>,
    timeoutMs: Long = 20_000,
    now: () -> Long = System::currentTimeMillis,
): AuthCheck? {
    val out = try {
        File.createTempFile("billable-auth-", ".json")
    } catch (_: Exception) {
        return null
    }
    try {
        val pb = ProcessBuilder(claude, "auth", "status", "--json")
        pb.environment().clear()
        pb.environment().putAll(accountEnv(dir, home, env))
        if (File(home).isDirectory) pb.directory(File(home))
        pb.redirectOutput(out)
        pb.redirectError(ProcessBuilder.Redirect.DISCARD)
        val proc = pb.start()
        proc.outputStream.close()
        if (!proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
            proc.destroyForcibly()
            return null
        }
        // Signed out, claude exits 1 and still prints the status.
        return parseAuthStatus(out.readText(), now(), dir)
    } catch (_: Exception) {
        return null
    } finally {
        out.delete()
    }
}

/**
 * The line typed into a new IDE terminal tab to sign the account in again. It runs claude by its full path (a
 * `claude()` wrapper in the shell profile would sign the folder's account in instead) and without a browser: the
 * default one is usually signed in to another Claude account, so claude prints the link and waits for the code.
 */
fun signInCommand(dir: String, home: String, claude: String, windows: Boolean = IS_WINDOWS_AUTH): String {
    val isDefault = pathKey(dir, windows) == pathKey(File(home, ".claude").path, windows)
    if (windows) {
        val q = { s: String -> "'" + s.replace("'", "''") + "'" }
        val env = if (isDefault) "Remove-Item Env:\\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue" else "\$env:CLAUDE_CONFIG_DIR=${q(dir)}"
        return "$env; & ${q(claude)} auth login"
    }
    val q = { s: String -> "'" + s.replace("'", "'\\''") + "'" }
    val config = if (isDefault) "" else "CLAUDE_CONFIG_DIR=${q(dir)} "
    return "env -u CLAUDE_CONFIG_DIR ${config}BROWSER=/usr/bin/true ${q(claude)} auth login"
}
