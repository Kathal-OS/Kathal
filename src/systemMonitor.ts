import os from 'node:os'
import fs from 'node:fs'

export interface SystemMonitorSnapshot {
  timestamp: string
  host: {
    hostname: string
    platform: string
    release: string
    arch: string
    uptimeSeconds: number
    nodeVersion: string
  }
  cpu: {
    percent: number
    cores: number
    model: string
    loadAvg: {
      load1: number
      load5: number
      load15: number
    }
  }
  memory: {
    totalBytes: number
    usedBytes: number
    freeBytes: number
    percent: number
  }
  disk: {
    mount: string
    totalBytes: number
    usedBytes: number
    freeBytes: number
    percent: number
  }
}

export interface SystemMonitorHistoryPoint {
  timestamp: string
  cpuPercent: number
  memoryPercent: number
  diskPercent: number
}

let prevCpuTotal = 0
let prevCpuIdle = 0
const snapshotHistory: SystemMonitorHistoryPoint[] = []

function readCpuTimes(): { total: number; idle: number; cores: number; model: string } {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }
  return {
    total,
    idle,
    cores: cpus.length || 1,
    model: cpus[0]?.model?.trim() || `${os.arch()} Processor`,
  }
}

function sampleCpuPercent(cores: number): number {
  const { total, idle } = readCpuTimes()
  if (prevCpuTotal === 0) {
    prevCpuTotal = total
    prevCpuIdle = idle
    const load = os.loadavg()[0] || 0
    return Number(Math.min(100, Math.max(0, (load / Math.max(1, cores)) * 100)).toFixed(1))
  }

  const diffTotal = total - prevCpuTotal
  const diffIdle = idle - prevCpuIdle
  prevCpuTotal = total
  prevCpuIdle = idle

  if (diffTotal <= 0) {
    const load = os.loadavg()[0] || 0
    return Number(Math.min(100, Math.max(0, (load / Math.max(1, cores)) * 100)).toFixed(1))
  }

  const pct = ((diffTotal - diffIdle) / diffTotal) * 100
  return Number(Math.min(100, Math.max(0, pct)).toFixed(1))
}

function readDiskStats(mountPath = '/'): SystemMonitorSnapshot['disk'] {
  try {
    const stats = fs.statfsSync(mountPath)
    const blockSize = Number(stats.bsize) || 4096
    const totalBytes = Number(stats.blocks) * blockSize
    const freeBytes = Number(stats.bavail) * blockSize
    const usedBytes = Math.max(0, totalBytes - freeBytes)
    const rawPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0
    const percent =
      rawPercent > 0 && rawPercent < 0.1
        ? Number(rawPercent.toFixed(2))
        : Number(rawPercent.toFixed(1))
    return {
      mount: mountPath,
      totalBytes,
      usedBytes,
      freeBytes,
      percent,
    }
  } catch {
    return {
      mount: mountPath,
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      percent: 0,
    }
  }
}

export function collectSystemMonitorData(): SystemMonitorSnapshot & {
  history: SystemMonitorHistoryPoint[]
} {
  const cpuInfo = readCpuTimes()
  const cpuPercent = sampleCpuPercent(cpuInfo.cores)
  const [load1, load5, load15] = os.loadavg()

  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = Math.max(0, totalMem - freeMem)
  const memPercent = totalMem > 0 ? Number(((usedMem / totalMem) * 100).toFixed(1)) : 0

  const disk = readDiskStats('/')
  const timestamp = new Date().toISOString()

  snapshotHistory.push({
    timestamp,
    cpuPercent,
    memoryPercent: memPercent,
    diskPercent: disk.percent,
  })
  if (snapshotHistory.length > 30) {
    snapshotHistory.splice(0, snapshotHistory.length - 30)
  }

  return {
    timestamp,
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: Math.floor(os.uptime()),
      nodeVersion: process.version,
    },
    cpu: {
      percent: cpuPercent,
      cores: cpuInfo.cores,
      model: cpuInfo.model,
      loadAvg: {
        load1: Number((load1 || 0).toFixed(2)),
        load5: Number((load5 || 0).toFixed(2)),
        load15: Number((load15 || 0).toFixed(2)),
      },
    },
    memory: {
      totalBytes: totalMem,
      usedBytes: usedMem,
      freeBytes: freeMem,
      percent: memPercent,
    },
    disk,
    history: [...snapshotHistory],
  }
}
