from __future__ import annotations

import json
import hashlib
import ipaddress
import os
import re
import secrets
import shutil
import sqlite3
import uuid
from base64 import b64encode
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, unquote, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
PUBLIC_ROOT = ROOT / "public"
UPLOADS = Path(os.environ.get("KZIN_UPLOADS_DIR", ROOT / "uploads")).expanduser().resolve()
DATA = Path(os.environ.get("KZIN_DATA_DIR", ROOT / "data")).expanduser().resolve()
CATALOG = DATA / "releases.json"
MAX_UPLOAD = 2 * 1024 * 1024 * 1024
UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024
SESSION_DB = DATA / "auth.sqlite3"
SESSION_MAX_AGE = 60 * 60 * 24 * 30
OAUTH_STATES = {}
UPLOADS.mkdir(parents=True, exist_ok=True)
DATA.mkdir(parents=True, exist_ok=True)
UPLOAD_STAGING = UPLOADS / ".upload-staging"
UPLOAD_STAGING.mkdir(parents=True, exist_ok=True)
if not CATALOG.exists():
    CATALOG.write_text("[]", encoding="utf-8")


def load_dotenv():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


load_dotenv()
BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:8000").rstrip("/")
ADMIN_EMAILS = {value.strip().lower() for value in os.environ.get("ADMIN_EMAILS", "").split(",") if value.strip()}


def oauth_credentials(provider):
    prefix = provider.upper()
    return os.environ.get(f"{prefix}_CLIENT_ID", ""), os.environ.get(f"{prefix}_CLIENT_SECRET", "")


def auth_db():
    connection = sqlite3.connect(SESSION_DB)
    connection.row_factory = sqlite3.Row
    connection.execute("""CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL,
        email TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '',
        UNIQUE(provider, provider_id))""")
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
    for name, declaration in (
        ("google_sub", "TEXT"), ("discord_sub", "TEXT"), ("avatar_url", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "INTEGER NOT NULL DEFAULT 0"), ("last_login", "INTEGER NOT NULL DEFAULT 0"),
    ):
        if name not in columns:
            connection.execute(f"ALTER TABLE users ADD COLUMN {name} {declaration}")
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub)")
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_discord_sub ON users(discord_sub)")
    connection.execute("""CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id))""")
    connection.execute("""CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id))""")
    connection.commit()
    return connection


def user_is_admin(user):
    return bool(user and user["email"].lower() in ADMIN_EMAILS)


