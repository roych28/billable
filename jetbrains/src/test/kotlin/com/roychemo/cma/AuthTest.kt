package com.roychemo.cma

import com.roychemo.cma.core.Account
import com.roychemo.cma.core.AuthCheck
import com.roychemo.cma.core.SharedSignIn
import com.roychemo.cma.core.sharedSignIns
import com.roychemo.cma.core.CmaPaths
import com.roychemo.cma.core.Json
import com.roychemo.cma.core.LoginState
import com.roychemo.cma.core.SignIn
import com.roychemo.cma.core.TranscriptReader
import com.roychemo.cma.core.View
import com.roychemo.cma.core.accountEnv
import com.roychemo.cma.core.authDue
import com.roychemo.cma.core.authFile
import com.roychemo.cma.core.authOf
import com.roychemo.cma.core.findClaude
import com.roychemo.cma.core.liveAccount
import com.roychemo.cma.core.loginState
import com.roychemo.cma.core.parseAuthStatus
import com.roychemo.cma.core.readAccounts
import com.roychemo.cma.core.readAuth
import com.roychemo.cma.core.recordAuth
import com.roychemo.cma.core.runAuthStatus
import com.roychemo.cma.core.signInCommand
import com.roychemo.cma.core.signInNote
import com.roychemo.cma.core.signInOf
import com.roychemo.cma.core.signedOut
import com.roychemo.cma.core.stringify
import com.roychemo.cma.core.timeLeft
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.Instant

// Ported from "Sign-ins that end" in vscode/test/lib.test.js (0.9.0). Every test works in a fresh temp dir and never
// runs the real claude: the runner tests use a stand-in script.
class AuthTest {
    // The shapes `claude auth status --json` printed on 21.11.2026 (Claude Code 2.1.326), trimmed.
    private val live = """{"loggedIn":true,"authMethod":"claude.ai","loginExpiresAt":"2026-12-20T18:05:15.755Z","email":"me@home.test","subscriptionType":"max"}"""
    private val dead = """{"loggedIn":false,"authMethod":"none","loginExpiresAt":null}"""
    private val day = 24 * 3600_000L
    private val now = Instant.parse("2026-11-21T12:00:00Z").toEpochMilli()

    private fun sandbox(): CmaPaths {
        val home = Files.createTempDirectory("cma-").toRealPath().toString()
        return CmaPaths.of(home, emptyMap())
    }

    private fun signedInAs(dir: File, email: String) {
        dir.mkdirs()
        File(dir, ".claude.json").writeText("""{"oauthAccount":{"emailAddress":"$email"}}""")
    }

    @Test
    fun `claude auth status is read for whether the sign-in works, its end and its email, and anything else is no answer`() {
        assertEquals(AuthCheck(now, true, "me@home.test", Instant.parse("2026-12-20T18:05:15.755Z").toEpochMilli()), parseAuthStatus(live, now))
        assertEquals(AuthCheck(now, false, null, null), parseAuthStatus("$dead\n", now))
        // An API key sign-in has no end.
        assertNull(parseAuthStatus("""{"loggedIn":true,"authMethod":"apiKey"}""", now)!!.expiresAt)
        // Asked about one folder, answered about another: a launcher on the way picked the account by folder.
        val about = { d: String -> """{"loggedIn":true,"configDirectory":"$d","email":"x@y.test"}""" }
        assertNull(parseAuthStatus(about("/Users/t/.claude-b"), now, "/Users/t/.claude-a"))
        assertEquals("x@y.test", parseAuthStatus(about("/Users/t/.claude-a"), now, "/Users/t/.claude-a/")!!.email)
        for (junk in listOf("", null, "Logged in as me", """{"ok":true}""", "null", "[]")) assertNull(junk.toString(), parseAuthStatus(junk, now))
    }

    @Test
    fun `a sign-in is ok, ends within three days, or is signed out once it ended or claude says so`() {
        val at = { end: Long? -> AuthCheck(now, true, "a@b.test", end) }
        assertEquals(LoginState.UNKNOWN, loginState(null, now))
        assertEquals(LoginState.OK, loginState(at(null), now))
        assertEquals(LoginState.OK, loginState(at(now + 29 * day), now))
        assertEquals(LoginState.ENDING, loginState(at(now + 3 * day), now))
        assertEquals(LoginState.ENDING, loginState(at(now + 60_000), now))
        assertEquals("past its end, even before the next check", LoginState.SIGNED_OUT, loginState(at(now - 1), now))
        assertEquals(LoginState.SIGNED_OUT, loginState(at(null).copy(loggedIn = false), now))
    }

