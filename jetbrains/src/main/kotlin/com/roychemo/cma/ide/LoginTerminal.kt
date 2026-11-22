package com.roychemo.cma.ide

import com.intellij.openapi.project.Project
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

/**
 * The only class that touches the terminal plugin, an optional dependency (billable-terminal.xml): without it, loading
 * this class fails and the caller copies the command instead.
 */
internal object LoginTerminal {
    fun open(project: Project, title: String, workingDir: String, command: String) {
        val widget = TerminalToolWindowManager.getInstance(project).createShellWidget(workingDir, title, true, true)
        widget.sendCommandToExecute(command)
    }
}
