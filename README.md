# GHCP API Learning

这个项目探索一种把 **GitHub Copilot 后端能力作为“裸 API”集中提供** 的方案：对调用方暴露 OpenAI / Anthropic / Responses 兼容接口，对内自动管理 GitHub Enterprise Managed User(EMU)、SSO 登录、GitHub token、Copilot token 和后台运维。

> 重要：GitHub Copilot 当前并不提供面向第三方服务端集成的公开裸 API。本项目依赖 Copilot 内部接口，适合学习、验证和自维护部署；用于生产前必须自行评估合规、稳定性和运维风险。

> proxy 参考repo https://github.com/hooyao/copilot-bridge

> 管理员的配置手册: ([guidance/guidance.md](./guidance/guidance.md))

## 背景

开源社区已经有不少项目可以把 Copilot 包装成 API 来用，例如 LiteLLM、ccswitch、copilot2api 等。这些方案通常适合**单个开发者本地使用**：本地代理读取一个 GitHub/Copilot 登录态，再把请求转发到 Copilot 后端。

当要集中给大量最终用户提供 GHCP API 服务时，单人本地代理模式会遇到几个问题：

1. **账号合规问题**：合规使用 GHCP 不应共享账号，理想状态是一个 GitHub 账号对应一个最终用户。
2. **账号规模问题**：最终用户量大时，需要批量获得对应数量的 GitHub 账号，并能持续管理这些账号。
3. **自动登录问题**：即使账号已经创建，GitHub 账号的 MFA/device flow 会阻碍无人值守、批量化登录。

## 本项目思路

本项目通过 **GitHub Enterprise Managed User + 自定义 SSO + 自动化登录 + API Proxy** 组合解决上述问题：

- 使用自定义 SSO/SAML IdP 结合 GitHub EMU，通过 SCIM 批量创建和同步 GitHub 账号，避免手工注册大量普通 GitHub 账号。
- 使用 Playwright 自动完成 GitHub OAuth device flow 和 SSO 登录，拿到每个用户对应 GitHub 账号的 token。
- 通过 Proxy 统一维护 `identity -> ssoUser -> ghLogin -> token` 映射，并对外提供兼容 API。
- 支持批量导入 GitHub token，也支持后台控制台查看账号、请求统计、登录任务、AI Credits 和 Copilot seat 状态。
- 在 Proxy 层包含 Claude Code / Anthropic Messages 相关兼容优化。

整体调用链：

```text
Client
  -> proxy compatible API
  -> proxy 按 X-User-Identity 找账号
  -> 首次使用时 proxy 调 sso 确保用户并同步 EMU
  -> proxy 调 login 创建自动登录任务
  -> login 完成 GitHub device flow + SSO 登录
  -> login 把 GitHub token 回写 proxy
  -> proxy 换取 Copilot token 并转发请求
```

`sso` 和 `login` 没有直接服务间调度关系；它们都由 `proxy` 或 `console` 通过内部 API 协调。

## 模块概览

| 模块 | 职责 |
| --- | --- |
| `src/proxy` | 对外 API 网关；鉴权、identity 映射、GitHub/Copilot token 管理、请求转发和统计。 |
| `src/sso` | 自定义 SAML IdP；SSO 用户、EMU/SCIM、Copilot seat、AI Credits 用量。 |
| `src/login` | GitHub device flow + Playwright 自动登录；成功后回写 GitHub token。 |
| `src/console` | Web 管理控制台；统一操作 proxy/sso/login 管理 API。 |
| `src/packages/shared` | 跨服务共享 DTO、HTTP client、logger、错误结构和工具。 |

更详细的代码结构和接口说明见 [`src/README.md`](./src/README.md)。

## 使用前提

部署前需要准备：

1. **GitHub Enterprise 订阅**，并启用 Enterprise Managed Users(EMU)。
2. **GitHub Copilot 可用授权**，并准备可管理 Copilot seat / AI Credits 的 GitHub PAT。
3. **GitHub Enterprise SAML SSO 配置权限**，可以把企业 SAML SSO 指向本项目的 `sso` 服务或你自己的 SSO/IdP。
4. **GitHub SCIM token**，用于 `sso` 服务批量创建、更新、暂停、删除 EMU 用户。
5. **SAML IdP 签名证书和私钥**。本项目提供 `scripts/gen-certs.sh` 生成开发证书；生产环境应使用你维护的证书。
6. **Docker / Docker Compose** 用于容器化部署；本地开发还需要 Node.js 22 和 npm。

