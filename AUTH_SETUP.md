# Configurar login Google e Discord

O servidor usa OAuth no backend, valida o `state` de cada tentativa e mantém uma sessão em cookie `HttpOnly`. As senhas dos provedores nunca passam pelo site.

1. Copie `.env.example` para `.env`.
2. Crie um cliente OAuth do tipo **Web application** no Google Cloud e adicione `http://localhost:8000` como origem JavaScript autorizada. O Google GIS entrega o credential ao callback JavaScript e o backend valida o token usando o Client ID; esse fluxo não precisa do Client Secret.
3. Crie uma aplicação no Discord Developer Portal e registre `http://localhost:8000/auth/discord/callback` em OAuth2 > Redirects.
4. Coloque o Google Client ID e o Discord Client ID/Secret no `.env`; adicione o e-mail verificado autorizado a publicar em `ADMIN_EMAILS`. Em `localhost`, `LOCAL_DEV_MODE=1` permite testar publicação localmente sem essa lista.
5. Instale as dependências com `python3 -m pip install -r requirements.txt`, reinicie `python3 server.py` e entre pelo botão **Entrar**.

Em produção, adicione o domínio HTTPS como origem JavaScript do Google e cadastre o callback HTTPS do Discord. Nunca publique o `.env` ou o Discord Client Secret no código do navegador.
