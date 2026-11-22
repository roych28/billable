package com.roychemo.cma.ide

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.ListSeparator
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.util.SystemInfo
import com.intellij.notification.NotificationAction
import com.roychemo.cma.core.LoginState
import com.roychemo.cma.core.accountFor
import com.roychemo.cma.core.pin
import com.roychemo.cma.core.readAuth
import com.roychemo.cma.core.readRules
import com.roychemo.cma.core.shellFunction
import com.roychemo.cma.core.signInNote
import com.roychemo.cma.core.signInOf
import java.awt.Component
import java.awt.datatransfer.StringSelection
import java.io.File

/**
 * The popup behind the status bar item, in the order of the VS Code hover: the account and its email (the title),
 * a switch for every other account, then the tools, then the usage of the latest session.
 */
object CmaPopup {
    private class Item(val text: String, val separatorAbove: String? = null, val run: (() -> Unit)?)

    fun show(project: Project, anchor: Component?) {
        val v = Cma.view(project)
        if (v == null) {
            notify(project, "Open a project folder to see its Claude account.")
            return
        }
        val p = Cma.paths
        val items = mutableListOf<Item>()
        // A sign-in that ended or is about to: said first, with the way back.
        v.signInLine()?.let { line ->
            items.add(Item(line, null, null))
            items.add(Item("Sign in to ${v.currentName} again", null) { SignIns.signInAgain(project, v.currentName) })
        }
        val auth = readAuth(p)
        v.accounts.filter { it.name != v.currentName }.forEachIndexed { i, a ->
            val s = signInOf(p, a.dir, v.now, auth)
            val run = {
                if (s.state == LoginState.SIGNED_OUT) offerSignInFirst(project, v.folder, a.name) else switchTo(project, v.folder, a.name)
            }
            items.add(Item("Switch to ${a.name}${signInNote(s, v.now)}", if (i == 0 && items.isNotEmpty()) "" else null, run))
        }
        v.inherit?.let { items.add(Item("Use default (runs on $it)", null) { switchTo(project, v.folder, "auto") }) }
        items.add(Item("Cost report...", if (items.isEmpty()) null else "") { CostReportDialog(project).show() })
        items.add(Item("Copy terminal shell function", null) { copyShellFunction(project) })
        v.openOn?.let {
            items.add(Item("The open conversation still runs on $it. Start a new claude session to move it to ${v.currentName}.", "", null))
        }
        v.usageLines().forEachIndexed { i, line -> items.add(Item(line, if (i == 0 && v.openOn == null) "" else null, null)) }

        val step = object : BaseListPopupStep<Item>("${v.currentName}   ${v.email}", items) {
            override fun getTextFor(value: Item) = value.text
            override fun isSelectable(value: Item) = value.run != null
            override fun getSeparatorAbove(value: Item) = value.separatorAbove?.let { ListSeparator(it) }
            override fun onChosen(selectedValue: Item, finalChoice: Boolean): PopupStep<*>? =
                doFinalStep { selectedValue.run?.invoke() }
        }
        val popup = JBPopupFactory.getInstance().createListPopup(step)
        if (anchor != null && anchor.isShowing) popup.showUnderneathOf(anchor) else popup.showCenteredInCurrentWindow(project)
    }

    /** Writes the folder rule like the VS Code extension does; the next `claude` in this folder starts on the new account. */
    fun switchTo(project: Project, folder: String, name: String) {
        val p = Cma.paths
        try {
            pin(p, folder, name)
        } catch (e: Exception) {
            notify(project, "Could not write ${p.folders}: ${e.message}", NotificationType.ERROR)
            return
        }
        Cma.refreshAll()
        val next = accountFor(folder, readRules(p)) ?: "the default account"
        notify(
            project,
            "${File(folder).name} now runs on $next. Start a new claude session in the terminal: it picks up where the last one stopped.",
        )
    }

    /**
     * A new conversation on an account that is not signed in asks to sign in through the default browser, which is
     * usually signed in to another Claude account. So the sign-in comes first, with the link and the code.
     */
    fun offerSignInFirst(project: Project, folder: String, name: String) {
        val n = NotificationGroupManager.getInstance().getNotificationGroup("Billable").createNotification(
            "$name is not signed in. Sign in first: otherwise a new conversation on $name asks to sign in through your " +
                "default browser, which is usually signed in to another Claude account.",
            NotificationType.WARNING,
        )
        n.addAction(NotificationAction.createSimpleExpiring("Sign in") {
            switchTo(project, folder, name)
            SignIns.signInAgain(project, name)
        })
        n.addAction(NotificationAction.createSimpleExpiring("Switch anyway") { switchTo(project, folder, name) })
        n.notify(project)
    }

    fun copyShellFunction(project: Project) {
        val fn = shellFunction(Cma.paths, SystemInfo.isWindows)
        CopyPasteManager.getInstance().setContents(StringSelection(fn))
        val where = if (SystemInfo.isWindows) "your PowerShell profile (notepad \$PROFILE)" else "~/.zshrc or ~/.bashrc"
        notify(project, "Copied: $fn\nAdd it to $where, then open a new terminal tab. claude in the IDE terminal then starts on the folder's account.")
    }

    fun notify(project: Project?, text: String, type: NotificationType = NotificationType.INFORMATION) {
        NotificationGroupManager.getInstance().getNotificationGroup("Billable").createNotification(text, type).notify(project)
    }
}
