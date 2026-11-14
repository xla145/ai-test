# RuoYi 接口加密

接口测试页点击「登录与加密」，按环境保存配置。子项目继承环境时配置保存到环境所属的大项目。

1. 协议选择 `RuoYi · AES-256-ECB + RSA`。
2. 填写请求加密公钥、响应解密私钥的本机 PEM 文件绝对路径。分别对应前端 `VITE_APP_RSA_PUBLIC_KEY` 和 `VITE_APP_RSA_PRIVATE_KEY`，不要把服务端私钥当成客户端私钥。不会将文件内容写进用例。
3. 公共请求头填写 `{"clientid":"实际客户端 ID"}`。
4. 可填入 RuoYi 登录模板，按实际环境修改 `clientId`、`tenantId`、验证码等字段。默认 `/auth/login`，token 路径 `data.access_token`；勾选加密登录正文。登录请求头可填写 `X-Mfa-Code`，当前不会自动生成 MFA/验证码。
5. 角色账号密码沿用已有角色配置。单接口、场景各步骤在 Body 页签开启「加密正文」。没有开启的请求仍发送普通 JSON。响应含 `encrypt-key` 时先解密，再执行断言与变量提取。

协议按 rundo_platform_web 的 crypto.ts / jsencrypt.ts 实现：每次请求使用新的 32 位字母数字 AES 密钥；AES-256-ECB / PKCS7；AES 密钥 Base64 后经 RSA PKCS#1 v1.5 包装进入 encrypt-key；正文为 Base64 密文字符串，不额外 JSON 编码。

调试、登录与导出的 pytest 回归共享实现。导出脚本需安装 `cryptography>=42`，通过 `AITEST_API_CRYPTO` JSON 传入协议和本机密钥路径；桌面执行自动注入。换执行机器时需要重新配置可访问的密钥文件路径。

请求记录保留脱敏后的逻辑正文，响应展示脱敏后的解密 JSON。encrypt-key 不进入明文报告。密钥缺失、格式错误、解密失败均报错，不回退成明文请求。
