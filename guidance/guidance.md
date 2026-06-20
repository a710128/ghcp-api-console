
## 准备工作 
### 配置 GitHub Enterprise SAML SSO 
1. 登陆gh，从个人profile，创建 enterprise。enterprise 类型请选择 EMU （enterprise managed user），Id Provider 选择 ‘Custom or Other’。
    - slug 是指创建完 enterprise 之后，在URL上显示的企业标识。
    - shortcode 是用户在用EMU登陆时的后缀，比如shortcode写成 `open`，用户登录时输入 `user1_open`。
    - 创建好EMU之后的默认超级管理员是 admin_shortcode，上面的例子里，超级管理员就是 `admin_open`。
2. 请务必填写真实的管理员邮箱地址。超级管理员的密码重置地址会发邮件到这个邮箱。
3. 注册成功后，邮箱会收到一封邮件，里面包含了超级管理员的密码重置地址，填写完密码后，会有restore code，后续每用超级管理员登陆一次，都需要消耗一个restore code。restore code相当于超级管理员的二次验证码。
4. 登陆成功后，创建PAT，权限需要有？？，作为SCIM token，稍后配置sso会用到。
5. 进入enterprise设置，启用SAML SSO，在 single sign-on configuration 页面中填入以下信息：
    - Sign on URL: `https://<sso 服务的公网地址>/sso`
    - Issuer: `https://<sso 服务的公网地址>/metadata`
    - Public certificate: 由 `scripts/gen-certs.sh` 生成的公钥内容，文件默认路径 `certs/idp-cert.pem`，打开这个文件复制内容到这个区域。
6. 保存后，GitHub会提供一个测试链接，点击测试链接，如果看到sso服务的默认页面，并且能够登陆成功，说明配置成功了。
7. 在SSO 配置页面启用 Open SCIM Configuration 按钮。
8. 在billing页面的payment information里，填写payment information和shipping information 之后，添加自己的azure订阅信息。
9. 激活github enterprise。并在support.github.com上提交工单，要求开通copilot功能。提交工单后，记录工单号，之后可以联系gh的销售，方便加速开通copilot。

### 启用SSO应用 
0. 需要和上一章节同步进行
1. 按readme启用sso应用，并绑定公网地址。有正式域名最佳。
2. 在sso服务的.env文件中配置相关的变量：
```
ENTERPRISE_SLUG=<your_enterprise_slug>
ENTERPRISE_SHORTCODE=<your_enterprise_shortcode>
GITHUB_API_BASE_URL=https://api.github.com
SCIM_BASE_URL=https://api.github.com/scim/v2/enterprises/<your_enterprise_slug>
SCIM_TOKEN=<your_scim_token> //这个是上面步骤4创建的PAT
SCIM_REQUEST_DELAY_MS=250
SCIM_MAX_RETRIES=3
SCIM_RETRY_BASE_DELAY_MS=1000
GITHUB_COPILOT_SEAT_PAT=<your_github_copilot_seat_pat> //这个是一个PAT，需要 manage_billing:enterprise 和 manage_billing:copilot 权限，在同步完管理员后，可以用管理员账号登录GitHub 后创建
```
3. 启用sso服务，在GH侧也配置完毕后，可以启动 console 服务，登录控制台，在SSO User页面创建用户，并同步新用户到GH，注意，请至少新建一个管理员，并同步到gh ent侧，作为gh的管理员。
4. 用刚才同步过去的管理员，加上shortcode后缀，登陆gh，验证没有问题。并用管理员开启Copilot服务（需要gh后台开通了copilot功能）。
5. 在 console 的 SSO User 页面，可以管理用户在gh上的权限。

## 配置其他应用
1. 按readme分别配置 login 和 proxy 应用。
    - login 主要接受 api 请求，然后开始基于 playwright 的自动化登录流程，完成后会调用proxy api把gh token回写给proxy。
    - proxy 主要负责对外提供兼容gh copilot的api，处理鉴权、用户身份映射、token管理、请求转发等功能。
    - proxy 在用户访问时，如果key正确，也带了正确的header，就会根据header信息，调用SSO 和 login API，自动创建用户，授权copilot，并自动登录获取gh token，从而对外提供服务。

2. 验证 console、sso、login、proxy 四个服务都正常工作后，就可以在用户侧调用了。