    @Test
    fun `an account whose sign-in ended reads as signed out although its email is still on file`() {
        val p = sandbox()
        val dir = File(p.home, ".claude-kashuv")
        signedInAs(dir, "support@client.test")
        File(p.base).mkdirs()
        File(p.accounts).writeText("mine\t~/.claude\nkashuv\t~/.claude-kashuv\n")
        File(p.folders).writeText("*\tkashuv\n")
        File(p.home, ".claude.json").writeText("""{"oauthAccount":{"emailAddress":"me@home.test"}}""")
        // Never checked: only the email is known, as before.
        assertEquals(LoginState.UNKNOWN, signInOf(p, dir.path).state)
        assertFalse(signedOut(p, dir.path))
        recordAuth(p, dir.path, parseAuthStatus(dead)!!)
        assertEquals(LoginState.SIGNED_OUT, signInOf(p, dir.path).state)
        assertTrue(signedOut(p, dir.path))
        val v = View.compute(p, listOf("/w/app"), TranscriptReader())!!
        assertEquals("kashuv", v.currentName)
        assertEquals("the email is still shown", "support@client.test", v.email)
        assertTrue(v.signIn.ended)
        assertTrue(v.error)
        assertEquals("kashuv signed out", v.statusText())
        assertTrue(v.signInLine()!!.startsWith("kashuv is signed out."))
        // Where the folder can go meanwhile: the default account, never checked but signed in by its file.
        assertEquals("mine", liveAccount(p, readAccounts(p), "kashuv")!!.name)
        recordAuth(p, File(p.home, ".claude").path, parseAuthStatus(dead)!!)
        assertNull(liveAccount(p, readAccounts(p), "kashuv"))
    }

    @Test
    fun `two accounts on one Claude sign-in are flagged, but not a sign-in that ended`() {
        val p = sandbox()
        val a = File(p.home, ".claude-a")
        val b = File(p.home, ".claude-b")
        val c = File(p.home, ".claude-c")
        signedInAs(a, "Me@Client.test")
        signedInAs(b, "me@client.test")
        signedInAs(c, "other@client.test")
        val accounts = listOf(Account("a", a.path), Account("b", b.path), Account("c", c.path))
        assertEquals(listOf(SharedSignIn("Me@Client.test", listOf("a", "b"))), sharedSignIns(p, accounts))
        // A dead sign-in is not "the same Claude account" as a live one with that email.
        recordAuth(p, b.path, parseAuthStatus(dead)!!)
        assertTrue(sharedSignIns(p, accounts).isEmpty())
    }

    @Test
    fun `an account with no email that was never checked is not signed in, not signed out`() {
        val p = sandbox()
        val fresh = signInOf(p, File(p.home, ".claude-new").path)
        assertEquals(LoginState.SIGNED_OUT, fresh.state)
        assertFalse("only claude's word makes it an ended sign-in", fresh.ended)
        assertEquals(" (not signed in)", signInNote(fresh))
        assertEquals(" (signed out)", signInNote(SignIn(LoginState.SIGNED_OUT, null, now), now))
        assertEquals(" (sign-in ends in 2 days)", signInNote(SignIn(LoginState.ENDING, now + 2 * day + 5, now), now))
        assertEquals("", signInNote(SignIn(LoginState.OK, now + 20 * day, now), now))
        assertEquals("", signInNote(SignIn(LoginState.UNKNOWN, null, null), now))
    }

    @Test
    fun `a sign-in about to end turns the status bar amber and says how long is left`() {
        val p = sandbox()
        val dir = File(p.home, ".claude-acme")
        signedInAs(dir, "me@acme.test")
        File(p.base).mkdirs()
        File(p.accounts).writeText("acme\t~/.claude-acme\n")
        File(p.folders).writeText("*\tacme\n")
        recordAuth(p, dir.path, AuthCheck(now, true, "me@acme.test", now + 2 * day + 3 * 3600_000L))
        val v = View.compute(p, listOf("/w/app"), TranscriptReader(), now)!!
        assertTrue(v.ending)
        assertTrue(v.warn)
        assertFalse(v.error)
        assertEquals("acme  ·  sign-in ends in 2 days", v.statusText())
        assertTrue(v.signInLine()!!.startsWith("acme's sign-in ends in 2 days ("))
        // Far from its end: nothing to say.
        recordAuth(p, dir.path, AuthCheck(now, true, "me@acme.test", now + 20 * day))
        val ok = View.compute(p, listOf("/w/app"), TranscriptReader(), now)!!
        assertFalse(ok.warn)
        assertNull(ok.signInLine())
        assertEquals("acme", ok.statusText())
    }

