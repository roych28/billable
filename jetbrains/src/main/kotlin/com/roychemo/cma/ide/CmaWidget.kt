package com.roychemo.cma.ide

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.wm.CustomStatusBarWidget
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.ui.ClickListener
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.roychemo.cma.core.CmaPaths
import com.roychemo.cma.core.TranscriptReader
import com.roychemo.cma.core.View
import java.awt.Cursor
import java.awt.event.MouseEvent
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class CmaWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = CmaWidget.ID
    override fun getDisplayName() = "Billable"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = CmaWidget(project)
    override fun canBeEnabledOn(statusBar: StatusBar) = true
}

/** Shared by all widgets: the setup files and the transcript reader keep their own incremental state. */
object Cma {
    /** `cma.home` is set only by this plugin's own tests, so they never see the real home folder. */
    val paths: CmaPaths by lazy { CmaPaths.of(System.getProperty("cma.home") ?: System.getProperty("user.home")) }
    val transcripts = TranscriptReader()
    private val widgets = CopyOnWriteArraySet<CmaWidget>()

    fun register(w: CmaWidget) = widgets.add(w)
    fun unregister(w: CmaWidget) = widgets.remove(w)

    /** After a switch every open project shows it at once, not at the next poll. */
    fun refreshAll() = widgets.forEach { it.refresh() }

    /** The project folder first (the folder rules apply to it), then the other content roots. */
    fun roots(project: Project): List<String> {
        val base = project.basePath
        val content = ReadAction.compute<List<String>, RuntimeException> {
            if (project.isDisposed) emptyList() else ProjectRootManager.getInstance(project).contentRoots.map { it.path }
        }
        return (listOfNotNull(base) + content).distinct()
    }

    fun view(project: Project): View? = View.compute(paths, roots(project), transcripts)
}

class CmaWidget(private val project: Project) : CustomStatusBarWidget {
    companion object {
        const val ID = "ClaudeMultiAccount"
        private val AMBER = JBColor(0xB26B00, 0xF0A732)
    }

    private val label = JBLabel().apply {
        border = JBUI.Borders.empty(0, 6)
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        isVisible = false
    }
    private var timer: ScheduledFuture<*>? = null
    @Volatile
    private var last: View? = null

    override fun ID() = ID

    override fun install(statusBar: StatusBar) {
        object : ClickListener() {
            override fun onClick(event: MouseEvent, clickCount: Int): Boolean {
                CmaPopup.show(project, label)
                return true
            }
        }.installOn(label)
        Cma.register(this)
        // Small local files only; reading them every 10 seconds costs less than watching the folders.
        timer = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay({ refresh() }, 0, 10, TimeUnit.SECONDS)
    }

    override fun getComponent() = label

    fun refresh() {
        if (project.isDisposed) return
        val v = try {
            Cma.view(project)
        } catch (_: Exception) {
            null
        }
        last = v
        ApplicationManager.getApplication().invokeLater({ show(v) }, project.disposed)
    }

    private fun show(v: View?) {
        if (v == null) {
            label.isVisible = false
            return
        }
        label.text = v.statusText()
        label.foreground = if (v.warn) AMBER else UIUtil.getLabelForeground()
        label.toolTipText = "<html><b>${esc(v.currentName)}</b> &nbsp;${esc(v.email)}<br>" +
            v.usageLines().joinToString("<br>") { esc(it) } + "<br><i>Click to switch or open the cost report</i></html>"
        label.isVisible = true
    }

    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    override fun dispose() {
        timer?.cancel(false)
        Cma.unregister(this)
    }
}
