package com.roychemo.cma.ide

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.wm.WindowManager
import com.roychemo.cma.core.pruneSessions
import java.io.File

abstract class CmaAction : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}

class SwitchAccountAction : CmaAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val widget = WindowManager.getInstance().getStatusBar(project)?.getWidget(CmaWidget.ID) as? CmaWidget
        CmaPopup.show(project, widget?.component)
    }
}

class CostReportAction : CmaAction() {
    override fun actionPerformed(e: AnActionEvent) {
        CostReportDialog(e.project ?: return).show()
    }
}

class CopyShellFunctionAction : CmaAction() {
    override fun actionPerformed(e: AnActionEvent) {
        CmaPopup.copyShellFunction(e.project ?: return)
    }
}

class RefreshAction : CmaAction() {
    override fun actionPerformed(e: AnActionEvent) = Cma.refreshAll()
}

/**
 * On startup: drop session reports older than a week, and install the `cma` launcher that the terminal shell
 * function calls, unless it is there already (the VS Code extension installs and updates the same files).
 */
class CmaStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        val p = Cma.paths
        pruneSessions(p)
        if (SystemInfo.isWindows) return
        try {
            val bin = File(p.bin)
            for (name in listOf("cma", "claude-launcher")) {
                val target = File(bin, name)
                if (target.exists()) continue
                bin.mkdirs()
                val bytes = CmaStartup::class.java.getResourceAsStream("/launcher/$name")?.use { it.readBytes() } ?: continue
                target.writeBytes(bytes)
                target.setExecutable(true, false)
            }
        } catch (_: Exception) {
        }
    }
}