## 快速启动（Docker Compose）

1. 复制并修改环境变量：

```bash
cp .env.example .env
```

至少需要替换：

| 变量 | 说明 |
| --- | --- |
| `API_KEY` | 调用 `proxy` 裸 API 时使用的 Bearer token。 |
| `INTERNAL_API_TOKEN` | `proxy`、`sso`、`login`、`console` 内部通信共享密钥。 |
| `SESSION_SECRET` | `sso` / `console` cookie session 签名密钥。 |
| `SSO_PUBLIC_BASE_URL` | `sso` 服务对 GitHub 可访问的公网地址。 |
| `SP_ENTITY_ID` / `SP_ACS_URL` | GitHub Enterprise SAML SP 配置。 |
| `ENTERPRISE_SLUG` / `ENTERPRISE_SHORTCODE` | GitHub Enterprise 标识和 EMU login 后缀。 |
| `SCIM_BASE_URL` / `SCIM_TOKEN` | GitHub Enterprise SCIM API 地址和 token。 |
| `GITHUB_COPILOT_SEAT_PAT` | 管理 Copilot seat / AI Credits 的 GitHub PAT。 |

根目录 `.env` 也包含 proxy 的公共 API 和转发 header 配置。Docker Compose 默认使用 `CLAUDE_CODE_OPTIMIZED=true` 启动 proxy，作为 Claude Code / Anthropic Messages 兼容优化和 `/v1/messages/count_tokens` 的默认模式；单个请求可用 `X-Claude-Code-Optimized: true|false` 覆盖，无需重启服务。

| 变量 | 说明 |
| --- | --- |
| `IDENTITY_HEADER` / `IDENTITY_HEADER_REQUIRED` | 调用方身份 header 名称和是否必填；默认 `X-User-Identity` 必填。 |
| `EDITOR_VERSION` / `EDITOR_PLUGIN_VERSION` / `USER_AGENT` | proxy 向 Copilot 后端转发时使用的编辑器标识 header。 |
| `GITHUB_API_VERSION` / `COPILOT_INTEGRATION_ID` | proxy 默认 Copilot/GitHub API 版本和集成标识 header。 |
| `VSCODE_SESSION_ID` / `VSCODE_MACHINE_ID` / `EDITOR_DEVICE_ID` | 请求解析为 Claude Code 优化模式时使用的 VS Code 风格 header；留空时每个 proxy 进程随机生成。 |
| `CLAUDE_CODE_GITHUB_API_VERSION` | 请求解析为 Claude Code 优化模式时覆盖转发请求的 `X-GitHub-Api-Version`。 |

2. 准备 SAML 证书：

```bash
bash scripts/gen-certs.sh
```

默认会生成到 `./certs`。如果使用自己的证书，请把 `idp-cert.pem` 和 `idp-key.pem` 放到 `.env` 中 `SSO_CERT_DIR` 指向的目录。

3. 启动服务：

```bash
npm run compose:up
```

4. 检查健康状态：

```bash
npm run validate:health
```

5. 打开控制台：

```text
http://localhost:7004
```

首次访问会创建本地控制台管理员。之后可以在控制台管理 SSO 用户、EMU 同步、Proxy 账号、登录任务、GitHub token 导入和请求统计。

## 调用 API

`proxy` 默认监听 `3000`，公共接口需要：

```http
Authorization: Bearer <API_KEY>
X-User-Identity: <your-user-identity>
Content-Type: application/json
X-Claude-Code-Optimized: true|false  # 可选；覆盖 CLAUDE_CODE_OPTIMIZED 默认值
```

示例：

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-User-Identity: alice"
```

首次请求某个 identity 时，如果账号和 token 还没准备好，`proxy` 可能返回 `202 account_initializing`。等待后台 SSO/EMU 同步和登录任务完成后再重试。

成功启动且 identity 对应账号可用后，可以调用 Anthropic Messages 系列接口：

```bash
curl http://localhost:3000/v1/messages \
  -H "x-api-key: $API_KEY" \
  -H "X-User-Identity: alice" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.6",
    "max_tokens": 256,
    "messages": [
      {
        "role": "user",
        "content": "用一句话介绍 GitHub Copilot。"
      }
    ]
  }'
