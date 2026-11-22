package com.roychemo.cma.ide

import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.EnvironmentUtil
import com.intellij.util.concurrency.AppExecutorUtil
import com.roychemo.cma.core.Account
import com.roychemo.cma.core.LoginState
import com.roychemo.cma.core.View
import com.roychemo.cma.core.authDue
import com.roychemo.cma.core.authOf
import com.roychemo.cma.core.dateText
import com.roychemo.cma.core.emailOf
import com.roychemo.cma.core.findClaude
import com.roychemo.cma.core.liveAccount
import com.roychemo.cma.core.loginState
import com.roychemo.cma.core.readAccounts
import com.roychemo.cma.core.readAuth
import com.roychemo.cma.core.recordAuth
import com.roychemo.cma.core.runAuthStatus
import com.roychemo.cma.core.signInCommand
import com.roychemo.cma.core.signInNote
import com.roychemo.cma.core.signInOf
import com.roychemo.cma.core.timeLeft
import java.awt.datatransfer.StringSelection
import java.io.File
import java.time.LocalDate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Sign-ins that ended or are about to, as in the VS Code extension 0.9.0: `claude auth status` for each account when it
 * is due a check (kept in auth.json, which VS Code and the Claude Code plugin share), one notification for each, and
 * the sign-in itself in an IDE terminal.
 */
object SignIns {
    /** How often the accounts are looked at; authDue decides which ones actually run claude. */
    private const val CHECK_EVERY_SECONDS = 30L
    private val started = AtomicBoolean(false)
    private val lock = Any()
    private val warned = ConcurrentHashMap.newKeySet<String>()

    private fun env(): Map<String, String> = try {
        EnvironmentUtil.getEnvironmentMap()
    } catch (_: Exception) {
        System.getenv()
    }

    fun claude(): String? = findClaude(Cma.paths.home, env())

    /** Starts the checks once per IDE. Not under the plugin's tests (`cma.home`), which must never run claude. */
    fun start() {
        if (System.getProperty("cma.home") != null) return
        if (!started.compareAndSet(false, true)) return
        AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay({ check() }, 0, CHECK_EVERY_SECONDS, TimeUnit.SECONDS)
    }

    /** Runs claude for the accounts due a check, one at a time; [force] names account folders to check now. */
    fun check(force: Collection<String> = emptyList()) {
        if (System.getProperty("cma.home") != null) return
        synchronized(lock) {
            val p = Cma.paths
            val due = readAccounts(p).filter { it.dir in force || authDue(p, it.dir) }
            if (due.isEmpty()) return
            val claude = claude() ?: return
            val environment = env()
            var changed = false
            for (a in due) {
                val before = authOf(p, a.dir)
                val r = runAuthStatus(claude, a.dir, p.home, environment) ?: continue
                try {
                    recordAuth(p, a.dir, r)
                    changed = true
                } catch (_: Exception) {
                    continue
                }
                // Back from signed out: say which email it is now, since the old one stays on file either way.
                val wasOut = before != null && loginState(before, r.at) == LoginState.SIGNED_OUT
                if (wasOut && loginState(r, r.at) != LoginState.SIGNED_OUT) {
                    CmaPopup.notify(null, "${a.name} is signed in as ${r.email ?: emailOf(a.dir, p.home)}.")
                    warned.removeIf { it.contains(" ${a.name} ") }
                }
            }
            if (changed) Cma.refreshAll()
        }
    }

