package com.roychemo.cma.ide

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUiKind
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.actionSystem.Presentation
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.extensions.PluginId
import com.intellij.ui.LicensingFacade
import com.roychemo.cma.core.LicenseStamp

/**
 * Pro features (the full cost history and CSV export) behind JetBrains Marketplace licensing.
 *
 * The switch is the build: with `cmaPaid=false` (the default) plugin.xml has no `<product-descriptor>`, so there is
 * no product code and every feature is open, as in the VS Code extension's launch period. With `cmaPaid=true` the
 * descriptor is added (optional="true", freemium) and Pro asks LicensingFacade, following JetBrains' official sample.
 */
object Licensing {
    const val PLUGIN_ID = "com.roychemo.claude-multi-account"

    /** The product code from our own plugin.xml, or null when the plugin is built free. */
    val productCode: String?
        get() = PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.productCode

    val isPaidBuild: Boolean get() = productCode != null

    /**
     * True when Pro features may run. While the IDE's licensing is not initialized yet (LicensingFacade is null) we
     * cannot know, and lean towards the user: a paying customer is never locked out at startup.
     */
    fun isPro(): Boolean {
        val code = productCode ?: return true
        val facade = LicensingFacade.getInstance() ?: return true
        return LicenseStamp.isValid(facade.getConfirmationStamp(code))
    }

    /** Opens the IDE's registration dialog with our product pre-selected. */
    fun requestLicense(message: String) {
        val code = productCode ?: return
        ApplicationManager.getApplication().invokeLater({
            val am = ActionManager.getInstance()
            // RegisterPlugins in IntelliJ IDEA Community and other open-source builds, Register in commercial IDEs.
            val action = am.getAction("RegisterPlugins") ?: am.getAction("Register") ?: return@invokeLater
            val context = DataContext { dataId ->
                when (dataId) {
                    "register.product-descriptor.code" -> code
                    "register.message" -> message
                    else -> null
                }
            }
            ActionUtil.performAction(action, AnActionEvent.createEvent(context, Presentation(), "", ActionUiKind.NONE, null))
        }, ModalityState.nonModal())
    }
}