```

```bash
curl http://localhost:3000/v1/messages/count_tokens \
  -H "x-api-key: $API_KEY" \
  -H "X-User-Identity: alice" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.6",
    "messages": [
      {
        "role": "user",
        "content": "统计这句话的输入 token。"
      }
    ]
  }'
```

也可以调用 OpenAI Responses 形状接口：

```bash
curl http://localhost:3000/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-User-Identity: alice" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": "用一句话说明 GitHub Copilot 的用途。"
  }'
```

或者调用 Responses Compact 形状接口（会话压缩）：

```bash
curl http://localhost:3000/v1/responses/compact \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-User-Identity: alice" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": "用一句话说明 GitHub Copilot 的用途。"
  }'
```

`model` 需要替换为支持目标 API path 的模型。`GET /v1/models` 现在按认证 header 类型返回不同结果：使用 `Authorization: Bearer` 时返回 OpenAI 风格模型列表，只包含支持 `/v1/responses` 的模型；使用 `x-api-key` 时返回 Anthropic/Claude 风格模型列表，只包含支持 `/v1/messages` 的模型，并保持 Copilot 原始模型名，例如 `claude-opus-4.8`。`/v1/responses` 示例中的 `gpt-5` 需要替换为账号可用且支持 `/v1/responses` 的 Copilot 模型。如果你在 `.env` 里改了 `IDENTITY_HEADER`，示例里的 `X-User-Identity` 也要同步替换。

Claude Code 可以通过 settings 文件接入本地 proxy，例如 `~/.claude/settings.json` ：

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_AUTH_TOKEN": "<API_KEY>",
    "ANTHROPIC_CUSTOM_HEADERS": "X-User-Identity: alice",
    "ANTHROPIC_MODEL": "<claude-model-from-v1-models>",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

如果使用项目内 `.claude/settings.local.json`，不要提交包含 `ANTHROPIC_AUTH_TOKEN` 的文件。

## 本地开发

```bash
npm install
npm run build:deploy
npm run typecheck:deploy
```

单独启动服务：

```bash
npm run start:sso
npm run start:login
npm run start:proxy
npm --workspace @ghcp/console run build
npm run start:console
```

## 测试 / Testing

### Unit tier（单元测试，无需外部服务）

```bash
# Run all workspaces unit tests
npm test

# Or run a single workspace
npm --workspace @ghcp/shared run test
npm --workspace @ghcp/proxy run test
npm --workspace @ghcp/sso run test
npm --workspace @ghcp/login run test
npm --workspace @ghcp/database run test
npm --workspace @ghcp/console run test
```

### Integration tier（集成测试，需要 PostgreSQL）

```bash
# Start the test database (Docker required)
docker compose -f docker-compose.test.yml up -d postgres-test

# Export the test database URL
export TEST_DATABASE_URL=postgres://ghcp_test:ghcp_test_password@localhost:5433/ghcp_test

# Run all integration tests
npm run test:integration

# Or run a single workspace
npm --workspace @ghcp/database run test:integration
npm --workspace @ghcp/proxy run test:integration
npm --workspace @ghcp/sso run test:integration
npm --workspace @ghcp/login run test:integration
```

Integration tests auto-skip when `TEST_DATABASE_URL` is not set.

### Coverage report（覆盖率报告）

```bash
# Build deps first (required), then run unit tests with coverage
npm --workspace @ghcp/shared run build && npm --workspace @ghcp/database run build
npm run test:coverage
```

Coverage target: ~80% line coverage on core logic (encryption, auth, repos, format utils).
Excluded: React UI, Playwright login flow, wiring/entry files.

## 必须知道的限制

- Copilot 后端不是正式公开的裸 API，一些模型能力、参数、流式格式或模型可见性可能与 OpenAI/Anthropic 官方 API 不完全一致。
- Copilot 内部 API 可能被 GitHub 产品组调整，生产使用可能受到兼容性影响。
- 本项目是开源自维护方案，不提供托管 SLA；部署、密钥、账号、合规、日志和安全策略需要使用方自行负责。
- 账号和 token 涉及敏感权限，不能提交 `.env`、SQLite 数据库、日志、Playwright trace、GitHub token 或 SSO 密码。
- EMU、SAML、SCIM、Copilot seat 配置依赖 GitHub Enterprise 管理权限；没有这些前提无法完整跑通批量账号和自动登录流程。
