package com.roychemo.cma.core

import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

// A port of vscode/report.js. The ledger is written by the Claude Code plugin: one file per run of a session,
// with the account it ran on and Claude Code's own cost figure for that run.

data class LedgerEntry(
    val sessionId: String?,
    val account: String,
    val email: String?,
    val folder: String?,
    val startedAt: Double,
    val updatedAt: Double?,
    val usd: Double,
)

data class FolderCost(val folder: String, val usd: Double, val sessions: Int)

data class AccountCost(val account: String, val email: String?, val usd: Double, val sessions: Int, val folders: List<FolderCost>)

object Report {
    const val FOOTNOTE =
        "Cost is Claude Code's own figure at API prices. On a Pro or Max plan it measures the work done, not what the plan charged."

    fun parseEntry(text: String): LedgerEntry? {
        val o = Json.parseOrNull(text).obj() ?: return null
        val usd = o["usd"] as? Double ?: return null
        val account = (o["account"] as? String)?.takeIf { it.isNotEmpty() } ?: return null
        val startedAt = (o["startedAt"] as? Double)?.takeIf { it != 0.0 } ?: return null
        return LedgerEntry(o.str("sessionId"), account, o.str("email"), o.str("folder"), startedAt, o.num("updatedAt"), usd)
    }

    fun readLedger(dir: String): List<LedgerEntry> {
        val files = File(dir).list()?.filter { it.endsWith(".json") }?.sorted() ?: return emptyList()
        return files.mapNotNull {
            try {
                parseEntry(File(dir, it).readText())
            } catch (_: Exception) {
                null
            }
        }
    }

    fun monthOf(ms: Double, zone: ZoneId = ZoneId.systemDefault()): String {
        val d = Instant.ofEpochMilli(ms.toLong()).atZone(zone)
        return "%04d-%02d".format(d.year, d.monthValue)
    }

    fun months(entries: List<LedgerEntry>, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): List<String> {
        val set = entries.map { monthOf(it.startedAt, zone) }.toMutableSet()
        set.add(monthOf(now.toDouble(), zone))
        return set.sortedDescending()
    }

    /** The months anyone can open without Pro: this one and the one before. */
    fun freeMonths(now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): List<String> {
        val d = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().withDayOfMonth(1).minusMonths(1)
        return listOf(monthOf(now.toDouble(), zone), "%04d-%02d".format(d.year, d.monthValue))
    }

    fun summarize(entries: List<LedgerEntry>, month: String, zone: ZoneId = ZoneId.systemDefault()): List<AccountCost> {
        class F(val folder: String) {
            var usd = 0.0
            val sessions = HashSet<String?>()
        }

        class A(val account: String, val email: String?) {
            var usd = 0.0
            val sessions = HashSet<String?>()
            val folders = LinkedHashMap<String, F>()
        }

        val accounts = LinkedHashMap<String, A>()
        for (e in entries) {
            if (monthOf(e.startedAt, zone) != month) continue
            val a = accounts.getOrPut(e.account) { A(e.account, e.email) }
            a.usd += e.usd
            a.sessions.add(e.sessionId)
            val folder = e.folder.orEmpty()
            val f = a.folders.getOrPut(folder) { F(folder) }
            f.usd += e.usd
            f.sessions.add(e.sessionId)
        }
        return accounts.values
            .sortedByDescending { it.usd }
            .map { a ->
                AccountCost(
                    a.account,
                    a.email,
                    a.usd,
                    a.sessions.size,
                    a.folders.values.sortedByDescending { it.usd }.map { FolderCost(it.folder, it.usd, it.sessions.size) },
                )
            }
    }

    private fun tidy(folder: String, home: String) = if (home.isNotEmpty() && folder.startsWith(home)) "~" + folder.substring(home.length) else folder