    @Test
    fun `the checks are kept per account folder, and a broken file reads as no checks`() {
        val p = sandbox()
        val a = File(p.home, ".claude-a").path
        recordAuth(p, "$a/", parseAuthStatus(live, 5)!!)
        recordAuth(p, File(p.home, ".claude-b").path, parseAuthStatus(dead, 6)!!)
        assertEquals("a trailing slash is the same folder", "me@home.test", authOf(p, a)!!.email)
        assertEquals(false, authOf(p, File(p.home, ".claude-b").path)!!.loggedIn)
        assertNull(authOf(p, File(p.home, ".claude-c").path))
        authFile(p).writeText("{not json")
        assertTrue(readAuth(p).isEmpty())
        assertNull(authOf(p, a))
    }

    @Test
    fun `auth json is written exactly as the VS Code extension writes it, and its entries are kept`() {
        val p = sandbox()
        File(p.base).mkdirs()
        // What vscode/lib.js recordAuth wrote (JSON.stringify(all, null, 2)), with an entry this plugin does not touch.
        val fromVsCode = "{\n  \"/a\": {\n    \"at\": 5,\n    \"loggedIn\": true,\n    \"email\": \"me@home.test\",\n    \"expiresAt\": 1797789915755\n  }\n}"
        authFile(p).writeText(fromVsCode)
        assertEquals(AuthCheck(5, true, "me@home.test", 1797789915755), authOf(p, "/a"))
        recordAuth(p, "/b", AuthCheck(6, false, null, null))
        assertEquals(
            fromVsCode.removeSuffix("\n}") + ",\n  \"/b\": {\n    \"at\": 6,\n    \"loggedIn\": false,\n    \"email\": null,\n    \"expiresAt\": null\n  }\n}",
            authFile(p).readText(),
        )
        assertEquals("{}", Json.stringify(emptyMap<String, Any?>()))
        assertEquals("\"a\\\"b\\\\c\\n\"", Json.stringify("a\"b\\c\n"))
        assertTrue("no temp file is left", File(p.base).list()!!.none { it.endsWith(".tmp") })
    }

    @Test
    fun `a check is due when missing or old, sooner for a signed-out account, and at once after a sign-in writes its file`() {
        val p = sandbox()
        val dir = File(p.home, ".claude-a")
        dir.mkdirs()
        val file = File(dir, ".claude.json")
        file.writeText("{}")
        val t = System.currentTimeMillis()
        file.setLastModified(t - 3600_000)
        assertTrue("never checked", authDue(p, dir.path, t))
        recordAuth(p, dir.path, parseAuthStatus(live, t)!!)
        assertFalse(authDue(p, dir.path, t + 60_000))
        assertTrue(authDue(p, dir.path, t + 11 * 60_000))
        recordAuth(p, dir.path, parseAuthStatus(dead, t)!!)
        assertFalse(authDue(p, dir.path, t + 60_000))
        assertTrue("a signed-out account is checked again sooner", authDue(p, dir.path, t + 3 * 60_000))
        // A sign-in in a terminal writes the login file after the check.
        file.setLastModified(t + 1000)
        assertTrue(authDue(p, dir.path, t + 30_000))
    }

    @Test
    fun `claude is pointed at the account with CLAUDE_CONFIG_DIR, except ~ claude, which has none`() {
        val home = "/Users/t"
        assertEquals("/Users/t/.claude-a", accountEnv("/Users/t/.claude-a", home, mapOf("CLAUDE_CONFIG_DIR" to "/x", "PATH" to "/bin"))["CLAUDE_CONFIG_DIR"])
        val def = accountEnv("/Users/t/.claude/", home, mapOf("CLAUDE_CONFIG_DIR" to "/x", "PATH" to "/bin"))
        assertFalse("naming ~/.claude makes claude report \"not logged in\"", "CLAUDE_CONFIG_DIR" in def)
        assertEquals("/bin", def["PATH"])
    }

    @Test
    fun `the time left reads in days, hours or minutes`() {
        assertEquals("in 2 days", timeLeft((2.5 * day).toLong()))
        assertEquals("in 1 day", timeLeft(day))
        assertEquals("in 5 hours", timeLeft(5 * 3600_000L + 10))
        assertEquals("in 1 minute", timeLeft(60_000))
        assertEquals("in 1 minute", timeLeft(5))
    }

