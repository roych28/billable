package com.roychemo.cma

import com.roychemo.cma.core.Account
import com.roychemo.cma.core.CmaPaths
import com.roychemo.cma.core.Inherited
import com.roychemo.cma.core.Rule
import com.roychemo.cma.core.TranscriptReader
import com.roychemo.cma.core.Tokens
import com.roychemo.cma.core.View
import com.roychemo.cma.core.accountFor
import com.roychemo.cma.core.emailOf
import com.roychemo.cma.core.inheritedAccount
import com.roychemo.cma.core.latestStatus
import com.roychemo.cma.core.pin
import com.roychemo.cma.core.readAccounts
import com.roychemo.cma.core.readRules
import com.roychemo.cma.core.shellFunction
import com.roychemo.cma.core.short
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

// Ported from vscode/test/lib.test.js. Every test works in a fresh temp dir and passes its own environment,
// so nothing reads or writes the real ~/.claude* or ~/.claude-multi-account.
class SetupTest {
    private fun sandbox(): CmaPaths {
        val home = Files.createTempDirectory("cma-").toRealPath().toString()
        return CmaPaths.of(home, emptyMap())
    }

    private fun assistant(id: String, input: Int, output: Int, cacheRead: Int, cacheWrite: Int) =
        """{"type":"assistant","message":{"id":"$id","usage":{"input_tokens":$input,"output_tokens":$output,""" +
            """"cache_read_input_tokens":$cacheRead,"cache_creation_input_tokens":$cacheWrite}}}"""

    @Test
    fun `the base folder follows CLAUDE_MULTI_ACCOUNT_HOME, and account dirs still expand to home`() {
        val home = Files.createTempDirectory("cma-").toRealPath().toString()
        val base = Files.createTempDirectory("cma-base-").toRealPath().toString()
        assertEquals("$home/.claude-multi-account", CmaPaths.of(home, emptyMap()).base)
        assertEquals("$home/.claude-multi-account", CmaPaths.of(home, mapOf("CLAUDE_MULTI_ACCOUNT_HOME" to "")).base)
        val p = CmaPaths.of(home, mapOf("CLAUDE_MULTI_ACCOUNT_HOME" to base))
        assertEquals("$base/folders", p.folders)
        File(p.accounts).writeText("acme\t~/.claude-acme\n")
        assertEquals(listOf(Account("acme", "$home/.claude-acme")), readAccounts(p))
    }

    @Test
    fun `tokens count each message once and pick up what is appended later`() {
        val p = sandbox()
        val file = File(p.home, "s1.jsonl")
        val partial = assistant("m3", 1, 1, 1, 1)
        file.writeText(
            listOf(assistant("m1", 10, 5, 100, 20), assistant("m1", 10, 5, 100, 20), assistant("m2", 1, 2, 3, 4), "").joinToString("\n") +
                partial.substring(0, 20),
        )
        val reader = TranscriptReader()
        assertEquals(Tokens(11, 7, 103, 24), reader.sessionTokens(file.path))
        file.appendText(partial.substring(20) + "\n")
        assertEquals(Tokens(12, 8, 104, 25), reader.sessionTokens(file.path))
        assertNull(reader.sessionTokens(File(p.home, "missing.jsonl").path))
    }

    @Test
    fun `a multibyte character split across reads is decoded whole`() {
        val p = sandbox()
        val file = File(p.home, "s2.jsonl")
        val line = """{"type":"assistant","note":"שלום","message":{"id":"x","usage":{"input_tokens":3,"output_tokens":4}}}""" + "\n"
        val bytes = line.toByteArray()
        val cut = line.indexOf('ש') + 1 // inside the two bytes of the first Hebrew letter
        file.writeBytes(bytes.copyOfRange(0, cut))
        val reader = TranscriptReader()
        assertEquals(Tokens(0, 0, 0, 0), reader.sessionTokens(file.path))
        file.appendBytes(bytes.copyOfRange(cut, bytes.size))
        assertEquals(Tokens(3, 4, 0, 0), reader.sessionTokens(file.path))
    }

    @Test
    fun `the longest folder rule wins, then the default`() {
        val rules = listOf(Rule("*", "personal"), Rule("/w", "acme"), Rule("/w/globex", "globex"))
        assertEquals("globex", accountFor("/w/globex/api", rules, false))
        assertEquals("acme", accountFor("/w/app", rules, false))
        assertEquals("personal", accountFor("/wx", rules, false))
        assertNull(accountFor("/x", emptyList(), false))
    }

