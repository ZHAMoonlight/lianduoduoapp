import { DomainError } from "./domain";

/** 部署入口负责验证并注入认证头；匿名空间只开放给本机 loopback。 */
export function resolveOwner(request: Request): string {
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  if (userId) {
    if (userId.length > 256 || /[\u0000-\u001f]/.test(userId)) throw new DomainError("登录信息无效，请重新登录。", 401);
    return `chatgpt:${userId}`;
  }
  const hostname = new URL(request.url).hostname;
  if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) return "local-demo";
  throw new DomainError("请先使用 ChatGPT 登录，再访问自己的私有体验空间。", 401);
}
