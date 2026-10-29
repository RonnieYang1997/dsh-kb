/**
 * @dsh-external/dsh-kb — 把本地 kb-mcp 转录语料库接进 DSH。
 *
 * host 侧不 import 任何 `@deepseek-ai/*`（本机 DSH 装在 app.asar 内，没有 .d.ts），
 * 用本地声明的 PluginContext + 普通对象式工具定义；后端是常驻 `python -m kb worker`
 * （JSON-lines over stdio），检索热态 10–30ms。
 *
 * 工具面（4 前台 + 1 后侧）：
 *   kb_search  混合检索（FTS5 trigram + bge-small-zh 向量，RRF 融合）
 *   kb_fetch   取某篇正文（可按 chunk_id 定位到命中处）
 *   kb_verify  引文逐字核对（引用前的门禁，报告/文章必过）
 *   kb_status  索引与 worker 状态（只读，数量/陈旧/缓存命中）
 *   kb_docs    按日期列文档（面板「最近入库」也用这条）
 *   kb_reindex 增量索引（**默认不注册**，写操作，config.reindex=true 才现身）
 */
import { join } from 'node:path'
import { KbError, KbWorker } from './worker.js'

/** 插件上下文里我们真正用到的那部分（本机无 .d.ts，故本地声明）。 */
interface PluginContext {
  logger?: {
    info?: (...a: unknown[]) => void
    warn?: (...a: unknown[]) => void
    error?: (...a: unknown[]) => void
  }
  effect: (cb: () => unknown, label?: string) => unknown
  on: (event: string, listener: (...a: any[]) => unknown) => unknown
  get: (name: string) => any
  tools: { register: (definition: unknown) => () => void }
}

export const name = '@dsh-external/dsh-kb'
export const inject = ['tools']

const PLUGIN_ID = '@dsh-external/dsh-kb'

export type KbConfig = {
  /** kb-mcp 仓库根（worker 的 cwd，`python -m kb` 在这里解析） */
  root?: string
  /** kb-mcp 的 venv python */
  python?: string
  /** 单次请求超时（毫秒） */
  timeoutMs?: number
  /** 是否注册写操作 kb_reindex（默认 false） */
  reindex?: boolean
  /** 是否挂 systemPrompt 段落（默认 true） */
  promptSection?: boolean
  /** 是否开面板 HTTP 端点（默认 true） */
  httpApi?: boolean
}

const DEFAULTS: Required<KbConfig> = {
  root: process.env.DSK_KB_ROOT || 'C:/Users/Ronnie/Documents/GitHub/kb-mcp',
  python: process.env.DSK_KB_PYTHON
    || 'C:/Users/Ronnie/Documents/GitHub/kb-mcp/.venv/Scripts/python.exe',
  timeoutMs: 30_000,
  reindex: false,
  promptSection: true,
  httpApi: true,
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
}

/** 结果裁剪：只留模型真正要用的字段，省上下文。 */
function shapeSearch(res: any): unknown {
  const rows = Array.isArray(res?.results) ? res.results : []
  return {
    mode: res?.mode,
    requested: res?.mode_requested,
    took_ms: res?.took_ms,
    candidates: res?.candidates,
    count: rows.length,
    hint: res?.hint,
    results: rows.map((r: any) => ({
      rank: r.rank,
      score: typeof r.score === 'number' ? Math.round(r.score * 1000) / 1000 : r.score,
      date: r.date,
      bvid: r.bvid,
      title: r.title,
      doc_id: r.doc_id,
      chunk_id: r.chunk_id,
      snippet: r.snippet,
    })),
  }
}

function shapeVerify(res: any): unknown {
  const rows = Array.isArray(res?.results) ? res.results : []
  return {
    ok: res?.ok,
    passed: res?.passed,
    total: res?.total,
    advice: res?.advice,
    results: rows.map((r: any) => ({
      status: r.status,
      quote: r.quote,
      matched_text: r.matched_text,
      bvid: r.bvid,
      doc_id: r.doc_id,
      title: r.title,
      suggestions: r.suggestions,
    })),
  }
}

