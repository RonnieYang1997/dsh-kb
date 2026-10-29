/**
 * @dsh-external/dsh-kb — client 面板（conversation.view slot）。
 *
 * 构建：npm run build:client（tsdown → lib/client.js，ModuleLoader.load 注册）。
 *
 * ⚠️ 三个必坑（2026-10 实测，DSH Web 渲染器）：
 *  ① apply 用 ctx.slots 必须 `export const inject = ['slots']`；
 *  ② register 签名是 **register(options, Component)** —— 组件是第二个参数；
 *     塞进 options 里不报错，但 entry.component === undefined，React 抛
 *     "Element type is invalid"，被错误边界吞成空白面板；
 *  ③ Component 必须是真 React 组件（createElement as h 即可），
 *     不能返回 { render() { return HTMLElement } } 这种旧式对象。
 *
 * 面板只读：数据来自 host 端点 /dsh-kb/api/status 与 /api/docs。
 */
import {
  createElement as h,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'

type SlotsRegistration = Record<string, unknown>

type ClientContext = {
  slots: {
    inject: (slot: string, factory: () => unknown) => unknown
    register: (options: SlotsRegistration, component: unknown) => unknown
  }
  effect?: (cb: () => unknown, label?: string) => unknown
}

export const name = '@dsh-external/dsh-kb'
export const inject = ['slots']

const API = '/dsh-kb/api'

const wrap: CSSProperties = {
  padding: '10px 12px',
  fontFamily: 'ui-monospace,Consolas,monospace',
  fontSize: 12,
  color: '#ddd',
  overflow: 'auto',
  maxHeight: '100%',
}
const titleStyle: CSSProperties = { fontWeight: 600, fontSize: 13, marginBottom: 6, color: '#eee' }
const sectionStyle: CSSProperties = { marginTop: 10 }
const btnStyle: CSSProperties = {
  font: 'inherit',
  padding: '3px 10px',
  borderRadius: 4,
  border: '1px solid #555',
  background: '#333',
  color: '#ddd',
  cursor: 'pointer',
  marginRight: 6,
}
const dimStyle: CSSProperties = { color: '#888' }

function Row(props: { k: string; v: string; tone?: 'ok' | 'warn' | 'err' }): ReactElement {
  const color = props.tone === 'ok' ? '#5fb760' : props.tone === 'warn' ? '#d9a13b' : props.tone === 'err' ? '#e06c6c' : '#ddd'
  return h(
    'div',
    { style: { display: 'flex', gap: 8, lineHeight: 1.7 } },
    h('span', { style: { color: '#888', minWidth: 108 } }, props.k),
    h('span', { style: { color } }, props.v),
  )
}

function num(v: unknown): string {
  return typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? '-')
}

function Panel(): ReactElement {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string>('')
  const [busy, setBusy] = useState<boolean>(false)
  const [deep, setDeep] = useState<boolean>(false)

  const load = useCallback(async (isDeep: boolean) => {
    setBusy(true)
    setErr('')
    try {
      const r = await fetch(`${API}/status${isDeep ? '?deep=1' : ''}`, { cache: 'no-store' })
      const body = await r.json()
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setData(body)
    } catch (e) {
      setErr(String((e as any)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(deep)
    const timer = setInterval(() => void load(false), 30_000)
    return () => clearInterval(timer)
  }, [load, deep])

  const st = data?.status ?? {}
  const counts = st.counts ?? {}
  const cache = st.vector_cache ?? {}
  const recent = Array.isArray(data?.recent?.docs) ? data.recent.docs : []
  const worker = data?.worker ?? {}
  const locked = st.indexing_locked

  return h(
    'div',
    { style: wrap },
    h('div', { style: titleStyle }, '本地语料库 · kb-mcp'),
    err
      ? h('div', { style: { color: '#e06c6c', marginBottom: 6 } }, `取数失败：${err}`)
      : null,
    h(
      'div',
      { style: { marginBottom: 6 } },
      h('button', { style: btnStyle, onClick: () => void load(deep) }, busy ? '刷新中…' : '刷新'),
      h('button', {
        style: { ...btnStyle, borderColor: deep ? '#4a9eff' : '#555' },
        onClick: () => { const next = !deep; setDeep(next); void load(next) },
      }, deep ? '深度检查：开' : '深度检查：关'),
      h('span', { style: dimStyle }, busy ? ' …' : ` 每 30s 自动刷新`),
    ),

    h(
      'div',
      null,
      h(Row, { k: '文档', v: `${num(counts.docs)} 篇（indexed ${num(counts.indexed)} / empty ${num(counts.empty)} / dead ${num(counts.dead)}）` }),
      h(Row, { k: '片段', v: `${num(counts.chunks)} 条（fts ${num(counts.fts_rows)}）` }),
      h(Row, { k: '嵌入维度', v: `${num(counts.embed_dim)} · ${st.embed?.model_id || '未知模型'}` }),
      h(Row, {
        k: '索引锁',
        v: locked ? '已锁（auto_index=false，不能索引）' : '未锁',
        tone: locked ? 'err' : 'ok',
      }),
      h(Row, {
        k: '向量缓存',
        v: `entries ${num(cache.entries)} · hit ${num(cache.hits)} / miss ${num(cache.misses)} · ${num(cache.cached_mb)} MB`,
      }),
      h(Row, {
        k: 'worker',
        v: worker.ready
          ? `就绪 pid ${num(st.pid)} · 运行 ${num(st.uptime_s)}s · 重启 ${num(worker.restarts)}`
          : '未就绪（下次调用会自动重启）',
        tone: worker.ready ? 'ok' : 'warn',
      }),
      data?.status?.pending_changes
        ? h(Row, {
            k: '待增量',
            v: `new ${num(data.status.pending_changes.new)} / changed ${num(data.status.pending_changes.changed)} / removed ${num(data.status.pending_changes.removed)}`,
            tone: 'warn',
          })
        : null,
    ),

    h('div', { style: sectionStyle }, h('div', { style: titleStyle }, '最近入库')),
    recent.length === 0
      ? h('div', { style: dimStyle }, '（还没取到数据）')
      : h(
          'div',
          null,
          ...recent.map((d: any) =>
            h(
              'div',
              { key: String(d.id ?? d.bvid), style: { lineHeight: 1.6, borderBottom: '1px solid #262626', padding: '2px 0' } },
              h('span', { style: { color: '#7aa7d9', marginRight: 8 } }, String(d.date ?? '?')),
              h('span', { style: { color: '#555', marginRight: 8 } }, String(d.bvid ?? '')),
              h('span', null, String(d.title ?? '')),
            ),
          ),
        ),
    h('div', { style: { ...dimStyle, marginTop: 8, fontSize: 11 } },
      `API ${API} · 工具 kb_search / kb_fetch / kb_verify / kb_status / kb_docs`),
  )
}

export function apply(ctx: ClientContext): void {
  // ⚠️ 注入器静态校验的正则是 `register\(\{[\s\S]{0,400}?name:...` —— 左花括号必须紧跟
  // `register(`，换行/空格都会判成「缺合法 name」。所以这一行不要拆行。
  const mount = (): unknown =>
    ctx.slots.register({ name: 'conversation.view', id: 'dsh-kb-panel', label: () => '语料库' }, Panel)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => ctx.slots.inject('conversation.view', mount), 'dsh-kb: panel')
  } else {
    ctx.slots.inject('conversation.view', mount)
  }
}