def read_catalog():
    try:
        return json.loads(CATALOG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


class KzinflixHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_ROOT), **kwargs)

    def translate_path(self, path):
        parsed_path = unquote(urlparse(path).path)
        if parsed_path.startswith("/uploads/"):
            relative_path = Path(parsed_path.removeprefix("/uploads/"))
            if relative_path.is_absolute() or ".." in relative_path.parts or ".upload-staging" in relative_path.parts:
                return str(UPLOADS / "__invalid__")
            return str(UPLOADS / relative_path)
        return super().translate_path(path)

    def send_json(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json_with_cookies(self, status, value, cookies=()):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for cookie in cookies:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location, cookies=()):
        self.send_response(302)
        self.send_header("Location", location)
        for cookie in cookies:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def send_media_file(self, path, content_type, byte_ranges=False):
        size = path.stat().st_size
        start, end = 0, size - 1
        range_header = self.headers.get("Range", "") if byte_ranges else ""
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match or (not match.group(1) and not match.group(2)):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            if match.group(1):
                start = int(match.group(1))
                if match.group(2):
                    end = int(match.group(2))
            else:
                suffix_length = int(match.group(2))
                start = max(0, size - suffix_length)
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(max(0, end - start + 1)))
        self.send_header("Content-Disposition", "inline")
        self.send_header("X-Content-Type-Options", "nosniff")
        if byte_ranges:
            self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        with path.open("rb") as media_file:
            media_file.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = media_file.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def cookie(self, name):
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get("Cookie", ""))
            return cookies[name].value if name in cookies else ""
        except Exception:
            return ""

    def require_upload_admin(self):
        origin = self.headers.get("Origin", "").rstrip("/")
        if origin != BASE_URL:
            self.send_json(403, {"error": "Origem da solicitação inválida."})
            return None
        user = self.current_user()
        if not user and self.local_admin():
            user = {"id": "local-admin", "email": "local@localhost"}
        if not user:
            self.send_json(401, {"error": "Entre com a conta administradora para enviar vídeos."})
            return None
        if not user_is_admin(user) and not self.local_admin():
            self.send_json(403, {"error": "Esta conta não tem permissão para publicar."})
            return None
        return user

    def read_staged_upload(self, upload_id, user):
        if not re.fullmatch(r"[a-f0-9]{32}", upload_id or ""):
            return None
        folder = UPLOAD_STAGING / upload_id
        try:
            metadata = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
            if metadata.get("owner") != user["id"]:
                return None
            path = folder / "media.part"
            if (not path.is_file() or path.stat().st_size != metadata["size"]
                    or len(metadata.get("received", [])) != metadata.get("chunks")):
                return None
            return {"id": upload_id, "folder": folder, "path": path, **metadata}
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def start_chunked_upload(self):
        user = self.require_upload_admin()
        if not user:
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 16_384:
                raise ValueError
            data = json.loads(self.rfile.read(length))
            filename = Path(str(data.get("fileName", "")).replace("\\", "/")).name
            size = int(data.get("size", 0))
            extension = Path(filename).suffix.lower()
            if extension not in {".mp4", ".webm", ".pdf"} or size <= 0 or size > MAX_UPLOAD:
                raise ValueError
        except (ValueError, TypeError, json.JSONDecodeError):
            return self.send_json(413, {"error": "O arquivo precisa ser PDF, MP4 ou WebM e ter no máximo 2 GB."})
        upload_id = uuid.uuid4().hex
        chunks = (size + UPLOAD_CHUNK_SIZE - 1) // UPLOAD_CHUNK_SIZE
        folder = UPLOAD_STAGING / upload_id
        folder.mkdir(mode=0o700)
        metadata = {"owner": user["id"], "fileName": filename, "size": size,
                    "chunks": chunks, "received": []}
        (folder / "meta.json").write_text(json.dumps(metadata), encoding="utf-8")
        with (folder / "media.part").open("wb") as media:
            media.truncate(size)
        return self.send_json(201, {"uploadId": upload_id, "chunkSize": UPLOAD_CHUNK_SIZE, "chunks": chunks})

    def receive_upload_chunk(self, upload_id, chunk_index):
        user = self.require_upload_admin()
        if not user:
            return
        if not re.fullmatch(r"[a-f0-9]{32}", upload_id):
            return self.send_json(404, {"error": "Envio não encontrado."})
        folder = UPLOAD_STAGING / upload_id
        try:
            metadata = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
            index = int(chunk_index)
            if metadata.get("owner") != user["id"] or index < 0 or index >= metadata["chunks"]:
                raise ValueError
            offset = index * UPLOAD_CHUNK_SIZE
            expected = min(UPLOAD_CHUNK_SIZE, metadata["size"] - offset)
            length = int(self.headers.get("Content-Length", "0"))
            if length != expected or length > UPLOAD_CHUNK_SIZE:
                return self.send_json(413, {"error": "Bloco inválido; tente enviar novamente."})
            data = self.rfile.read(length)
            if len(data) != length:
                return self.send_json(400, {"error": "Bloco recebido incompleto."})
            with (folder / "media.part").open("r+b") as media:
                media.seek(offset)
                media.write(data)
            received = set(metadata.get("received", []))
            received.add(index)
            metadata["received"] = sorted(received)
            (folder / "meta.json").write_text(json.dumps(metadata), encoding="utf-8")
            return self.send_json(200, {"ok": True, "received": len(received), "total": metadata["chunks"]})
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            return self.send_json(404, {"error": "Envio não encontrado ou incompleto."})

    def cancel_chunked_uploads(self):
        user = self.require_upload_admin()
        if not user:
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 16_384:
                raise ValueError
            payload = json.loads(self.rfile.read(length))
            ids = payload.get("uploadIds", [])
            if not isinstance(ids, list) or len(ids) > 100:
                raise ValueError
        except (ValueError, TypeError, json.JSONDecodeError):
            return self.send_json(400, {"error": "Lista de envios inválida."})
        removed = 0
        for upload_id in ids:
            folder = UPLOAD_STAGING / upload_id if re.fullmatch(r"[a-f0-9]{32}", str(upload_id or "")) else None
            if folder and folder.is_dir():
                try:
                    metadata = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if metadata.get("owner") == user["id"]:
                    shutil.rmtree(folder, ignore_errors=True)
                    removed += 1
        return self.send_json(200, {"ok": True, "removed": removed})

    def current_user(self):
        token = self.cookie("kzin_session")
        if not token:
            return None
        hashed = hashlib.sha256(token.encode()).hexdigest()
        connection = auth_db()
        row = connection.execute("""SELECT users.id, users.email,
            COALESCE(NULLIF(user_profiles.display_name,''),users.name) AS name,
            COALESCE(NULLIF(user_profiles.avatar_url,''),users.avatar) AS avatar
            FROM sessions JOIN users ON users.id=sessions.user_id
            LEFT JOIN user_profiles ON user_profiles.user_id=users.id
            WHERE sessions.token_hash=? AND sessions.expires_at>?""", (hashed, int(datetime.now(timezone.utc).timestamp()))).fetchone()
        if not row:
            connection.execute("DELETE FROM sessions WHERE token_hash=?", (hashed,))
            connection.commit()
        connection.close()
        return row

    def local_admin(self):
        """Enable local development publishing only from a loopback host."""
        local_mode = os.environ.get("LOCAL_DEV_MODE", "1").strip().lower() not in {"0", "false", "no"}
        no_admin_list = not ADMIN_EMAILS
        try:
            loopback = ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            loopback = False
        host = urlparse(f"//{self.headers.get('Host', '')}").hostname or ""
        try:
            local_host = host == "localhost" or ipaddress.ip_address(host).is_loopback
        except ValueError:
            local_host = False
        return local_mode and loopback and local_host and no_admin_list

    def session_cookie(self, token, max_age=SESSION_MAX_AGE):
        secure = "; Secure" if BASE_URL.startswith("https://") else ""
        return f"kzin_session={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}"

    def state_cookie(self, provider, state, max_age=600):
        secure = "; Secure" if BASE_URL.startswith("https://") else ""
        return f"oauth_state_{provider}={state}; Path=/auth/{provider}/callback; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}"

    def csrf_cookie(self):
        token = self.cookie("kzin_google_csrf") or secrets.token_urlsafe(32)
        secure = "; Secure" if BASE_URL.startswith("https://") else ""
        return token, f"kzin_google_csrf={token}; Path=/; Max-Age=86400; SameSite=Lax{secure}"

    def post_oauth_form(self, endpoint, values, basic_auth=None):
        headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
        if basic_auth:
            encoded = b64encode(f"{basic_auth[0]}:{basic_auth[1]}".encode()).decode()
            headers["Authorization"] = f"Basic {encoded}"
        request = Request(endpoint, data=urlencode(values).encode(), headers=headers, method="POST")
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read())

    def oauth_identity(self, provider, code):
        client_id, client_secret = oauth_credentials(provider)
        redirect_uri = f"{BASE_URL}/auth/{provider}/callback"
        if provider == "google":
            tokens = self.post_oauth_form("https://oauth2.googleapis.com/token", {
                "code": code, "client_id": client_id, "client_secret": client_secret,
                "redirect_uri": redirect_uri, "grant_type": "authorization_code",
            })
            request = Request("https://openidconnect.googleapis.com/v1/userinfo", headers={
                "Authorization": f"Bearer {tokens['access_token']}", "Accept": "application/json"
            })
            with urlopen(request, timeout=20) as response:
                profile = json.loads(response.read())
            if not profile.get("email_verified"):
                raise ValueError("O Google não confirmou este endereço de e-mail.")
            return str(profile["sub"]), profile["email"].lower(), profile.get("name", "Google user"), profile.get("picture", "")

        tokens = self.post_oauth_form(
            "https://discord.com/api/oauth2/token",
            {"code": code, "redirect_uri": redirect_uri, "grant_type": "authorization_code"},
            basic_auth=(client_id, client_secret),
        )
        request = Request("https://discord.com/api/v10/users/@me", headers={
            "Authorization": f"Bearer {tokens['access_token']}", "Accept": "application/json"
        })
        with urlopen(request, timeout=20) as response:
            profile = json.loads(response.read())
        if not profile.get("email") or not profile.get("verified"):
            raise ValueError("O Discord precisa retornar um e-mail verificado para esta conta.")
        avatar = profile.get("avatar")
        image_url = ""
        if avatar:
            extension = "gif" if avatar.startswith("a_") else "png"
            image_url = f"https://cdn.discordapp.com/avatars/{profile['id']}/{avatar}.{extension}?size=128"
        return str(profile["id"]), profile["email"].lower(), profile.get("global_name") or profile["username"], image_url

    def save_oauth_user(self, provider, identity):
        provider_id, email, name, avatar = identity
        connection = auth_db()
        id_column = "google_sub" if provider == "google" else "discord_sub"
        existing = connection.execute(f"SELECT id,google_sub,discord_sub FROM users WHERE {id_column}=?", (provider_id,)).fetchone()
        if not existing:
            # Both providers return verified e-mails; matching one lets a person use either sign-in.
            existing = connection.execute("SELECT id,google_sub,discord_sub FROM users WHERE lower(email)=lower(?)", (email,)).fetchone()
        user_id = existing["id"] if existing else uuid.uuid4().hex
        now = int(datetime.now(timezone.utc).timestamp())
        google_sub = provider_id if provider == "google" else (existing["google_sub"] if existing else None)
        discord_sub = provider_id if provider == "discord" else (existing["discord_sub"] if existing else None)
        if existing:
            connection.execute(f"""UPDATE users SET provider=?,provider_id=?,email=?,name=?,avatar=?,avatar_url=?,
                google_sub=?,discord_sub=?,last_login=? WHERE id=?""",
                (provider, provider_id, email, name, avatar, avatar, google_sub, discord_sub, now, user_id))
        else:
            connection.execute("""INSERT INTO users
                (id,provider,provider_id,email,name,avatar,google_sub,discord_sub,avatar_url,created_at,last_login)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (user_id, provider, provider_id, email, name, avatar, google_sub, discord_sub, avatar, now, now))
        session = secrets.token_urlsafe(32)
        expires = int(datetime.now(timezone.utc).timestamp()) + SESSION_MAX_AGE
        connection.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
                           (hashlib.sha256(session.encode()).hexdigest(), user_id, expires))
        connection.execute("DELETE FROM sessions WHERE expires_at<=?", (int(datetime.now(timezone.utc).timestamp()),))
        connection.commit()
        connection.close()
        return session

    def create_google_session(self, token):
        from google.auth.transport.requests import Request as GoogleRequest
        from google.oauth2 import id_token

        client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
        payload = id_token.verify_oauth2_token(token, GoogleRequest(), client_id)
        if not payload.get("email") or not payload.get("email_verified") or not payload.get("sub"):
            raise ValueError("A conta Google precisa ter e-mail verificado.")
        session = self.save_oauth_user("google", (
            str(payload["sub"]), payload["email"].lower(), payload.get("name", "Google user"), payload.get("picture", "")
        ))
        return session

    def login_with_google_gis(self):
        origin = self.headers.get("Origin", "")
        if origin.rstrip("/") != BASE_URL:
            return self.send_json(403, {"error": "Origem do login inválida."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_json(400, {"error": "Credencial inválida."})
        if length <= 0 or length > 32_000:
            return self.send_json(400, {"error": "Credencial inválida."})
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self.send_json(400, {"error": "Credencial inválida."})
        csrf_cookie = self.cookie("kzin_google_csrf")
        csrf_body = str(body.get("csrf_token", ""))
        if not csrf_cookie or not secrets.compare_digest(csrf_cookie, csrf_body):
            return self.send_json(403, {"error": "Não foi possível validar a tentativa de login. Atualize a página."})
        token = str(body.get("credential", ""))
        if not token:
            return self.send_json(400, {"error": "O Google não retornou uma credencial."})
        try:
            session = self.create_google_session(token)
            return self.send_json_with_cookies(200, {"ok": True}, [self.session_cookie(session)])
        except ImportError:
            return self.send_json(503, {"error": "Dependência de validação do Google ausente. Instale requirements.txt."})
        except Exception:
            return self.send_json(401, {"error": "A credencial do Google é inválida ou expirou."})

    def begin_oauth(self, provider):
        client_id, client_secret = oauth_credentials(provider)
        if not client_id or not client_secret:
            return self.redirect(f"/?auth_error={provider}_not_configured#login")
        state = secrets.token_urlsafe(32)
        OAUTH_STATES[state] = (provider, state, datetime.now(timezone.utc).timestamp() + 600)
        redirect_uri = f"{BASE_URL}/auth/{provider}/callback"
        if provider == "google":
            endpoint = "https://accounts.google.com/o/oauth2/v2/auth"
            params = {"client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
                      "scope": "openid email profile", "state": state}
        else:
            endpoint = "https://discord.com/oauth2/authorize"
            params = {"client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
                      "scope": "identify email", "state": state}
        return self.redirect(f"{endpoint}?{urlencode(params)}", [self.state_cookie(provider, state)])

    def finish_oauth(self, provider, query):
        params = parse_qs(query)
        state = params.get("state", [""])[0]
        entry = OAUTH_STATES.pop(state, None)
        expected_cookie = self.cookie(f"oauth_state_{provider}")
        clear_state = self.state_cookie(provider, "", 0)
        if not entry or entry[0] != provider or entry[1] != expected_cookie or entry[2] < datetime.now(timezone.utc).timestamp():
            return self.redirect("/?auth_error=state#login", [clear_state])
        if params.get("error"):
            return self.redirect("/?auth_error=denied#login", [clear_state])
        code = params.get("code", [""])[0]
        if not code:
            return self.redirect("/?auth_error=missing_code#login", [clear_state])
        try:
            identity = self.oauth_identity(provider, code)
            session = self.save_oauth_user(provider, identity)
            return self.redirect("/", [clear_state, self.session_cookie(session)])
        except Exception as error:
            print(f"{provider} OAuth callback failed: {error}")
            return self.redirect("/?auth_error=provider_error#login", [clear_state])

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == "/healthz":
            return self.send_json(200, {"ok": True})
        if path == "/api/me":
            user = self.current_user()
            local_mode = self.local_admin()
            if not user and local_mode:
                user = {"id": "local-admin", "email": "local@localhost", "name": "Admin local", "avatar": ""}
            _, csrf_cookie = self.csrf_cookie()
            google_client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
            client_id = {
                "google": bool(google_client_id),
                "googleClientId": google_client_id,
                "discord": bool(oauth_credentials("discord")[0] and oauth_credentials("discord")[1]),
            }
            public_user = None if not user else {
                "id": user["id"], "email": user["email"], "name": user["name"],
                "avatar": user["avatar"], "isAdmin": local_mode or user_is_admin(user),
            }
            return self.send_json_with_cookies(200, {"user": public_user, "providers": client_id, "localMode": local_mode}, [csrf_cookie])
        if path == "/api/profile":
            user = self.current_user()
            if not user:
                return self.send_json(401, {"error": "Entre na sua conta para acessar o perfil."})
            connection = auth_db()
            profile = connection.execute(
                "SELECT display_name,avatar_url FROM user_profiles WHERE user_id=?", (user["id"],)
            ).fetchone()
            account = connection.execute(
                "SELECT name,avatar FROM users WHERE id=?", (user["id"],)
            ).fetchone()
            connection.close()
            return self.send_json(200, {
                "displayName": profile["display_name"] if profile else "",
                "avatarUrl": profile["avatar_url"] if profile else "",
                "accountName": account["name"] if account else user["name"],
                "accountAvatar": account["avatar"] if account else user["avatar"],
            })
        if path == "/auth/discord":
            return self.begin_oauth("discord")
        if path == "/auth/discord/callback":
            return self.finish_oauth("discord", urlparse(self.path).query)
        if path == "/auth/logout":
            token = self.cookie("kzin_session")
            if token:
                connection = auth_db()
                connection.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
                connection.commit()
                connection.close()
            return self.redirect("/", [self.session_cookie("", 0)])
        if path == "/api/releases":
            releases = [
                item for item in read_catalog()
                if all(item.get(field) for field in ("slug", "genre", "coverUrl"))
            ]
            releases.sort(key=lambda item: item["addedAt"], reverse=True)
            return self.send_json(200, releases)
        if path.startswith("/api/releases/by-slug/"):
            slug = path.rsplit("/", 1)[-1]
            release = next((item for item in read_catalog() if item.get("slug") == slug), None)
            return self.send_json(200, release) if release else self.send_json(404, {"error": "Obra não encontrada."})
        if path.startswith("/api/releases/"):
            if not self.current_user() and not self.local_admin():
                return self.send_json(401, {"error": "Entre na sua conta para ler esta publicação."})
            release_id = path.rsplit("/", 1)[-1]
            release = next((item for item in read_catalog() if item["id"] == release_id), None)
            if not release:
                return self.send_json(404, {"error": "Lançamento não encontrado."})
            episode_values = parse_qs(urlparse(self.path).query).get("episode", ["0"])
            try:
                episode_index = max(0, int(episode_values[0]))
            except (TypeError, ValueError):
                return self.send_json(400, {"error": "Episódio inválido."})
            episodes = release.get("episodes") or []
            if episodes:
                if episode_index >= len(episodes):
                    return self.send_json(404, {"error": "Episódio não encontrado."})
                media_ext = episodes[episode_index].get("mediaExt") or release.get("mediaExt") or ".mp4"
                media_name = release_id if episode_index == 0 else f"{release_id}-episode-{episode_index + 1}"
            else:
                media_ext = release.get("mediaExt") or ".pdf"
                media_name = release_id
            if media_ext not in {".pdf", ".mp4", ".webm"}:
                return self.send_json(404, {"error": "Arquivo da publicação inválido."})
            media_path = UPLOADS / f"{media_name}{media_ext}"
            if not media_path.is_file():
                return self.send_json(404, {"error": "Arquivo não encontrado."})
            content_type = {".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm"}[media_ext]
            return self.send_media_file(media_path, content_type, byte_ranges=media_ext in {".mp4", ".webm"})
        if path.startswith("/uploads/") and Path(path).suffix.lower() in {".pdf", ".mp4", ".webm"} and not self.current_user():
            if not self.local_admin():
                return self.send_json(401, {"error": "Entre na sua conta para ler esta publicação."})
        if (path.rstrip("/") == "/perfil" or path.startswith("/m/") or path.startswith("/manga/")
                or path.startswith("/manhwa/") or path.startswith("/anime/")):
            self.path = "/index.html"
            return super().do_GET()
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/auth/google":
            return self.login_with_google_gis()
        if path == "/api/uploads/start":
            return self.start_chunked_upload()
        if path == "/api/uploads/cancel":
            return self.cancel_chunked_uploads()
        chunk_match = re.fullmatch(r"/api/uploads/([a-f0-9]{32})/(\d+)", path)
        if chunk_match:
            return self.receive_upload_chunk(chunk_match.group(1), chunk_match.group(2))
        episode_match = re.fullmatch(r"/api/releases/([a-f0-9]{32})/episodes", path)
        if episode_match:
            return self.append_anime_episodes(episode_match.group(1))
        if path != "/api/releases":
            return self.send_json(404, {"error": "Rota não encontrada."})
        origin = self.headers.get("Origin", "")
        if origin and origin.rstrip("/") != BASE_URL:
            parsed_origin = urlparse(origin)
            origin_host = parsed_origin.hostname or ""
            try:
                origin_is_loopback = origin_host == "localhost" or ipaddress.ip_address(origin_host).is_loopback
            except ValueError:
                origin_is_loopback = False
            if not (self.local_admin() and origin_is_loopback and parsed_origin.port == urlparse(BASE_URL).port):
                return self.send_json(403, {"error": "Origem da publicação inválida."})
        user = self.current_user()
        if not user and self.local_admin():
            user = {"email": "local@localhost"}
        if not user:
            return self.send_json(401, {"error": "Entre com Google ou Discord para publicar."})
        if not user_is_admin(user) and not self.local_admin():
            return self.send_json(403, {"error": "Esta conta não tem permissão para publicar."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_json(400, {"error": "Tamanho de arquivo inválido."})
        if length <= 0 or length > 24 * 1024 * 1024:
            return self.send_json(413, {"error": "O formulário excedeu o limite. Envie o vídeo usando o envio em blocos."})
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            return self.send_json(400, {"error": "Envie o arquivo como formulário."})
        body = self.rfile.read(length)
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
        )
        fields = {}
        for part in message.iter_parts():
            field_name = part.get_param("name", header="content-disposition")
            if field_name in {"title", "authorName", "slug", "genre", "type", "animeFormat", "uploadIds"}:
                fields[field_name] = (part.get_payload(decode=True) or b"").decode("utf-8", "replace").strip()
        parts = list(message.iter_parts())
        upload = next(
            (part for part in parts if part.get_param("name", header="content-disposition") == "file"),
            None,
        )
        episode_uploads = [part for part in parts if part.get_param("name", header="content-disposition") == "episodes"]
        try:
            upload_ids = json.loads(fields.get("uploadIds", "[]"))
            if not isinstance(upload_ids, list) or len(upload_ids) > 100:
                raise ValueError
            staged_uploads = [self.read_staged_upload(upload_id, user) for upload_id in upload_ids]
            if upload_ids and (any(item is None for item in staged_uploads) or len(set(upload_ids)) != len(upload_ids)):
                raise ValueError
        except (ValueError, TypeError, json.JSONDecodeError):
            return self.send_json(400, {"error": "Um ou mais arquivos enviados estão incompletos. Tente novamente."})
        release_type = fields.get("type", "")
        anime_format = fields.get("animeFormat", "series")
        if release_type == "anime" and upload is not None and upload.get_filename():
            episode_uploads = [upload, *episode_uploads]
        if (upload is None or not upload.get_filename()) and not staged_uploads:
            return self.send_json(400, {"error": "Selecione as páginas ou o vídeo da obra."})
        if release_type not in {"manga", "manhwa", "anime"}:
            return self.send_json(400, {"error": "Escolha Mangá, Manhwa ou Anime."})
        filename = Path(upload.get_filename().replace("\\", "/")).name if upload and upload.get_filename() else ""
        media_bytes = upload.get_payload(decode=True) or b"" if upload else b""
        media_ext = Path(filename).suffix.lower()
        episode_data = []
        if release_type in {"manga", "manhwa"}:
            if staged_uploads:
                if upload is not None or len(staged_uploads) != 1:
                    return self.send_json(400, {"error": "Mangá e Manhwa aceitam somente um PDF."})
                staged = staged_uploads[0]
                with staged["path"].open("rb") as media:
                    valid_pdf = staged["fileName"].lower().endswith(".pdf") and media.read(5) == b"%PDF-"
                if not valid_pdf:
                    return self.send_json(400, {"error": "Mangá e Manhwa precisam de um arquivo PDF válido."})
                filename, media_ext = staged["fileName"], ".pdf"
                media_type = "application/pdf"
            elif media_ext != ".pdf" or not media_bytes.startswith(b"%PDF-"):
                return self.send_json(400, {"error": "Mangá e Manhwa precisam de um arquivo válido com as páginas."})
            else:
                media_type = "application/pdf"
        else:
            if anime_format not in {"series", "movie"}:
                return self.send_json(400, {"error": "Escolha Padrão (série) ou Filme."})
            if staged_uploads:
                if upload is not None or episode_uploads:
                    return self.send_json(400, {"error": "Não misture envio em blocos com arquivos diretos."})
                for staged in staged_uploads:
                    episode_ext = Path(staged["fileName"]).suffix.lower()
                    with staged["path"].open("rb") as media:
                        header = media.read(16)
                    valid_mp4 = episode_ext == ".mp4" and len(header) >= 12 and header[4:8] == b"ftyp"
                    valid_webm = episode_ext == ".webm" and header.startswith(b"\x1aE\xdf\xa3")
                    if not (valid_mp4 or valid_webm):
                        return self.send_json(400, {"error": "Anime precisa ser enviado como vídeo MP4 ou WebM válido."})
                    episode_data.append({"fileName": staged["fileName"], "mediaExt": episode_ext,
                                         "mediaType": "video/mp4" if episode_ext == ".mp4" else "video/webm",
                                         "staged": staged})
            else:
                media_parts = episode_uploads
                if not media_parts or any(not part.get_filename() for part in media_parts):
                    return self.send_json(400, {"error": "Adicione ao menos um vídeo à publicação."})
                for episode_part in media_parts:
                    episode_filename = Path(episode_part.get_filename().replace("\\", "/")).name
                    episode_ext = Path(episode_filename).suffix.lower()
                    episode_bytes = episode_part.get_payload(decode=True) or b""
                    valid_mp4 = episode_ext == ".mp4" and len(episode_bytes) >= 12 and episode_bytes[4:8] == b"ftyp"
                    valid_webm = episode_ext == ".webm" and episode_bytes.startswith(b"\x1aE\xdf\xa3")
                    if not (valid_mp4 or valid_webm):
                        return self.send_json(400, {"error": "Anime precisa ser enviado como vídeo MP4 ou WebM válido."})
                    episode_data.append({"fileName": episode_filename, "mediaExt": episode_ext,
                                         "mediaType": "video/mp4" if episode_ext == ".mp4" else "video/webm",
                                         "bytes": episode_bytes})
            if not episode_data:
                return self.send_json(400, {"error": "Adicione ao menos um vídeo à publicação."})
            if anime_format == "movie" and len(episode_data) != 1:
                return self.send_json(400, {"error": "Filmes aceitam somente um vídeo."})
            filename = episode_data[0]["fileName"]
            media_ext = episode_data[0]["mediaExt"]
            media_type = episode_data[0]["mediaType"]
            media_bytes = episode_data[0].get("bytes", b"")
            total_media_bytes = sum(item.get("staged", {}).get("size", len(item.get("bytes", b""))) for item in episode_data)
            if total_media_bytes > MAX_UPLOAD:
                return self.send_json(413, {"error": "Os vídeos da publicação precisam somar no máximo 2 GB."})
        if release_type != "anime" and len(media_bytes) > MAX_UPLOAD:
            return self.send_json(413, {"error": "O arquivo precisa ter até 2 GB."})

        cover_part = next(
            (part for part in message.iter_parts() if part.get_param("name", header="content-disposition") == "cover"),
            None,
        )
        if cover_part is None or not cover_part.get_filename():
            return self.send_json(400, {"error": "Escolha uma imagem para a capa."})
        cover_bytes = cover_part.get_payload(decode=True) or b""
        cover_type = cover_part.get_content_type()
        image_signatures = {
            "image/jpeg": (b"\xff\xd8\xff", ".jpg"),
            "image/png": (b"\x89PNG\r\n\x1a\n", ".png"),
            "image/webp": (b"RIFF", ".webp"),
        }
        image_spec = image_signatures.get(cover_type)
        if (not image_spec or len(cover_bytes) > 10 * 1024 * 1024
                or not cover_bytes.startswith(image_spec[0])
                or (cover_type == "image/webp" and cover_bytes[8:12] != b"WEBP")):
            return self.send_json(400, {"error": "A capa precisa ser JPG, PNG ou WebP e ter até 10 MB."})

        title = fields.get("title", "")
        author_name = fields.get("authorName", "")
        slug = fields.get("slug", "")
        genre = fields.get("genre", "")
        if not title or len(title) > 100:
            return self.send_json(400, {"error": "Informe um nome de até 100 caracteres."})
        if not author_name or len(author_name) > 100:
            return self.send_json(400, {"error": "Informe o nome do autor (até 100 caracteres)."})
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
            return self.send_json(400, {"error": "A URL gerada pelo nome não é válida."})
        if not genre or len(genre) > 40:
            return self.send_json(400, {"error": "Escolha um gênero."})

        release_id = uuid.uuid4().hex
        catalog = read_catalog()
        if any(item.get("slug") == slug for item in catalog):
            return self.send_json(409, {"error": "Esse nome já está publicado. Escolha outro nome para gerar uma URL diferente."})
        if release_type == "anime":
            for episode_index, episode in enumerate(episode_data):
                storage_name = release_id if episode_index == 0 else f"{release_id}-episode-{episode_index + 1}"
                destination = UPLOADS / f"{storage_name}{episode['mediaExt']}"
                if episode.get("staged"):
                    os.replace(episode["staged"]["path"], destination)
                else:
                    destination.write_bytes(episode["bytes"])
            episode_records = [{"number": index + 1, "fileName": episode["fileName"], "mediaExt": episode["mediaExt"]} for index, episode in enumerate(episode_data)]
        else:
            if staged_uploads:
                os.replace(staged_uploads[0]["path"], UPLOADS / f"{release_id}{media_ext}")
            else:
                (UPLOADS / f"{release_id}{media_ext}").write_bytes(media_bytes)
            episode_records = []
        cover_url = f"/uploads/{release_id}{image_spec[1]}"
        (ROOT / cover_url.lstrip("/")).write_bytes(cover_bytes)
        release = {
            "id": release_id,
            "title": title,
            "authorName": author_name,
            "slug": slug,
            "genre": genre,
            "type": release_type,
            "animeFormat": anime_format if release_type == "anime" else None,
            "episodes": episode_records,
            "fileName": filename,
            "mediaExt": media_ext,
            "mediaType": media_type,
            "coverUrl": cover_url,
            "addedAt": int(datetime.now(timezone.utc).timestamp() * 1000),
        }
        catalog.append(release)
        temporary = CATALOG.with_suffix(".tmp")
        temporary.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(CATALOG)
        for staged in staged_uploads:
            shutil.rmtree(staged["folder"], ignore_errors=True)
        return self.send_json(201, release)

    def append_anime_episodes(self, release_id):
        origin = self.headers.get("Origin", "")
        if origin and origin.rstrip("/") != BASE_URL:
            parsed_origin = urlparse(origin)
            origin_host = parsed_origin.hostname or ""
            try:
                origin_is_loopback = origin_host == "localhost" or ipaddress.ip_address(origin_host).is_loopback
            except ValueError:
                origin_is_loopback = False
            if not (self.local_admin() and origin_is_loopback and parsed_origin.port == urlparse(BASE_URL).port):
                return self.send_json(403, {"error": "Origem da solicitação inválida."})
        user = self.current_user()
        if not user and self.local_admin():
            user = {"email": "local@localhost"}
        if not user:
            return self.send_json(401, {"error": "Entre com a conta administradora para adicionar episódios."})
        if not user_is_admin(user) and not self.local_admin():
            return self.send_json(403, {"error": "Esta conta não tem permissão para adicionar episódios."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_json(400, {"error": "Tamanho de arquivo inválido."})
        if length <= 0 or length > 24 * 1024 * 1024:
            return self.send_json(413, {"error": "O formulário excedeu o limite. Envie os vídeos em blocos."})
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            return self.send_json(400, {"error": "Envie os vídeos como formulário."})
        message = BytesParser(policy=policy.default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + self.rfile.read(length)
        )
        fields = {
            part.get_param("name", header="content-disposition"): (part.get_payload(decode=True) or b"").decode("utf-8", "replace")
            for part in message.iter_parts()
            if part.get_param("name", header="content-disposition") == "uploadIds"
        }
        try:
            upload_ids = json.loads(fields.get("uploadIds", "[]"))
            if not isinstance(upload_ids, list) or not upload_ids or len(upload_ids) > 100:
                raise ValueError
            staged_uploads = [self.read_staged_upload(upload_id, user) for upload_id in upload_ids]
            if any(item is None for item in staged_uploads) or len(set(upload_ids)) != len(upload_ids):
                raise ValueError
        except (ValueError, TypeError, json.JSONDecodeError):
            return self.send_json(400, {"error": "Um ou mais vídeos estão incompletos. Tente enviar novamente."})
        catalog = read_catalog()
        release = next((item for item in catalog if item.get("id") == release_id), None)
        if not release:
            return self.send_json(404, {"error": "Obra não encontrada."})
        if release.get("type") != "anime" or release.get("animeFormat", "series") == "movie":
            return self.send_json(400, {"error": "Só é possível adicionar episódios a séries de anime."})
        new_episodes = []
        total_size = 0
        for staged in staged_uploads:
            filename = staged["fileName"]
            media_ext = Path(filename).suffix.lower()
            with staged["path"].open("rb") as media:
                header = media.read(16)
            valid_mp4 = media_ext == ".mp4" and len(header) >= 12 and header[4:8] == b"ftyp"
            valid_webm = media_ext == ".webm" and header.startswith(b"\x1aE\xdf\xa3")
            if not (valid_mp4 or valid_webm):
                return self.send_json(400, {"error": "Use vídeos MP4 ou WebM válidos."})
            total_size += staged["size"]
            new_episodes.append({"fileName": filename, "mediaExt": media_ext, "staged": staged})
        if total_size > MAX_UPLOAD:
            return self.send_json(413, {"error": "Os episódios adicionados precisam somar no máximo 2 GB."})

        episodes = list(release.get("episodes") or [])
        if not episodes:
            episodes = [{"number": 1, "fileName": release.get("fileName", "Episódio 1"), "mediaExt": release.get("mediaExt", ".mp4")}]
        start_index = len(episodes)
        for offset, episode in enumerate(new_episodes):
            episode_index = start_index + offset
            storage_name = f"{release_id}-episode-{episode_index + 1}"
            destination = UPLOADS / f"{storage_name}{episode['mediaExt']}"
            os.replace(episode["staged"]["path"], destination)
            episodes.append({"number": episode_index + 1, "fileName": episode["fileName"], "mediaExt": episode["mediaExt"]})
        release["episodes"] = episodes
        release["animeFormat"] = "series"
        temporary = CATALOG.with_suffix(".tmp")
        temporary.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(CATALOG)
        for staged in staged_uploads:
            shutil.rmtree(staged["folder"], ignore_errors=True)
        return self.send_json(200, {"release": release, "appended": len(new_episodes)})

    def do_DELETE(self):
        path = unquote(urlparse(self.path).path)
        match = re.fullmatch(r"/api/releases/([a-f0-9]{32})", path)
        if not match:
            return self.send_json(404, {"error": "Rota não encontrada."})
        origin = self.headers.get("Origin", "")
        if origin.rstrip("/") != BASE_URL:
            return self.send_json(403, {"error": "Origem da solicitação inválida."})
        user = self.current_user()
        if not user and self.local_admin():
            user = {"email": "local@localhost"}
        if not user:
            return self.send_json(401, {"error": "Entre com a conta administradora para apagar publicações."})
        if not user_is_admin(user) and not self.local_admin():
            return self.send_json(403, {"error": "Esta conta não tem permissão para apagar publicações."})

        release_id = match.group(1)
        catalog = read_catalog()
        release = next((item for item in catalog if item.get("id") == release_id), None)
        if not release:
            return self.send_json(404, {"error": "Publicação não encontrada."})
        temporary = CATALOG.with_suffix(".tmp")
        temporary.write_text(json.dumps(
            [item for item in catalog if item.get("id") != release_id], ensure_ascii=False, indent=2
        ), encoding="utf-8")
        temporary.replace(CATALOG)

        media_ext = release.get("mediaExt") or ".pdf"
        if media_ext in {".pdf", ".mp4", ".webm"}:
            (UPLOADS / f"{release_id}{media_ext}").unlink(missing_ok=True)
        for episode_index, episode in enumerate(release.get("episodes") or []):
            episode_ext = episode.get("mediaExt", ".mp4")
            episode_name = release_id if episode_index == 0 else f"{release_id}-episode-{episode_index + 1}"
            if episode_ext in {".mp4", ".webm"}:
                (UPLOADS / f"{episode_name}{episode_ext}").unlink(missing_ok=True)
        cover_name = Path(str(release.get("coverUrl", ""))).name
        if cover_name in {f"{release_id}.jpg", f"{release_id}.png", f"{release_id}.webp"}:
            (UPLOADS / cover_name).unlink(missing_ok=True)
        return self.send_json(200, {"ok": True})

    def do_PUT(self):
        if urlparse(self.path).path != "/api/profile":
            return self.send_json(404, {"error": "Rota não encontrada."})
        if self.headers.get("Origin", "").rstrip("/") != BASE_URL:
            return self.send_json(403, {"error": "Origem da solicitação inválida."})
        user = self.current_user()
        if not user:
            return self.send_json(401, {"error": "Entre na sua conta para salvar o perfil."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 11 * 1024 * 1024:
                raise ValueError
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                raise ValueError
            message = BytesParser(policy=policy.default).parsebytes(
                f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + self.rfile.read(length)
            )
            fields = {}
            avatar_part = None
            for part in message.iter_parts():
                field_name = part.get_param("name", header="content-disposition")
                if field_name == "avatar" and part.get_filename():
                    avatar_part = part
                elif field_name in {"displayName", "removeAvatar"}:
                    fields[field_name] = (part.get_payload(decode=True) or b"").decode("utf-8", "replace").strip()
            display_name = fields.get("displayName", "")
            remove_avatar = fields.get("removeAvatar") == "1"
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, AttributeError):
            return self.send_json(400, {"error": "Os dados do perfil são inválidos."})
        if len(display_name) > 60:
            return self.send_json(400, {"error": "O nome de exibição deve ter até 60 caracteres."})
        avatar_bytes = b""
        avatar_extension = ""
        if avatar_part:
            avatar_bytes = avatar_part.get_payload(decode=True) or b""
            image_types = {
                "image/jpeg": (b"\xff\xd8\xff", ".jpg"),
                "image/png": (b"\x89PNG\r\n\x1a\n", ".png"),
                "image/webp": (b"RIFF", ".webp"),
            }
            image_spec = image_types.get(avatar_part.get_content_type())
            if (not image_spec or not avatar_bytes or len(avatar_bytes) > 10 * 1024 * 1024
                    or not avatar_bytes.startswith(image_spec[0])
                    or (avatar_part.get_content_type() == "image/webp" and avatar_bytes[8:12] != b"WEBP")):
                return self.send_json(400, {"error": "A foto precisa ser JPG, PNG ou WebP e ter até 10 MB."})
            avatar_extension = image_spec[1]
        connection = auth_db()
        old_profile = connection.execute("SELECT avatar_url FROM user_profiles WHERE user_id=?", (user["id"],)).fetchone()
        old_avatar_url = old_profile["avatar_url"] if old_profile else ""
        avatar_url = "" if remove_avatar else old_avatar_url
        if avatar_part:
            avatar_url = f"/uploads/profile-{user['id']}-{uuid.uuid4().hex}{avatar_extension}"
            (UPLOADS / Path(avatar_url).name).write_bytes(avatar_bytes)
        connection.execute("""INSERT INTO user_profiles(user_id,display_name,avatar_url,updated_at)
            VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
            display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at""",
            (user["id"], display_name, avatar_url, int(datetime.now(timezone.utc).timestamp())))
        connection.commit()
        connection.close()
        old_avatar_name = Path(old_avatar_url).name
        managed_avatar = re.fullmatch(
            rf"profile-{re.escape(user['id'])}(?:-[a-f0-9]{{32}})?\.(?:jpg|png|webp)", old_avatar_name
        )
        if managed_avatar and old_avatar_name != Path(avatar_url).name:
            (UPLOADS / old_avatar_name).unlink(missing_ok=True)
        return self.send_json(200, {"ok": True})

    def log_message(self, format_string, *args):
        if getattr(self, "path", "").startswith("/auth/"):
            return
        super().log_message(format_string, *args)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), KzinflixHandler)
    print(f"Kzinflix disponível em http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        server.server_close()