    @Test
    fun `pinning a folder keeps the other rules, and auto removes the pin`() {
        val p = sandbox()
        File(p.base).mkdirs()
        File(p.folders).writeText("# rules\n*\tpersonal\n~/code/other\tacme\n")
        pin(p, "${p.home}/code/app", "globex", false)
        val rules = readRules(p)
        assertEquals("globex", accountFor("${p.home}/code/app/src", rules, false))
        assertEquals("acme", accountFor("${p.home}/code/other", rules, false))
        pin(p, "${p.home}/code/app", "auto", false)
        assertEquals("personal", accountFor("${p.home}/code/app", readRules(p), false))
        assertTrue(File(p.folders).readText().startsWith("# rules"))
    }

    @Test
    fun `pinning creates the setup folder when there is none`() {
        val p = sandbox()
        pin(p, "${p.home}/w", "acme", false)
        assertEquals("${p.home}/w\tacme\n", File(p.folders).readText())
    }

    @Test
    fun `without an accounts file the default account is the plain Claude dir`() {
        val p = sandbox()
        assertEquals(listOf(Account("default", "${p.home}/.claude")), readAccounts(p))
    }

    @Test
    fun `the email comes from the account's own claude json, and home's for the default dir`() {
        val p = sandbox()
        File(p.home, ".claude.json").writeText("""{"oauthAccount":{"emailAddress":"me@home.test"}}""")
        File(p.home, ".claude-acme").mkdirs()
        File(p.home, ".claude-acme/.claude.json").writeText("""{"oauthAccount":{"emailAddress":"me@acme.test"}}""")
        assertEquals("me@home.test", emailOf("${p.home}/.claude", p.home))
        assertEquals("me@acme.test", emailOf("${p.home}/.claude-acme", p.home))
        assertEquals("not signed in", emailOf("${p.home}/.claude-none", p.home))
    }

    @Test
    fun `the launcher picks the same account as the plugin`() {
        val p = sandbox()
        File(p.base).mkdirs()
        File(p.accounts).writeText("personal\t~/.claude\nacme\t~/.claude-acme\nglobex\t~/.claude-globex\n")
        File(p.folders).writeText("*\tpersonal\n~/w\tacme\n~/w/globex\tglobex\n")
        val cma = File(p.home, "cma")
        cma.writeBytes(javaClass.getResourceAsStream("/launcher/cma")!!.readBytes())
        fun launch(vararg args: String): String {
            val pb = ProcessBuilder(listOf("sh", cma.path) + args)
            pb.environment().apply {
                put("HOME", p.home)
                put("CLAUDE_MULTI_ACCOUNT_HOME", p.base)
            }
            val proc = pb.start()
            assertTrue(proc.waitFor(10, TimeUnit.SECONDS))
            return proc.inputStream.bufferedReader().readText().trim()
        }
        val accounts = readAccounts(p).associate { it.name to it.dir }
        for (d in listOf("w/globex/api", "w/app", "elsewhere")) {
            val folder = "${p.home}/$d"
            assertEquals(accounts[accountFor(folder, readRules(p), false)], launch("dir", folder))
        }
        assertEquals("${p.home}/.claude-globex", launch("dir", "${p.home}/w/globex/api"))
    }

    @Test
    fun `the latest status can be narrowed to one account`() {
        val p = sandbox()
        File(p.sessions).mkdirs()
        fun row(id: String, account: String, updatedAt: Int) =
            File(p.sessions, "$id.json").writeText("""{"sessionId":"$id","cwd":"/w/app","account":{"name":"$account"},"updatedAt":$updatedAt}""")
        row("a", "acme", 1)
        row("b", "personal", 2)
        row("c", "acme", 3)
        File(p.sessions, "broken.json").writeText("{nope")
        assertEquals("c", latestStatus(p, listOf("/w/app"))?.sessionId)
        assertEquals("b", latestStatus(p, listOf("/w/app"), "personal")?.sessionId)
        assertNull(latestStatus(p, listOf("/w/app"), "globex"))
        assertNull(latestStatus(p, listOf("/w/other")))
    }

