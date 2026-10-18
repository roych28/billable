package com.roychemo.cma

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.roychemo.cma.ide.Cma
import com.roychemo.cma.ide.CmaPopup
import com.roychemo.cma.ide.Licensing
import java.io.File

/**
 * Loads the plugin in a headless IDE. build.gradle.kts points `cma.home` and CLAUDE_MULTI_ACCOUNT_HOME at
 * build/cma-test-home, so the plugin's startup activity and these tests never see the real setup.
 */
class PluginLoadTest : BasePlatformTestCase() {
    fun testTheSetupIsTheSandboxNotTheRealHome() {
        val home = System.getProperty("cma.home")
        assertNotNull("run through gradle test, which sets cma.home", home)
        assertEquals(home, Cma.paths.home)
        assertTrue(Cma.paths.base.startsWith(home))
    }

    fun testActionsAndTheStatusBarWidgetAreRegistered() {
        for (id in listOf("ClaudeMultiAccount.Switch", "ClaudeMultiAccount.CostReport", "ClaudeMultiAccount.CopyShellFunction", "ClaudeMultiAccount.Refresh")) {
            assertNotNull(id, ActionManager.getInstance().getAction(id))
        }
        val factories = ExtensionPointName.create<StatusBarWidgetFactory>("com.intellij.statusBarWidgetFactory").extensionList
        assertTrue(factories.any { it.id == "ClaudeMultiAccount" })
    }

    fun testTheFreeBuildHasNoProductCodeAndOpensPro() {
        assertNull(Licensing.productCode)
        assertTrue(Licensing.isPro())
    }

    fun testSwitchingWritesTheFolderRuleAndTheViewFollows() {
        val p = Cma.paths
        File(p.base).mkdirs()
        File(p.accounts).writeText("personal\t~/.claude\nacme\t~/.claude-acme\n")
        File(p.folders).writeText("*\tpersonal\n")
        val v = Cma.view(project)
        assertNotNull("the test project has a folder", v)
        assertEquals("personal", v!!.currentName)
        assertNull(v.inherit)
        CmaPopup.switchTo(project, v.folder, "acme")
        assertTrue(File(p.folders).readText().contains("${v.folder}\tacme"))
        val after = Cma.view(project)!!
        assertEquals("acme", after.currentName)
        assertEquals("personal", after.inherit)
        CmaPopup.switchTo(project, v.folder, "auto")
        assertEquals("personal", Cma.view(project)!!.currentName)
        assertEquals("*\tpersonal\n", File(p.folders).readText())
    }
}
