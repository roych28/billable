// Runs the extension inside a real VS Code against a throwaway setup: two accounts, a workspace folder pinned
// to one of them, a session status and a transcript. Run with: npm run test:integration
const fs = require('fs')
const os = require('os')
const path = require('path')
const { runTests } = require('@vscode/test-electron')

async function main() {
  // Set when this runs from a terminal inside VS Code; it would start the test VS Code as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cma-vscode-')))
  const base = path.join(tmp, 'base')
  const workspace = path.join(tmp, 'work', 'app')
  fs.mkdirSync(base, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  for (const [name, email] of [['personal', 'me@example.test'], ['acme', 'me@acme.test']]) {
    fs.mkdirSync(path.join(tmp, `claude-${name}`))
    fs.writeFileSync(path.join(tmp, `claude-${name}`, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  }
  fs.writeFileSync(path.join(base, 'accounts'), `personal\t${tmp}/claude-personal\nacme\t${tmp}/claude-acme\n`)
  fs.writeFileSync(path.join(base, 'folders'), `*\tpersonal\n${path.dirname(workspace)}\tacme\n`)

  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, '../..'),
    extensionTestsPath: path.resolve(__dirname, 'suite.js'),
    launchArgs: [workspace, '--disable-extensions', '--user-data-dir', path.join(tmp, 'user-data')],
    extensionTestsEnv: { CLAUDE_MULTI_ACCOUNT_HOME: base, CMA_TEST_ROOT: tmp, HOME: tmp },
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
