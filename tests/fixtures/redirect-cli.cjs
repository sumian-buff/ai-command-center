// Loaded only in the test dispatcher. No vendor executable is ever launched.
const cp = require('node:child_process')
const path = require('node:path')
const { syncBuiltinESMExports } = require('node:module')

const originalSpawn = cp.spawn
cp.spawn = (executable, args, options) => {
  let agent
  if (path.basename(executable) === 'agy.exe') agent = 'agy'
  if (path.basename(executable) === 'claude.exe') agent = 'claude'
  if (executable === process.execPath && path.basename(args[0]) === 'codex.js') agent = 'codex'
  if (!agent) throw new Error(`测试中遇到未登记的程序 ${executable}`)
  return originalSpawn(process.execPath, [path.join(__dirname, 'fake-cli.cjs'), agent, ...args], options)
}
syncBuiltinESMExports()