    fun toMarkdown(summary: List<AccountCost>, month: String, home: String = ""): String {
        val lines = mutableListOf("# Claude cost by account, $month", "")
        if (summary.isEmpty()) {
            lines.add("No sessions recorded this month yet. The Claude Code plugin records each session as it runs.")
            return lines.joinToString("\n") + "\n"
        }
        lines.add("| Account | Email | Sessions | Cost |")
        lines.add("|---|---|---:|---:|")
        for (a in summary) lines.add("| **${a.account}** | ${a.email.orEmpty()} | ${a.sessions} | **${money(a.usd)}** |")
        lines.add("| Total | | ${summary.sumOf { it.sessions }} | **${money(summary.sumOf { it.usd })}** |")
        lines.add("")
        for (a in summary) {
            lines.addAll(listOf("## ${a.account}", "", "| Folder | Sessions | Cost |", "|---|---:|---:|"))
            for (f in a.folders) lines.add("| ${tidy(f.folder, home)} | ${f.sessions} | ${money(f.usd)} |")
            lines.add("")
        }
        lines.add(FOOTNOTE)
        return lines.joinToString("\n") + "\n"
    }

    /** The same report as an HTML page for the IDE's dialog. */
    fun toHtml(summary: List<AccountCost>, month: String, home: String = ""): String {
        fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
        val b = StringBuilder("<html><body>")
        b.append("<h2>Claude cost by account, ${esc(month)}</h2>")
        if (summary.isEmpty()) {
            b.append("<p>No sessions recorded this month yet. The Claude Code plugin records each session as it runs.</p></body></html>")
            return b.toString()
        }
        b.append("<table cellpadding='4'><tr><th align='left'>Account</th><th align='left'>Email</th><th align='right'>Sessions</th><th align='right'>Cost</th></tr>")
        for (a in summary) {
            b.append("<tr><td><b>${esc(a.account)}</b></td><td>${esc(a.email.orEmpty())}</td><td align='right'>${a.sessions}</td><td align='right'><b>${esc(money(a.usd))}</b></td></tr>")
        }
        b.append("<tr><td>Total</td><td></td><td align='right'>${summary.sumOf { it.sessions }}</td><td align='right'><b>${esc(money(summary.sumOf { it.usd }))}</b></td></tr></table>")
        for (a in summary) {
            b.append("<h3>${esc(a.account)}</h3><table cellpadding='4'><tr><th align='left'>Folder</th><th align='right'>Sessions</th><th align='right'>Cost</th></tr>")
            for (f in a.folders) b.append("<tr><td>${esc(tidy(f.folder, home))}</td><td align='right'>${f.sessions}</td><td align='right'>${esc(money(f.usd))}</td></tr>")
            b.append("</table>")
        }
        b.append("<p><small>${esc(FOOTNOTE)}</small></p></body></html>")
        return b.toString()
    }

    private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    private fun iso(ms: Double) = ISO.format(Instant.ofEpochMilli(ms.toLong()))

    private fun csvCell(v: String) = if (Regex("[\",\n]").containsMatchIn(v)) "\"" + v.replace("\"", "\"\"") + "\"" else v

    /** One row per run of a session in [month], oldest first: what an invoice needs. */
    fun toCsv(entries: List<LedgerEntry>, month: String, zone: ZoneId = ZoneId.systemDefault()): String {
        val rows = mutableListOf(listOf("month", "account", "email", "folder", "session", "started", "last_active", "usd"))
        for (e in entries.filter { monthOf(it.startedAt, zone) == month }.sortedBy { it.startedAt }) {
            rows.add(
                listOf(
                    month,
                    e.account,
                    e.email.orEmpty(),
                    e.folder.orEmpty(),
                    e.sessionId.orEmpty(),
                    iso(e.startedAt),
                    iso(e.updatedAt ?: e.startedAt),
                    toFixed(e.usd, 4),
                ),
            )
        }
        return rows.joinToString("\n") { r -> r.joinToString(",") { csvCell(it) } } + "\n"
    }
}