export function apply(ctx: PluginContext, config?: KbConfig): void {
  const cfg: Required<KbConfig> = { ...DEFAULTS, ...(config ?? {}) }
  const log = (level: 'info' | 'warn' | 'error', msg: string): void => {
    try {
      ctx.logger?.[level]?.(`[${PLUGIN_ID}] ${msg}`)
    } catch { /* logger 不可用就算了 */ }
  }

  const worker = new KbWorker({
    python: cfg.python,
    cwd: cfg.root,
    requestTimeoutMs: cfg.timeoutMs,
    env: { KB_CONFIG: join(cfg.root, 'config.json') },
  })

  // 插件卸载 / 重载时把 python 进程收干净
  ctx.effect(() => () => {
    void worker.dispose().catch(() => { /* ignore */ })
  }, `${PLUGIN_ID}: worker`)

  // 启动即预热（失败不抛，首次调用会再试一次并给出可读错误）
  void worker.ensure().catch((e) => log('warn', `worker 预热失败：${String((e as any)?.message ?? e)}`))

  function register(tool: Record<string, any>, label: string): void {
    try {
      ctx.effect(() => ctx.tools.register(tool), `${PLUGIN_ID}: ${label}`)
    } catch (e) {
      log('error', `工具注册失败 ${label}: ${String(e)}`)
    }
  }

  async function callWorker(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    try {
      return await worker.call(op, args, timeoutMs)
    } catch (e) {
      if (e instanceof KbError) {
        return { ok: false, error: { code: e.code, message: e.message, next_action: e.nextAction } }
      }
      throw e
    }
  }

  // ────────────────────────────────────────────────────────────── kb_search
  register({
    name: 'kb_search',
    description: '检索本地转录语料库（独夫之心视频字幕）：FTS5 trigram + 中文向量混合检索，返回片段/日期/标题/BVID。引用前先用 kb_verify 核对。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词；中文 ≥3 字走 trigram，1–2 字退化为全表 LIKE（慢 200ms+）' },
        top_k: { type: 'number', description: '条数，默认 8，上限 50' },
        mode: { type: 'string', enum: ['hybrid', 'fts', 'vector'], description: '默认 hybrid' },
        source: { type: 'string', description: '限定语料源 id，如 dufuzhixin' },
        date_from: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
        date_to: { type: 'string', description: '截止日期 YYYY-MM-DD（含）' },
        sort: { type: 'string', enum: ['relevance', 'recent'], description: '排序，默认 relevance' },
      },
      required: ['query'],
    },
    output: textOutput,
    async execute(args: Record<string, any>) {
      const res = await callWorker('search', {
        query: String(args.query ?? ''),
        top_k: args.top_k,
        mode: args.mode,
        source: args.source,
        date_from: args.date_from,
        date_to: args.date_to,
        sort: args.sort,
      })
      if (res?.ok === false) return JSON.stringify(res)
      return JSON.stringify(shapeSearch(res))
    },
  }, 'kb_search')

  // ─────────────────────────────────────────────────────────────── kb_fetch
  register({
    name: 'kb_fetch',
    description: '取一篇转录全文（或从 chunk_id 命中处开窗）。返回正文 + 日期/BVID/总字数。',
    parameters: {
      type: 'object',
      properties: {
        doc_id: { type: 'number', description: '文档 id（kb_search 结果里给）' },
        bvid: { type: 'string', description: 'B 站 BVID，如 BV1jdp76MEZm' },
        chunk_id: { type: 'number', description: '片段 id：定位到该片段前 120 字开窗' },
        path: { type: 'string', description: '相对路径 rel_path' },
        offset: { type: 'number', description: '起始字符偏移，默认 0' },
        max_chars: { type: 'number', description: '返回字数上限，默认 20000' },
      },
    },
    output: textOutput,
    async execute(args: Record<string, any>) {
      const res = await callWorker('fetch', {
        doc_id: args.doc_id,
        bvid: args.bvid,
        chunk_id: args.chunk_id,
        path: args.path,
        offset: args.offset,
        max_chars: args.max_chars,
      })
      if (res?.error) return JSON.stringify({ ok: false, error: res.error })
      const head = [
        `# ${res.title ?? ''}（${res.date ?? '?'} ${res.bvid ?? ''}）`,
        `doc_id=${res.doc_id} 总字数=${res.total_chars} 本次=${res.offset}..${(res.offset ?? 0) + (res.returned_chars ?? 0)}${res.has_more ? ' 还有后续（用 offset 续读）' : ''}`,
        '',
      ].join('\n')
      return `${head}${res.text ?? ''}`
    },
  }, 'kb_fetch')

  // ────────────────────────────────────────────────────────────── kb_verify
  register({
    name: 'kb_verify',
    description: '引文逐字核对：把要引用的句子与源文件原文比对，返回 verbatim / modified / not_found 与原文替换建议。写报告前必过。',
    parameters: {
      type: 'object',
      properties: {
        quotes: {
          type: 'array',
          items: { type: 'string' },
          description: '要核对的引文数组（≤50 条）；也可传单个字符串',
        },
        bvid: { type: 'string', description: '只在这篇里找（可选）' },
        doc_id: { type: 'number', description: '只在这篇里找（可选）' },
        fuzzy: { type: 'boolean', description: '模糊匹配（默认 true）' },
        context_chars: { type: 'number', description: '返回上下文长度，默认 90' },
      },
      required: ['quotes'],
    },
    output: textOutput,
    async execute(args: Record<string, any>) {
      const quotes = args.quotes
      if (!Array.isArray(quotes) && typeof quotes !== 'string') {
        return JSON.stringify({ ok: false, error: { code: 'BAD_ARGS', message: 'quotes 必须是字符串数组' } })
      }
      const res = await callWorker('verify', {
        quotes,
        bvid: args.bvid,
        doc_id: args.doc_id,
        fuzzy: args.fuzzy,
        context_chars: args.context_chars,
      }, 120_000)
      if (res?.ok === false) return JSON.stringify(res)
      return JSON.stringify(shapeVerify(res))
    },
  }, 'kb_verify')

  // ────────────────────────────────────────────────────────────── kb_status
  register({
    name: 'kb_status',
    description: '语料库状态：文档/片段数、索引新鲜度、向量缓存命中、worker 运行态。deep=true 会扫源库目录（几秒）。',
    parameters: {
      type: 'object',
      properties: {
        deep: { type: 'boolean', description: '是否检查源库增量（默认 false，快）' },
      },
    },
    output: textOutput,
    async execute(args: Record<string, any>) {
      const res = await callWorker('status', { deep: args.deep }, 120_000)
      if (res?.ok === false) return JSON.stringify(res)
      return JSON.stringify({
        version: res.version,
        pid: res.pid,
        uptime_s: res.uptime_s,
        counts: res.counts,
        embed: res.embed,
        vector_cache: res.vector_cache,
        indexing_locked: res.indexing_locked,
        auto_index: res.auto_index,
        recent_jobs: res.recent_jobs,
        pending_changes: res.pending_changes,
        worker: worker.info,
      })
    },
  }, 'kb_status')

  // ──────────────────────────────────────────────────────────────── kb_docs
  register({
    name: 'kb_docs',
    description: '按出片日期倒序列文档（标题/日期/BVID/片段数），用于「最近更新了什么」或按时间窗找某一集。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '默认 20，上限 200' },
        offset: { type: 'number', description: '分页偏移，默认 0' },
        date_from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        date_to: { type: 'string', description: '截止日期 YYYY-MM-DD' },
        q: { type: 'string', description: '标题/BVID/路径模糊匹配' },
      },
    },
    output: textOutput,
    async execute(args: Record<string, any>) {
      const res = await callWorker('docs', {
        limit: args.limit,
        offset: args.offset,
        date_from: args.date_from,
        date_to: args.date_to,
        q: args.q,
      })
      return JSON.stringify(res)
    },
  }, 'kb_docs')

  // ─────────────────────────────────────────────────────────── kb_reindex（后侧）
  if (cfg.reindex) {
    register({
      name: 'kb_reindex',
      description: '增量索引源库（复用 python -m kb index，写索引库）。默认不注册，需 config.reindex=true。',
      parameters: {
        type: 'object',
        properties: {
          full: { type: 'boolean', description: '强制全量重建（慢）' },
          source: { type: 'string', description: '限定源 id' },
          timeout_s: { type: 'number', description: '超时秒数，默认 1800' },
        },
      },
      output: textOutput,
      async execute(args: Record<string, any>) {
        const res = await callWorker('reindex', {
          full: args.full,
          source: args.source,
          timeout_s: args.timeout_s,
        }, 1_900_000)
        return JSON.stringify(res)
      },
    }, 'kb_reindex')
  }

  // ──────────────────────────────── systemPrompt 段落（告诉模型何时用这套工具）
  if (cfg.promptSection) {
    try {
      const sp = ctx.get('systemPrompt')
      if (sp && typeof sp.section === 'function') {
        ctx.effect(() => sp.section({
          name: 'kb-corpus',
          order: 620,
          text: [
            '本地有转录语料库（独夫之心视频字幕），用 kb_search / kb_fetch / kb_verify / kb_status 访问。',
            '要引用原话时：kb_search 定位 → kb_fetch 读上下文 → kb_verify 逐字核对，status=verbatim 才可加引号；',
            'ASR 有错字（如「去中性化」「董车弟」），顺手改写会被判 modified，不要"修正"原文。',
          ].join(''),
        }), `${PLUGIN_ID}: prompt`)
      }
    } catch (e) {
      log('warn', `systemPrompt 段落未挂上：${String(e)}`)
    }
  }

  // ─────────────────────────────────────────── HTTP 端点（给 client 面板取数）
  if (cfg.httpApi) {
    try {
      const webServer = ctx.get('webServer')
      if (webServer && typeof webServer.register === 'function') {
        const BASE = '/dsh-kb'
        ctx.effect(() => webServer.register({
          kind: 'prefix',
          path: BASE,
          handler: (req: any, res: any) => {
            const url = new URL(String(req.url ?? '/'), 'http://x')
            const json = (code: number, body: unknown): void => {
              res.writeHead(code, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              res.end(JSON.stringify(body))
            }
            void (async () => {
              try {
                if (url.pathname === `${BASE}/api/status`) {
                  const deep = url.searchParams.get('deep') === '1'
                  const status = await callWorker('status', { deep }, 120_000)
                  const recent = await callWorker('docs', { limit: 12 }, 30_000)
                  json(200, { ok: status?.ok !== false, status, recent, worker: worker.info })
                  return
                }
                if (url.pathname === `${BASE}/api/docs`) {
                  const r = await callWorker('docs', {
                    limit: Number(url.searchParams.get('limit') ?? 30),
                    offset: Number(url.searchParams.get('offset') ?? 0),
                    q: url.searchParams.get('q') || undefined,
                  }, 30_000)
                  json(200, r)
                  return
                }
                if (url.pathname === `${BASE}/api/reindex` && req.method === 'POST') {
                  if (!cfg.reindex) {
                    json(403, { ok: false, error: 'reindex 未启用（config.reindex=false）' })
                    return
                  }
                  const r = await callWorker('reindex', {}, 1_900_000)
                  json(200, r)
                  return
                }
                json(404, { ok: false, error: `unknown path ${url.pathname}` })
              } catch (e) {
                json(500, { ok: false, error: String((e as any)?.message ?? e) })
              }
            })()
          },
        }), `${PLUGIN_ID}: http`)
      }
    } catch (e) {
      log('warn', `webServer 端点未挂上：${String(e)}`)
    }
  }

  log('info', `就绪：python=${cfg.python} root=${cfg.root} reindex=${cfg.reindex}`)
}

export { KbWorker, KbError }
export const _internal = { DEFAULTS, shapeSearch, shapeVerify }
