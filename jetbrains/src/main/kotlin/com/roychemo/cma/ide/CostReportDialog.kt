package com.roychemo.cma.ide

import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import com.roychemo.cma.core.Report
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.datatransfer.StringSelection
import java.awt.event.ActionEvent
import java.nio.file.Paths
import javax.swing.AbstractAction
import javax.swing.Action
import javax.swing.JComponent
import javax.swing.JEditorPane
import javax.swing.JLabel
import javax.swing.JPanel

/** What each account, and each folder under it, cost in a month: the same figures as the VS Code report. */
class CostReportDialog(private val project: Project) : DialogWrapper(project) {
    private val entries = Report.readLedger(Cma.paths.ledger)
    private val free = Report.freeMonths()
    private val pro = Licensing.isPro()
    private val months = ComboBox(Report.months(entries).toTypedArray())
    private val page = JEditorPane("text/html", "").apply { isEditable = false }

    init {
        title = "Claude Cost by Account"
        months.renderer = SimpleListCellRenderer.create("") { m -> if (open(m)) m else "$m (Pro)" }
        months.addActionListener { render() }
        init()
        render()
    }

    private fun open(month: String) = pro || month in free

    private val month: String get() = months.selectedItem as String

    private fun render() {
        page.text = if (open(month)) {
            Report.toHtml(Report.summarize(entries, month), month, Cma.paths.home)
        } else {
            "<html><body><p>The full history is part of Billable Pro. This month and the one before are free.</p></body></html>"
        }
        page.caretPosition = 0
    }

    override fun createCenterPanel(): JComponent {
        val top = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply {
            add(JLabel("Month: "))
            add(months)
        }
        return JPanel(BorderLayout(0, JBUI.scale(8))).apply {
            add(top, BorderLayout.NORTH)
            add(JBScrollPane(page), BorderLayout.CENTER)
            preferredSize = JBUI.size(640, 480)
        }
    }

    override fun createLeftSideActions(): Array<Action> = arrayOf(
        object : AbstractAction("Export CSV...") {
            override fun actionPerformed(e: ActionEvent) = exportCsv()
        },
        object : AbstractAction("Copy as Markdown") {
            override fun actionPerformed(e: ActionEvent) {
                if (!open(month)) return Licensing.requestLicense("The full cost history is part of Billable Pro.")
                CopyPasteManager.getInstance().setContents(
                    StringSelection(Report.toMarkdown(Report.summarize(entries, month), month, Cma.paths.home)),
                )
            }
        },
    )

    override fun createActions(): Array<Action> = arrayOf(okAction.apply { putValue(Action.NAME, "Close") })

    private fun exportCsv() {
        if (!Licensing.isPro()) return Licensing.requestLicense("CSV export for invoices is part of Billable Pro.")
        val m = month
        val descriptor = FileSaverDescriptor("Export CSV", "One row per run of a session, for invoices", "csv")
        val target = FileChooserFactory.getInstance().createSaveFileDialog(descriptor, project)
            .save(Paths.get(Cma.paths.home), "claude-cost-$m.csv") ?: return
        try {
            target.file.writeText(Report.toCsv(entries, m))
            CmaPopup.notify(project, "Saved ${target.file.path}")
        } catch (e: Exception) {
            CmaPopup.notify(project, "Could not save ${target.file.path}: ${e.message}", com.intellij.notification.NotificationType.ERROR)
        }
    }
}