## 使用方式
1. 参考 [readme.md](../README.md) 中的使用方式，用户拿到有效的key之后，在请求header里包含 x-user-identity 即可使用proxy。
2. 第一次访问proxy，如果是新用户，创建用户并登录需要大约1-2分钟时间。
3. 登陆成功后，后续访问proxy 和访问裸api没有区别。

## 管理功能

1. Console 首次访问 `http://localhost:7004` 会创建本地管理员。之后所有管理操作都从 console 进入，浏览器只访问 `/api/console/**`，由 console 统一带上 `X-Internal-Token` 转发到 proxy、sso、login。
2. Dashboard 可以查看 proxy accounts、SSO users、login tasks、request stats 的汇总，以及近期失败任务和失败请求。
3. SSO Users 页面可以查询、创建、编辑、CSV 导入 SSO 用户，也可以从 GH/SCIM 预览并应用导入计划。
4. SSO Users 页面支持批量操作用户，包括同步 EMU、挂起 EMU、删除 EMU、删除本地 SSO 用户、分配 Copilot seat、移除 Copilot seat。
5. AI Credits Usage 页面可以读取和刷新企业 AI Credits 用量，并查看预计本月用量和 Copilot seat 成本。
6. Proxy Accounts 页面可以查看 `identity -> ssoUser -> ghLogin` 映射和 GitHub/Copilot token 状态，也可以导入 GitHub token、刷新 GitHub token、刷新 Copilot token。
7. Login Tasks 页面可以查询、分页、筛选登录任务，并取消 pending/running 任务、重试失败任务、删除 success/failed/cancelled 任务。
8. Request Stats 页面可以查看 proxy 请求统计，按 identity/GH login、model、成功状态过滤。
9. Diagnostics 页面可以检查 proxy、sso、login-service 的连通性，以及内部 token 是否匹配。

## 注意事项

1. Copilot 后端不是正式公开的裸 API，模型能力、参数、流式格式、模型可见性和内部接口都可能变化，生产使用前需要自行评估合规、稳定性和运维风险。
2. 完整跑通需要 GitHub Enterprise EMU、GitHub Copilot 可用授权、SAML SSO 配置权限、SCIM token、可管理 Copilot seat/AI Credits 的 GitHub PAT，以及 SAML IdP 证书和私钥。
3. `INTERNAL_API_TOKEN` 需要在 proxy、sso、login、console 中保持一致；`API_KEY` 只用于 proxy 公共 API；生产环境需要设置真实的 `SESSION_SECRET`。
4. SSO 的公网地址、`SP_ENTITY_ID`、`SP_ACS_URL`、证书目录需要和 GitHub Enterprise SAML 配置保持一致，证书目录中必须有 `idp-cert.pem` 和 `idp-key.pem`。
5. 调用 proxy 时必须带正确的 API Key 和身份 header。默认身份 header 是 `X-User-Identity`，如果 `.env` 改了 `IDENTITY_HEADER`，用户侧请求也要同步修改。
6. 首次请求某个新 identity 时，proxy 可能先返回 `202 account_initializing`。需要等待 SSO/EMU 同步和 login 登录任务完成后再重试，创建用户并登录通常需要 1-2分钟。
7. IDENTITY_HEADER_REQUIRED 等于 false 时，proxy会用名称为 default 的用户身份call copilot api
7. proxy 不会在 OpenAI、Anthropic、Responses 请求体之间互转。调用方必须把请求发到匹配的路径，并使用当前账号和目标路径支持的模型。
8. `CLAUDE_CODE_OPTIMIZED=true` 时才会开启 Claude Code / Anthropic Messages 兼容优化和 `/v1/messages/count_tokens`；`/v1/files*`、web_search 相关能力当前不是完整支持的通用能力。
9. login 队列是进程内队列，默认并发为 `LOGIN_CONCURRENCY=1`；服务重启时未完成的 pending/running 任务会被标记为 failed，当前未提供多实例分布式锁。此外，login自动登录是基于 playwright 的浏览器自动化，不建议并行度太高。gh允许的单ip出口并行登录数量并未做测试，也米有官方文档说明。
10. sso 没有后台自动对账、自动重试队列或定时任务；SCIM、Copilot seat、proxy 清理等跨系统一致性主要依赖显式 API 操作和重试。
11. 不要提交 `.env`、SQLite 数据库、管理员文件、登录日志、Playwright trace、失败截图、GitHub token、SSO 密码，或者包含 `ANTHROPIC_AUTH_TOKEN` 的 Claude settings 文件。