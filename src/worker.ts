/**
 * kb worker 客户端：常驻 `python -m kb worker`（JSON-lines over stdio）。
 *
 * 设计要点：
 *  · 一个 worker 进程复用连接/embedder/向量矩阵，warm 检索 10–30ms（冷启动 2s、
 *    首次向量检索另有 3s 读 130MB 矩阵的代价）。
 *  · 进程意外退出时把在途请求全部 reject，下一次 call 自动重启（懒重启）。
 *  · dispose 走 `shutdown` op 让 python 自己退出，超时才 SIGKILL，避免残留进程。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type WorkerOptions = {
  python: string
  cwd: string
  requestTimeoutMs?: number
  env?: Record<string, string | undefined>
}

type Pending = {
  resolve: (value: any) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  op: string
}

export class KbError extends Error {
  code: string
  nextAction?: string
  constructor(code: string, message: string, nextAction?: string) {
    super(message)
    this.code = code
    this.nextAction = nextAction
  }
}

const BOOT_TIMEOUT_MS = 60_000

export class KbWorker {
  private opts: WorkerOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buf = ''
  private stderrTail: string[] = []
  private booting: Promise<void> | null = null
  private ready = false
  private disposed = false
  private restarts = 0
  private bootFail = ''
  private readyInfo: any = null

  constructor(opts: WorkerOptions) {
    this.opts = { requestTimeoutMs: 30_000, ...opts }
  }

  get info(): { ready: boolean; restarts: number; stderrTail: string[]; bootFail: string; boot: any } {
    return {
      ready: this.ready,
      restarts: this.restarts,
      stderrTail: this.stderrTail.slice(-12),
      bootFail: this.bootFail,
      boot: this.readyInfo,
    }
  }

  async ensure(): Promise<void> {
    if (this.disposed) throw new KbError('WORKER_DISPOSED', 'worker 已关闭（插件卸载中）')
    if (this.ready && this.child) return
    if (this.booting) return this.booting
    this.booting = this.spawnAndWait().finally(() => {
      this.booting = null
    })
    return this.booting
  }

  private spawnAndWait(): Promise<void> {
    const { python, cwd, env } = this.opts
    const child = spawn(python, ['-m', 'kb', 'worker'], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(env ?? {}) },
    })
    this.child = child
    this.buf = ''
    this.ready = false
    this.bootFail = ''

    return new Promise<void>((resolve, reject) => {
      let booted = false
      const bootTimer = setTimeout(() => {
        if (booted) return
        booted = true
        reject(new KbError('WORKER_BOOT_TIMEOUT', `worker 启动超过 ${BOOT_TIMEOUT_MS / 1000}s 未就绪`))
      }, BOOT_TIMEOUT_MS)

      const finish = (err?: Error) => {
        if (booted) return
        booted = true
        clearTimeout(bootTimer)
        if (err) {
          this.ready = false
          this.bootFail = err.message
          reject(err)
        } else {
          this.ready = true
          resolve()
        }
      }

      child.stdout.setEncoding('utf-8')
      child.stdout.on('data', (chunk: string) => this.onData(chunk, finish))
      child.stderr.setEncoding('utf-8')
      child.stderr.on('data', (chunk: string) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim()) this.stderrTail.push(line.trim())
        }
        if (this.stderrTail.length > 60) this.stderrTail = this.stderrTail.slice(-40)
      })
      child.on('error', (err) => {
        this.ready = false
        finish(new KbError('WORKER_SPAWN_FAILED', `无法启动 worker：${String(err)}`, '检查 kb python 路径与 kb-mcp 目录'))
        this.failAll(new KbError('WORKER_SPAWN_FAILED', String(err)))
      })
      child.on('exit', (code, signal) => {
        this.ready = false
        this.child = null
        const tail = this.stderrTail.slice(-4).join(' | ')
        this.failAll(new KbError(
          'WORKER_EXIT',
          `worker 退出（code=${code}${signal ? `, signal=${signal}` : ''}）${tail ? `：${tail}` : ''}`,
        ))
        if (!booted) finish(new KbError('WORKER_EXIT', `worker 启动即退出（code=${code}）${tail ? `：${tail}` : ''}`))
        this.restarts += 1
      })
      child.stdin.on('error', () => { /* 写失败由 exit 事件统一收口 */ })
    })
  }

  private onData(chunk: string, finishBoot: (err?: Error) => void): void {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        this.stderrTail.push(`non-json: ${line.slice(0, 200)}`)
        continue
      }
      if (msg && msg.event === 'ready') {
        this.readyInfo = msg
        this.ready = true
        finishBoot()
        continue
      }
      if (msg && msg.event === 'boot_failed') {
        const text = String(msg.message || msg.error || 'boot failed')
        finishBoot(new KbError('WORKER_BOOT_FAILED', text, msg.next_action))
        continue
      }
      const id = Number(msg?.id)
      const p = this.pending.get(id)
      if (!p) continue
      this.pending.delete(id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result ?? null)
      else {
        const e = msg.error ?? {}
        p.reject(new KbError(String(e.code ?? 'WORKER_ERROR'), String(e.message ?? 'worker 报错'), e.next_action))
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  async call<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    await this.ensure()
    const child = this.child
    if (!child || !child.stdin.writable) {
      throw new KbError('WORKER_NOT_WRITABLE', 'worker 管道不可写（进程可能正在重启）')
    }
    const id = this.nextId++
    const limit = timeoutMs ?? this.opts.requestTimeoutMs ?? 30_000
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new KbError('WORKER_TIMEOUT', `${op} 超过 ${limit}ms 未返回`, '可以把 timeout_ms 调大；索引请用 reindex'))
      }, limit)
      this.pending.set(id, { resolve, reject, timer, op })
      try {
        child.stdin.write(`${JSON.stringify({ id, op, args })}\n`)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new KbError('WORKER_WRITE_FAILED', String(e)))
      }
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    if (!child) return
    try {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ id: 0, op: 'shutdown', args: {} })}\n`)
    } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        resolve()
      }, 2500)
      child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
      if (child.exitCode !== null) {
        clearTimeout(timer)
        done()
      }
    })
    this.ready = false
    this.child = null
    this.failAll(new KbError('WORKER_DISPOSED', 'worker 已关闭'))
  }
}
