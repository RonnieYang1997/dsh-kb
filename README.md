# @dsh-external/dsh-kb

把本地 **kb-mcp**（独夫之心视频字幕语料库）接进 DSH：混合检索 + 取正文 + 引文逐字核对 + 索引状态，后端是一个常驻 `python -m kb worker`（JSON-lines over stdio），检索热态 **10–30ms**。

## 为什么不是 MCP

DSH 有原生 MCP 客户端，但 MCP 每次调用要过一次 JSON-RPC + 冷启动代价；语料库 63k 片段 × 512 维向量（130MB）每次重新加载要 3s+。这里把「打开库 + 加载向量矩阵 + embedder」放进常驻 worker，Node 侧只做协议转发。

## 工具面

| 工具 | 作用 | 备注 |
| --- | --- | --- |
| `kb_search` | FTS5 trigram + bge-small-zh 向量 RRF 融合检索 | 返回 `doc_id/chunk_id/bvid/date/title/snippet` |
| `kb_fetch` | 取某篇正文，可按 `chunk_id` 把窗口对准命中处 | 默认 20000 字 |
| `kb_verify` | 引文逐字核对（verbatim / modified / not_found） | **引用前必过**，单次 ≤50 条 |
| `kb_status` | 索引/worker/向量缓存状态 | 5s 计数缓存；`deep=true` 才扫源库 |
| `kb_docs` | 按日期倒序列文档 | 面板「最近入库」同源 |
| `kb_reindex` | 增量索引 | **默认不注册**，`reindex: true` 才现身 |

引用纪律来自语料库本身：ASR 有错字（`去中性化` 之类的同音错写），`kb_verify` 返回 `status=verbatim` 才能加引号，`modified` 要按 `suggestions` 改用原文。

## 配置

```ts
// 插件 config（全部有默认值）
{
  root: 'C:/Users/Ronnie/Documents/GitHub/kb-mcp',  // kb-mcp 仓库（worker 的 cwd）
  python: '.../.venv/Scripts/python.exe',           // 跑 worker 的解释器
  timeoutMs: 30_000,
  reindex: false,        // true 才注册 kb_reindex
  promptSection: true,   // 注入一段 systemPrompt，说明语料库与引用纪律
  httpApi: true,         // 暴露 /dsh-kb/api/*（面板用）
}
```

环境变量覆盖：`DSK_KB_ROOT`、`DSK_KB_PYTHON`。

## 架构

```
DSH host (node)
  src/index.ts   ← 6 个工具 + systemPrompt section + /dsh-kb HTTP 端点 + 面板客户端注册
  src/worker.ts  ← KbWorker：spawn / 行缓冲 JSON-lines RPC / 超时 / exit 时 failAll / dispose
        │ stdin/stdout
        ▼
  python -m kb worker   (kb-mcp/kb/worker.py)
     conn + embedder + VectorCache(monkeypatch store.load_vectors) 常驻
     ops: ping / status / search / fetch / verify / docs / reindex / shutdown
```

worker 的三条性能约定（改之前先读）：

1. `VectorCache._stamp()` 用 `meta.last_index_ts + MAX(chunks.id) + MAX(docs.id)`，**不能** `COUNT(*) FROM embeddings`（存 blob 全表扫 700ms，比省下的还多）。
2. `COUNT(*) FROM chunks` 3ms、`docs` 0ms，但 `embeddings` 280ms、`chunks_fts` 120ms → 计数走 `Ctx.counts(ttl=5)` 缓存。
3. 短查询（中文 <3 字）trigram 不命中会降级 `LIKE` 全表扫，**240–670ms**，是语料固有代价，不是插件问题。

## 构建

```bash
bash scripts/build.sh      # Path A：DSH_CHECKOUT 存在时用官方 tsconfig；Path B：用包内 node_modules 的 tsc + tsdown
```

产物：`lib/index.js`（host）、`lib/client.js`（面板）。

## 注入 / 卸载

```bash
# 注入器环境内
dev_inject_plugin C:\Users\Ronnie\Documents\GitHub\dsh-kb
dev_reload_package {"packageName":"dsh-kb"}    # 改完源码重建后热重载
dev_uninject_plugin {"match":"dsh-kb"}         # 卸载：fiber dispose → worker 退出 → junction 清理
```

**注入器前提（已在本机修过，重装注入器后要复查）**：

- 运行中的宿主 profile 不一定是 `web`（本机是 `desktop`），junction 必须建在**所有** `~/.dsh/profiles/*/node_modules` 下，否则 `loader.create` 之后 `ERR_MODULE_NOT_FOUND`，而错误只写进 logger，表现为注入器报 `host ✗` 且插件无任何日志。
- `loader.create()` 返回后 fiber 可能还没就绪 → 注入后要 `await entry.init()` 再判 `host ✓`，否则假阴性。
- `uninject` 会往 `cordis.patch.yml` 写 `- id: <短名>` + `disabled: true`；重新注入时要清掉这段，否则下次 `include.refresh` 可能按 disabled 装配。

## 已知限制

- 面板只读（状态 + 最近入库 + 刷新）；`kb_reindex` 在面板里按 403 拒绝，除非开启 `reindex`。
- 与 MCP 同时挂载会导致工具重名（`kb_search` 等），二选一。
- 首次调用会等 boot（约 **2s**，含 130MB 向量预热）；之后热态 10–30ms。

## 依赖

- `C:\Users\Ronnie\Documents\GitHub\kb-mcp`（含 `kb/worker.py` 与 `kb worker` 子命令；索引库 `C:\Users\Ronnie\AppData\Local\kb-mcp\index.db`）
- 本机 DSH 装在 `app.asar` 内、没有 `.d.ts`，故 host 侧**不 import 任何 `@deepseek-ai/*`**，用本地声明的 `PluginContext` + 普通对象式工具定义。
