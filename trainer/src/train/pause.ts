import { spawn } from 'node:child_process'

// 暂停/恢复训练进程。
//
// Windows 没有 SIGSTOP，sd-scripts 的实际训练进程也不是 spawn 出来的那个 pid
// （accelerate launch 是父，真正吃 GPU 的 python 是子），所以只挂父进程等于没挂。
// 这里先按 ParentProcessId 递归收集整棵进程树，再逐个调 ntdll 的
// NtSuspendProcess / NtResumeProcess。
//
// posix 简单得多：start() 用 detached 起了独立进程组，直接信号整组。

const PS_TREE = `
$ErrorActionPreference = 'Stop'
$root = __ROOT__
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object System.Collections.Generic.List[int]
$ids.Add($root)
$grown = $true
while ($grown) {
  $grown = $false
  foreach ($p in $procs) {
    $parent = [int]$p.ParentProcessId
    $self = [int]$p.ProcessId
    if ($ids.Contains($parent) -and -not $ids.Contains($self)) {
      $ids.Add($self)
      $grown = $true
    }
  }
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TrainPause {
  [DllImport("ntdll.dll", SetLastError = true)]
  public static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll", SetLastError = true)]
  public static extern int NtResumeProcess(IntPtr handle);
}
'@
$done = 0
foreach ($procId in $ids) {
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $code = [TrainPause]::__CALL__($proc.Handle)
  $proc.Dispose()
  if ($code -ne 0) { throw "Nt call failed on pid $procId (NTSTATUS $code)" }
  $done = $done + 1
}
Write-Output "$done"
`

export async function suspendProcessTree(pid: number): Promise<void> {
  await control(pid, 'suspend')
}

export async function resumeProcessTree(pid: number): Promise<void> {
  await control(pid, 'resume')
}

async function control(pid: number, action: 'suspend' | 'resume'): Promise<void> {
  if (process.platform !== 'win32') {
    process.kill(-pid, action === 'suspend' ? 'SIGSTOP' : 'SIGCONT')
    return
  }
  const script = PS_TREE.replace('__ROOT__', String(pid)).replace(
    '__CALL__',
    action === 'suspend' ? 'NtSuspendProcess' : 'NtResumeProcess',
  )
  await runPowerShell(script)
}

function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `powershell exited ${code}: ${stderr.trim().slice(-400) || 'no stderr'}`,
        ),
      )
    })
  })
}