    @Test
    fun `on Windows folder rules ignore case and slash direction`() {
        val rules = listOf(Rule("C:\\Work\\Acme", "acme"), Rule("*", "personal"))
        assertEquals("acme", accountFor("c:\\work\\acme\\app", rules, true))
        assertEquals("acme", accountFor("C:/Work/Acme", rules, true))
        assertEquals("personal", accountFor("C:\\Work\\Acme-other", rules, true))
        assertNull(accountFor("/work/Acme/app", listOf(Rule("/work/acme", "acme")), false))
    }

    @Test
    fun `the inherited account is what a folder falls back to once its own rule is dropped`() {
        val rules = listOf(Rule("*", "personal"), Rule("/w", "acme"), Rule("/w/app", "globex"))
        assertEquals(Inherited("acme"), inheritedAccount("/w/app", rules, false))
        assertEquals(Inherited("personal"), inheritedAccount("/w", rules, false))
        assertNull(inheritedAccount("/w/app/sub", rules, false))
        assertNull(inheritedAccount("/elsewhere", rules, false))
        assertEquals(Inherited(null), inheritedAccount("/w/app", listOf(Rule("/w/app", "globex")), false))
    }

    @Test
    fun `the status bar shows the folder's account, the session's usage and the top limit`() {
        val p = sandbox()
        File(p.base).mkdirs()
        File(p.accounts).writeText("personal\t~/.claude\nacme\t~/.claude-acme\n")
        File(p.folders).writeText("*\tpersonal\n/w/app\tacme\n")
        File(p.sessions).mkdirs()
        val transcript = File(p.home, "t.jsonl")
        transcript.writeText(assistant("m1", 1000, 500, 10_000, 0) + "\n")
        File(p.sessions, "s1.json").writeText(
            """{"sessionId":"s1","cwd":"/w/app/src","transcript":"${transcript.path}","account":{"name":"acme","email":"me@acme.test"},""" +
                """"usage":{"usd":1.234,"limits":[{"kind":"five_hour","percentUsed":45},{"kind":"seven_day","percentUsed":91}]},"updatedAt":5}""",
        )
        File(p.sessions, "s2.json").writeText(
            """{"sessionId":"s2","cwd":"/w/app","account":{"name":"personal","email":"me@home.test"},"usage":{"usd":9,"limits":[]},"updatedAt":9}""",
        )
        val v = View.compute(p, listOf("/w/app"), TranscriptReader())!!
        assertEquals("acme", v.currentName)
        assertEquals("me@acme.test", v.email)
        assertEquals("acme  ·  12K  ·  \$1.23  ·  91%  ·  chat on personal", v.statusText())
        assertTrue(v.warn)
        assertEquals("personal", v.inherit)
        assertEquals("5-hour limit: 45%", v.usageLines()[2])
        assertEquals("Weekly limit: 91%", v.usageLines()[3])

        pin(p, "/w/app", "auto", false)
        val after = View.compute(p, listOf("/w/app"), TranscriptReader())!!
        assertEquals("personal", after.currentName)
        assertNull(after.openOn)
        assertNull(after.inherit)
        assertFalse(after.warn)
    }

    @Test
    fun `the shell function is the README's line, and quotes a base folder that needs it`() {
        val home = "/Users/me"
        assertEquals(
            "claude() { ~/.claude-multi-account/bin/cma exec claude \"\$@\"; }",
            shellFunction(CmaPaths.of(home, emptyMap())),
        )
        assertEquals(
            "claude() { \"\$HOME/My Setup/bin/cma\" exec claude \"\$@\"; }",
            shellFunction(CmaPaths.of(home, mapOf("CLAUDE_MULTI_ACCOUNT_HOME" to "/Users/me/My Setup"))),
        )
        assertEquals(
            "claude() { /opt/cma/bin/cma exec claude \"\$@\"; }",
            shellFunction(CmaPaths.of(home, mapOf("CLAUDE_MULTI_ACCOUNT_HOME" to "/opt/cma"))),
        )
    }

    @Test
    fun `token counts are shortened as in VS Code`() {
        assertEquals("999", short(999))
        assertEquals("2K", short(1500))
        assertEquals("12K", short(11_500))
        assertEquals("2.5M", short(2_500_000))
    }
}
