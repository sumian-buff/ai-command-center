// 在桌面创建「AI指挥台」快捷方式：npm run shortcut
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(exe)) {
  console.error('找不到 Electron，请先在项目文件夹里运行 npm install');
  process.exit(1);
}
const q = (s) => "'" + s.replace(/'/g, "''") + "'";
const ps = [
  '$desk = [Environment]::GetFolderPath("Desktop")',
  '$ws = New-Object -ComObject WScript.Shell',
  '$lnk = $ws.CreateShortcut((Join-Path $desk "AI指挥台.lnk"))',
  `$lnk.TargetPath = ${q(exe)}`,
  `$lnk.Arguments = ${q('"' + root + '"')}`,
  `$lnk.WorkingDirectory = ${q(root)}`,
  '$lnk.Description = "AI指挥台：查看各个 AI 助手的实时进度"',
  '$lnk.Save()',
  'Write-Output (Join-Path $desk "AI指挥台.lnk")',
].join('; ');
const out = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8' });
console.log('已创建快捷方式：' + out.trim());