    // A stand-in for claude: answers about the folder in CLAUDE_CONFIG_DIR, or as the default account without one.
    private fun fakeClaude(p: CmaPaths, body: String): String {
        val f = File(p.home, "bin/claude")
        f.parentFile.mkdirs()
        f.writeText("#!/bin/sh\n$body\n")
        f.setExecutable(true)
        return f.path
    }

    @Test
    fun `the runner asks claude about the account folder, and the default account without CLAUDE_CONFIG_DIR`() {
        val p = sandbox()
        val claude = fakeClaude(
            p,
            """
            [ "${'$'}1 ${'$'}2 ${'$'}3" = "auth status --json" ] || exit 2
            if [ -n "${'$'}CLAUDE_CONFIG_DIR" ]; then
              echo '{"loggedIn":false,"loginExpiresAt":null,"configDirectory":"'"${'$'}CLAUDE_CONFIG_DIR"'"}'; exit 1
            fi
            echo '{"loggedIn":true,"email":"me@home.test","loginExpiresAt":"2026-12-20T18:05:15.755Z"}'
            """.trimIndent(),
        )
        val env = mapOf("PATH" to "/usr/bin:/bin", "CLAUDE_CONFIG_DIR" to "/somewhere/else")
        val acme = File(p.home, ".claude-acme").path
        val r = runAuthStatus(claude, acme, p.home, env, now = { 7 })
        assertEquals("signed out, claude exits 1 and still prints the status", AuthCheck(7, false, null, null), r)
        val def = runAuthStatus(claude, File(p.home, ".claude").path, p.home, env, now = { 8 })
        assertEquals("me@home.test", def!!.email)
        // A claude that answers about another folder, or nothing at all, or too late, is no answer.
        val other = fakeClaude(p, """echo '{"loggedIn":true,"email":"x@y.test","configDirectory":"/elsewhere"}'""")
        assertNull(runAuthStatus(other, acme, p.home, env))
        assertNull(runAuthStatus(fakeClaude(p, "echo 'Logged in'"), acme, p.home, env))
        assertNull(runAuthStatus(fakeClaude(p, "sleep 5"), acme, p.home, env, timeoutMs = 300))
        assertNull(runAuthStatus(File(p.home, "missing").path, acme, p.home, env))
    }

    @Test
    fun `claude is found on the PATH first, then where its installers put it`() {
        val p = sandbox()
        assertFalse(findClaude(p.home, mapOf("PATH" to File(p.home, "nothing").path), false)?.startsWith(p.home) == true)
        val local = File(p.home, ".local/bin/claude")
        local.parentFile.mkdirs()
        local.writeText("#!/bin/sh\n")
        local.setExecutable(true)
        assertEquals(local.path, findClaude(p.home, mapOf("PATH" to "/nonexistent"), false))
        val onPath = File(p.home, "tools/claude")
        onPath.parentFile.mkdirs()
        onPath.writeText("#!/bin/sh\n")
        onPath.setExecutable(true)
        assertEquals(onPath.path, findClaude(p.home, mapOf("PATH" to "/nonexistent:${onPath.parent}"), false))
    }

    @Test
    fun `the sign-in line runs claude by its path, on the account's folder, without a browser`() {
        val home = "/Users/t"
        assertEquals(
            "env -u CLAUDE_CONFIG_DIR CLAUDE_CONFIG_DIR='/Users/t/.claude-acme' BROWSER=/usr/bin/true '/opt/bin/claude' auth login",
            signInCommand("/Users/t/.claude-acme", home, "/opt/bin/claude", false),
        )
        assertEquals(
            "env -u CLAUDE_CONFIG_DIR BROWSER=/usr/bin/true '/opt/bin/claude' auth login",
            signInCommand("/Users/t/.claude/", home, "/opt/bin/claude", false),
        )
        assertEquals(
            "env -u CLAUDE_CONFIG_DIR CLAUDE_CONFIG_DIR='/Users/t/it'\\''s' BROWSER=/usr/bin/true '/opt/bin/claude' auth login",
            signInCommand("/Users/t/it's", home, "/opt/bin/claude", false),
        )
        assertEquals(
            "\$env:CLAUDE_CONFIG_DIR='C:\\Users\\t\\.claude-acme'; & 'C:\\bin\\claude.exe' auth login",
            signInCommand("C:\\Users\\t\\.claude-acme", "C:\\Users\\t", "C:\\bin\\claude.exe", true),
        )
    }
}
