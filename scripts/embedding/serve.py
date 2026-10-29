"""
bge-m3 向量服务：给 Next.js 提供 embedding 能力。

为什么做成独立的小服务，而不是在 Node 里直接跑模型：
bge-m3 是 PyTorch 模型，Node 侧没有可靠的推理运行时。用一个常驻 Python
进程加载一次模型、对外暴露 HTTP 接口，比每次调用都启停进程快一个数量级
（模型加载 3.4 秒，编码只要几百毫秒）。

  启动:  python serve.py --port 8100
  健康:  GET  /health
  编码:  POST /embed      {"texts": ["...", "..."]}
  返回:  {"vectors": [[...]], "dim": 1024, "took_ms": 123}

设计取舍：
- **常驻内存**：模型加载后不卸载，这是这个服务存在的全部理由。
- **批量编码**：一次请求编码多条，批量比逐条快（矩阵运算摊薄开销）。
- **归一化**：normalize_embeddings=True，这样余弦相似度就是点积，
  Milvus 的 COSINE 距离也能直接对得上。
- **CPU 优先**：默认 device=cpu，有 GPU 时可用 --device cuda。
- **上限保护**：单次最多 64 条、每条最多 8192 字符，防止一个大请求把
  内存打爆（bge-m3 单条上限是 8192 token，超了会被截断，这里提前拒绝）。
"""

import argparse
import json
import logging
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BATCH = 64
MAX_CHARS = 8192

_model = None
_model_path = ""
_device = "cpu"


def load_model(path: str, device: str):
    """加载 bge-m3。失败时直接退出——一个起不来模型的 embedding 服务没有意义。"""
    global _model, _model_path, _device
    from sentence_transformers import SentenceTransformer

    started = time.time()
    _model = SentenceTransformer(path, device=device)
    _model_path = path
    _device = device
    dim = _model.get_sentence_embedding_dimension()
    logging.info("模型已加载 path=%s device=%s dim=%d 耗时=%.1fs", path, device, dim, time.time() - started)
    return dim


def encode(texts: list[str]) -> list[list[float]]:
    """编码一批文本，返回归一化后的向量。"""
    vectors = _model.encode(
        texts,
        normalize_embeddings=True,
        batch_size=min(32, len(texts)),
        show_progress_bar=False,
        convert_to_numpy=True,
    )
    return [[round(float(x), 7) for x in row] for row in vectors]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # 默认的逐请求日志太吵，只在启动和错误时打。
        pass

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {
                "ok": True,
                "model": _model_path,
                "device": _device,
                "dim": _model.get_sentence_embedding_dimension() if _model else 0,
            })
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8-sig")
            body = json.loads(raw)
            texts = body.get("texts")
            if not isinstance(texts, list) or not texts:
                self._json(400, {"error": "texts 必须是非空数组"})
                return
            if len(texts) > MAX_BATCH:
                self._json(400, {"error": f"单次最多 {MAX_BATCH} 条，实际 {len(texts)} 条"})
                return
            cleaned = []
            for index, text in enumerate(texts):
                if not isinstance(text, str):
                    self._json(400, {"error": f"第 {index} 条不是字符串"})
                    return
                if len(text) > MAX_CHARS:
                    # 截断而不是拒绝：调用方传整篇文档时不该整体失败。
                    text = text[:MAX_CHARS]
                cleaned.append(text or " ")
            started = time.time()
            vectors = encode(cleaned)
            self._json(200, {
                "vectors": vectors,
                "dim": len(vectors[0]),
                "took_ms": int((time.time() - started) * 1000),
            })
        except Exception as error:  # noqa: BLE001 - 任何失败都要回给调用方
            logging.exception("编码失败")
            self._json(500, {"error": str(error)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=r"E:\WorkTool\agent_class\models\bge-m3")
    parser.add_argument("--port", type=int, default=8100)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        dim = load_model(args.model, args.device)
    except Exception as error:  # noqa: BLE001
        logging.error("模型加载失败：%s", error)
        sys.exit(1)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    logging.info("bge-m3 向量服务已启动 http://%s:%d  dim=%d", args.host, args.port, dim)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("收到中断，退出")


if __name__ == "__main__":
    main()
