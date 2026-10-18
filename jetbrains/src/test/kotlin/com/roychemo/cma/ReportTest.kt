package com.roychemo.cma

import com.roychemo.cma.core.FolderCost
import com.roychemo.cma.core.Json
import com.roychemo.cma.core.LedgerEntry
import com.roychemo.cma.core.LicenseStamp
import com.roychemo.cma.core.Report
import com.roychemo.cma.core.money
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.LocalDate
import java.time.ZoneId

// Ported from vscode/test/report.test.js, with the same fixtures and expected figures.
class ReportTest {
    private val zone = ZoneId.systemDefault()
    private fun local(y: Int, m: Int, d: Int) = LocalDate.of(y, m, d).atStartOfDay(zone).toInstant().toEpochMilli().toDouble()
    private val oct = local(2026, 10, 10)
    private val sep = local(2026, 9, 20)

    private fun entry(
        sessionId: String = "s1",
        account: String = "acme",
        email: String = "me@acme.test",
        folder: String = "/u/acme/app",
        startedAt: Double = oct,
        usd: Double = 1.0,
    ) = LedgerEntry(sessionId, account, email, folder, startedAt, startedAt, usd)

    @Test
    fun `the report sums each account and folder for the month, sessions counted once`() {
        val entries = listOf(
            entry(usd = 2.0),
            entry(usd = 0.5, startedAt = oct + 1000),
            entry(sessionId = "s2", folder = "/u/acme/api", usd = 1.0),
            entry(sessionId = "s3", account = "globex", email = "me@globex.test", usd = 4.0),
            entry(sessionId = "s4", usd = 9.0, startedAt = sep),
        )
        val s = Report.summarize(entries, "2026-10")
        assertEquals(listOf(Triple("globex", 4.0, 1), Triple("acme", 3.5, 2)), s.map { Triple(it.account, it.usd, it.sessions) })
        assertEquals(listOf(FolderCost("/u/acme/app", 2.5, 1), FolderCost("/u/acme/api", 1.0, 1)), s[1].folders)
        val md = Report.toMarkdown(s, "2026-10", "/u")
        assertTrue(md.contains("| **acme** | me@acme.test | 2 | **\$3.50** |"))
        assertTrue(md.contains("| Total | | 3 | **\$7.50** |"))
        assertTrue(md.contains("| ~/acme/app | 1 | \$2.50 |"))
        assertEquals(listOf("2026-10", "2026-09"), Report.months(entries, oct.toLong()))
        val html = Report.toHtml(s, "2026-10", "/u")
        assertTrue(html.contains("<b>acme</b>"))
        assertTrue(html.contains("~/acme/app"))
    }

    @Test
    fun `an empty month says so`() {
        assertEquals(
            "# Claude cost by account, 2026-10\n\nNo sessions recorded this month yet. The Claude Code plugin records each session as it runs.\n",
            Report.toMarkdown(emptyList(), "2026-10"),
        )
    }

    @Test
    fun `the CSV has one row per run of the month, and quotes what needs quoting`() {
        val csv = Report.toCsv(listOf(entry(folder = "/u/a,b"), entry(startedAt = sep)), "2026-10").trim().split("\n")
        assertEquals(2, csv.size)
        assertEquals("month,account,email,folder,session,started,last_active,usd", csv[0])
        assertTrue(csv[1], Regex("^2026-10,acme,me@acme\\.test,\"/u/a,b\",s1,").containsMatchIn(csv[1]))
        assertTrue(csv[1].endsWith(",1.0000"))
        assertTrue(Regex(",\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.000Z,").containsMatchIn(csv[1]))
    }

    @Test
    fun `the ledger reader skips broken files and the free months are this one and the last`() {
        val dir = Files.createTempDirectory("cma-ledger-").toFile()
        File(dir, "a.json").writeText(
            """{"sessionId":"s1","account":"acme","email":"me@acme.test","folder":"/u/acme/app","startedAt":${oct.toLong()},"updatedAt":${oct.toLong()},"usd":1}""",
        )
        File(dir, "b.json").writeText("{not json")
        File(dir, "c.json").writeText("""{"account":"x"}""")
        File(dir, "d.json").writeText("""{"account":"x","startedAt":0,"usd":1}""")
        File(dir, "notes.txt").writeText("ignored")
        val entries = Report.readLedger(dir.path)
        assertEquals(1, entries.size)
        assertEquals(entry(), entries[0])
        assertEquals(listOf("2026-01", "2025-12"), Report.freeMonths(local(2026, 1, 15).toLong()))
        assertEquals(emptyList<LedgerEntry>(), Report.readLedger(File(dir, "missing").path))
    }

    @Test
    fun `money rounds like JavaScript's toFixed`() {
        assertEquals("\$1.00", money(1.005)) // 1.005 is 1.00499... in binary
        assertEquals("\$0.13", money(0.125))
        assertEquals("\$7.50", money(7.5))
    }

    @Test
    fun `the JSON reader handles escapes, nesting and numbers`() {
        val v = Json.parse("""{"a":[1,-2.5e2,true,null],"b":{"c":"x\"yש\n"}}""") as Map<*, *>
        assertEquals(listOf(1.0, -250.0, true, null), v["a"])
        assertEquals("x\"yש\n", (v["b"] as Map<*, *>)["c"])
        assertEquals(null, Json.parseOrNull("{\"a\":1} trailing"))
    }

    @Test
    fun `license stamps that JetBrains did not sign are refused`() {
        assertEquals(2, LicenseStamp.rootCertificateCount())
        assertFalse(LicenseStamp.isValid(null))
        assertFalse(LicenseStamp.isValid(""))
        assertFalse(LicenseStamp.isValid("eval:123"))
        assertFalse(LicenseStamp.isValid("key:only-three-parts"))
        assertFalse(LicenseStamp.isValid("key:ABC-bGljZW5zZQ==-c2ln-Y2VydA=="))
        assertFalse(LicenseStamp.isValid("stamp:m1:0:m1:SHA1withRSA:c2ln:Y2VydA=="))
    }
}