    /**
     * Once per project for a sign-in that ended, and once a day for one about to end. A missing email alone is a new
     * account, not an ended sign-in: only claude's own word counts for that.
     */
    fun warn(project: Project, v: View) {
        warnShared(project, v)
        val s = v.signIn
        val name = v.currentName
        if (s.ended) {
            if (!warned.add("${v.folder} $name ${s.state} ${s.expiresAt}")) return
            val ended = s.expiresAt?.let { ": its sign-in ended ${dateText(it)}" } ?: ""
            val live = liveAccount(Cma.paths, v.accounts, name)
            val n = NotificationGroupManager.getInstance().getNotificationGroup("Billable").createNotification(
                "$name is signed out of Claude$ended. Conversations on $name stop with a sign-in prompt until it signs in again.",
                NotificationType.ERROR,
            )
            n.addAction(NotificationAction.createSimpleExpiring("Sign in to $name") { signInAgain(project, name) })
            if (live != null) {
                n.addAction(NotificationAction.createSimpleExpiring("Switch ${File(v.folder).name} to ${live.name}") {
                    CmaPopup.switchTo(project, v.folder, live.name)
                })
            }
            n.notify(project)
            return
        }
        if (v.ending) {
            val end = s.expiresAt ?: return
            if (!warned.add("ending $name ${s.expiresAt}")) return
            // One key per account holding the day it was last told, so the keys do not pile up.
            val props = PropertiesComponent.getInstance()
            val key = "billable.loginWarned.$name"
            val today = LocalDate.now().toString()
            if (props.getValue(key) == today) return
            props.setValue(key, today)
            val n = NotificationGroupManager.getInstance().getNotificationGroup("Billable").createNotification(
                "$name's Claude sign-in ends ${timeLeft(end - System.currentTimeMillis())} (${dateText(end)}) and cannot be renewed " +
                    "after that. Sign in again before, so no conversation stops in the middle of a task.",
                NotificationType.WARNING,
            )
            n.addAction(NotificationAction.createSimpleExpiring("Sign in to $name") { signInAgain(project, name) })
            n.notify(project)
        }
    }

    /** Once per IDE session for each set of accounts sharing a sign-in. */
    private fun warnShared(project: Project, v: View) {
        for (s in v.shared) {
            if (!warned.add("shared ${s.email.lowercase()} ${s.names.joinToString(" ")} ")) continue
            val n = NotificationGroupManager.getInstance().getNotificationGroup("Billable").createNotification(
                "${s.names.joinToString(" and ")} are signed in as the same Claude account, ${s.email}, so they share one plan " +
                    "and its limits. Sign in again to the one that should use another account.",
                NotificationType.WARNING,
            )
            for (name in s.names) n.addAction(NotificationAction.createSimpleExpiring("Sign in to $name again") { signInAgain(project, name) })
            n.notify(project)
        }
    }

    /** Asks which account, listing why each one would need it. */
    fun pickAndSignIn(project: Project) {
        val p = Cma.paths
        val all = readAuth(p)
        val accounts = readAccounts(p)
        val step = object : BaseListPopupStep<Account>("Sign in to which account?", accounts) {
            override fun getTextFor(value: Account) = "${value.name}   ${emailOf(value.dir, p.home)}${signInNote(signInOf(p, value.dir, all = all))}"
            override fun onChosen(selectedValue: Account, finalChoice: Boolean): PopupStep<*>? =
                doFinalStep { signInAgain(project, selectedValue.name) }
        }
        JBPopupFactory.getInstance().createListPopup(step).showCenteredInCurrentWindow(project)
    }

    /**
     * Opens a terminal tab that runs `claude auth login` for the account. Once it signs in, its login file changes,
     * so the next check (within half a minute) shows it as signed in again.
     */
    fun signInAgain(project: Project, name: String) {
        val p = Cma.paths
        val account = readAccounts(p).find { it.name == name } ?: return
        val claude = claude()
        if (claude == null) {
            CmaPopup.notify(
                project,
                "Claude Code was not found: put the claude command on your PATH (or install it in ~/.local/bin), then sign in again.",
                NotificationType.ERROR,
            )
            return
        }
        val command = signInCommand(account.dir, p.home, claude)
        val how = if (SystemInfo.isWindows) {
            "Sign in to $name: a browser opens for the sign-in. If it is signed in to another Claude account, copy the link " +
                "from the terminal into a private window instead, then paste the code back into the terminal."
        } else {
            "Sign in to $name: open the link in the terminal in a browser signed in to that account (or a private window), " +
                "then paste the code back into the terminal."
        }
        val opened = try {
            LoginTerminal.open(project, "Claude login: $name", p.home, command)
            true
        } catch (_: Throwable) {
            // No terminal plugin in this IDE, or its API moved: the line is on the clipboard instead.
            false
        }
        if (opened) {
            CmaPopup.notify(project, how)
        } else {
            CopyPasteManager.getInstance().setContents(StringSelection(command))
            CmaPopup.notify(project, "Copied: $command\nPaste it into a terminal. $how")
        }
        // Checked again soon whatever happens, so a finished sign-in shows without waiting for the next due check.
        AppExecutorUtil.getAppScheduledExecutorService().schedule({ check(listOf(account.dir)) }, 90, TimeUnit.SECONDS)
    }
}
