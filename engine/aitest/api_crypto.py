"""RuoYi browser-compatible AES/RSA envelope. Key material stays in local PEM files."""
import base64
import json
import secrets
import string
from pathlib import Path


def _key(config, kind):
    from cryptography.hazmat.primitives import serialization
    path = config.get(f"{kind}_key_file")
    if not path:
        raise ValueError(f"接口加密未配置 RSA {kind} PEM 文件")
    try:
        data = Path(path).expanduser().read_bytes()
        return (serialization.load_pem_public_key(data) if kind == "public"
                else serialization.load_pem_private_key(data, password=None))
    except Exception:
        raise ValueError(f"无法读取 RSA {kind} PEM 密钥，请检查文件和格式") from None


def prepare(env, request, kwargs):
    config = env.get("api_crypto") or {}
    headers = {**config.get("headers", {}), **kwargs.get("headers", {})}
    kwargs = {**kwargs, "headers": headers}
    enabled = request.get("encrypt", False) or any(k.lower() == "isencrypt" and str(v).lower() == "true" for k, v in headers.items())
    if not enabled:
        return kwargs
    if config.get("protocol") != "ruoyi":
        raise ValueError("请求已启用加密，请先配置环境的 RuoYi AES/RSA 协议")
    if request.get("method", "POST").upper() not in ("POST", "PUT"):
        raise ValueError("RuoYi 请求加密仅支持 POST / PUT")
    if kwargs.get("json") is None:
        raise ValueError("加密请求需要填写正文")
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.asymmetric import padding as rsa_padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    key = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32)).encode()
    body = kwargs.pop("json")
    text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False, separators=(',', ':'))
    pad = padding.PKCS7(128).padder()
    padded = pad.update(text.encode()) + pad.finalize()
    enc = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    kwargs["content"] = base64.b64encode(enc.update(padded) + enc.finalize()).decode()
    headers = {k: str(v) for k, v in headers.items() if k.lower() not in ("encrypt-key", "content-type", "content-length", "isencrypt")}
    headers["encrypt-key"] = base64.b64encode(_key(config, "public").encrypt(base64.b64encode(key), rsa_padding.PKCS1v15())).decode()
    headers["Content-Type"] = "application/json;charset=utf-8"
    kwargs["headers"] = headers
    return kwargs


def response_body(env, response):
    config = env.get("api_crypto") or {}
    wrapped = response.headers.get("encrypt-key")
    if wrapped:
        if config.get("protocol") != "ruoyi":
            raise ValueError("响应已加密，请配置环境的 RuoYi AES/RSA 协议")
        from cryptography.hazmat.primitives import padding
        from cryptography.hazmat.primitives.asymmetric import padding as rsa_padding
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        private = _key(config, "private")
        try:
            key = base64.b64decode(private.decrypt(base64.b64decode(wrapped, validate=True), rsa_padding.PKCS1v15()), validate=True)
            dec = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
            padded = dec.update(base64.b64decode(response.text, validate=True)) + dec.finalize()
            unpad = padding.PKCS7(128).unpadder()
            return json.loads((unpad.update(padded) + unpad.finalize()).decode())
        except Exception:
            raise ValueError("响应解密失败，请检查 RSA 密钥与服务端加密配置") from None
    if response.content and "json" in response.headers.get("content-type", ""):
        return response.json()
    return None
