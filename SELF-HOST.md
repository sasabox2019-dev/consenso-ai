# Auto-alojamiento (self-hosting) — Consenso AI v2

Esta guía explica cómo ejecutar Consenso AI **en tu propio ordenador, servidor o contenedor**, sin depender de Cloudflare. (¿Prefieres Cloudflare gratis? Ver [DEPLOY.md](DEPLOY.md) — mismo código, otro destino.)

La aplicación es un servidor Node estándar con base de datos SQLite embebida: **no necesita servicios externos**, solo Node ≥ 22.13 (o Docker). Todo el estado vive en un único directorio de datos que tú eliges.

---

## 1. Requisitos

| Modo | Necesitas |
|---|---|
| Node directo | Node ≥ 22.13 y npm |
| Docker | Docker 24+ (o Docker Desktop) |
| VPS con TLS | Lo anterior + [Caddy](https://caddyserver.com) o nginx como proxy |

Dos secretos obligatorios (los generas tú, 32+ caracteres):

```bash
openssl rand -hex 32   # → MASTER_KEY  (cifra las API keys de los agentes)
openssl rand -hex 32   # → JWT_SECRET  (firma sesiones y protege contraseñas)
```

> ⚠️ **Guárdalos y no los cambies a la ligera**: `MASTER_KEY` cifra las API keys guardadas (si la pierdes, las keys hay que reintroducirlas) y `JWT_SECRET` protege la contraseña del admin (si la cambias, hay que recrear la cuenta admin — ver §8).

---

## 2. Inicio rápido — tres caminos

### Opción A · Node directo (lo más simple)

```bash
git clone <este-repo> && cd consenso-ai
npm install
npm run build

# secrets (Linux/macOS); en Windows usa Git Bash o define las variables a mano
export MASTER_KEY=$(openssl rand -hex 32)
export JWT_SECRET=$(openssl rand -hex 32)

npm run dev        # arranca en http://localhost:8787
```

Entra en `http://localhost:8787/#/admin` → **"Primer arranque"** → crea tu usuario y contraseña (botón *Generar* = contraseña fuerte de 20 caracteres) → ya puedes añadir tus agentes IA con sus API keys.

### Opción B · Docker (la más cómoda para servidores)

```bash
git clone <este-repo> && cd consenso-ai
echo "MASTER_KEY=$(openssl rand -hex 32)" >> .env
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up -d --build
```

Datos persistentes en el volumen `consenso-data`. Para actualizarte: `git pull && docker compose up -d --build`.

### Opción C · Demo sin API keys (probar antes de configurar nada)

```bash
node apps/worker/test/mock-llm-server.mjs &   # LLM de prueba
npm run dev                                    # siembra 4 agentes demo
```

La app entera funciona contra el servidor mock: perfecto para enseñársela a alguien.

---

## 3. Variables de entorno

| Variable | Obligatoria | Qué hace |
|---|---|---|
| `MASTER_KEY` | ✅ (en servidores) | Cifra las API keys de los agentes en la BD (AES-256-GCM). Mínimo 32 caracteres. |
| `JWT_SECRET` | ✅ (en servidores) | Firma las sesiones admin y protege el hash de contraseña. Mínimo 32 caracteres. |
| `BOOTSTRAP_TOKEN` | — | Si lo defines, crear la cuenta admin exige además este token (protege la ventana de primer arranque en URLs públicas). |
| `PORT` | — | Puerto HTTP. Por defecto `8787`. |
| `HOST` | — | `127.0.0.1` por defecto (solo local). Pon `0.0.0.0` en Docker/VPS **siempre detrás de un proxy con TLS**. |
| `DATA_DIR` | — | Directorio del archivo SQLite. Por defecto `apps/worker/.dev/`. En Docker: `/app/data`. |
| `TRUST_PROXY_IP` | — | `1` = los límites de uso usan la IP real que te pasa tu proxy (cabeceras `X-Real-IP`/`X-Forwarded-For`). **Solo si el tráfico entra por TU proxy.** Ver §6. |

Sin `MASTER_KEY`/`JWT_SECRET` y sin `.dev-vars.json` el servidor no arranca (falla con un mensaje claro — no inventa secretos).

---

## 4. Primera entrada al panel de administración

1. Abre `http://tu-servidor:8787/#/admin`
2. Aparece **"Primer arranque"** (solo se muestra mientras no exista ninguna cuenta admin)
3. Crea usuario y contraseña — usa **Generar** o tu gestor de contraseñas (mínimo 12 caracteres)
4. Añade tus agentes: uno con rol **Moderadora** y el resto **Participante** (2 a 5 expertos por consenso)
5. Prueba cada agente con **Probar conexión** y listo

¿Olvidaste la contraseña? Borra la cuenta y vuelve a crearla:

```bash
# Node directo (desde apps/worker):
npx tsx -e 'import("./src/node/d1-sqlite.ts").then(async ({NodeSqliteD1}) => { const db = new NodeSqliteD1("RUTA/A/consenso.sqlite"); await db.prepare("DELETE FROM admin_user").run(); console.log("ok"); })'

# Docker:
docker compose exec consenso-ai npx tsx -e 'import("./src/node/d1-sqlite.ts").then(async ({NodeSqliteD1}) => { const db = new NodeSqliteD1(process.env.DATA_DIR + "/consenso.sqlite"); await db.prepare("DELETE FROM admin_user").run(); console.log("ok"); })'
```

> Nota: el sistema es de **una sola cuenta admin** por diseño (simple y seguro para equipos pequeños). Para varias personas, comparte esa credencial.

---

## 5. Servidor VPS con systemd

```ini
# /etc/systemd/system/consenso-ai.service
[Unit]
Description=Consenso AI v2
After=network.target

[Service]
Type=simple
User=consenso
WorkingDirectory=/opt/consenso-ai/apps/worker
Environment=MASTER_KEY=<pegar>
Environment=JWT_SECRET=<pegar>
Environment=HOST=0.0.0.0
# Environment=TRUST_PROXY_IP=1     ← solo si pones Caddy/nginx delante (§6)
ExecStart=/usr/bin/npx tsx src/node-dev.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now consenso-ai
journalctl -u consenso-ai -f        # logs en vivo
```

## 6. TLS con Caddy (2 líneas) + IP real

```
# /etc/caddy/Caddyfile
consenso.tudominio.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy da HTTPS automático (Let's Encrypt). Como ahora el proxy ve las IPs reales, activa en el servicio `TRUST_PROXY_IP=1` para que los límites de uso cuenten **por visitante** y no globalmente.

> ⚠️ **Nunca actives `TRUST_PROXY_IP` si el tráfico no entra por tu proxy**: cualquier visitante podría fingir su IP con cabeceras falsas y esquivarse los límites. En Cloudflare no hace falta — la plataforma inyecta la IP real (`cf-connecting-ip`) y el sistema la usa automáticamente.

Equivalente en nginx: `proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-Proto $scheme;` + `proxy_pass http://127.0.0.1:8787;`.

---

## 7. Copias de seguridad

Todo el estado (agentes, keys cifradas, cuenta admin, auditoría) vive en **un solo archivo** SQLite:

```bash
# Backup (Node directo): copia el archivo con la app parada o en marcha (WAL):
cp apps/worker/.dev/consenso.sqlite backup-$(date +%F).sqlite

# Docker:
docker compose cp consenso-ai:/app/data/consenso.sqlite backup-$(date +%F).sqlite

# Restaurar: para la app, sustituye el archivo, arranca.
```

Las API keys dentro están cifradas con `MASTER_KEY` — un backup sin esa clave no sirve a otro servidor.

## 8. Actualizar la aplicación

```bash
git pull
npm install          # solo si cambiaron dependencias
npm run build        # reconstruye la UI
# reinicia el servicio / docker compose up -d --build
```

Las migraciones de base de datos se aplican solas al arrancar (idempotentes). Si tras actualizar te pide crear el admin otra vez, fue porque cambió `JWT_SECRET` — usa el comando de reset del §4.

## 9. Notas de seguridad (resumen honesto)

- API keys de agentes cifradas en reposo (AES-256-GCM); jamás se devuelven por la API.
- Contraseña admin: HMAC con pepper derivado por HKDF + comparación en tiempo constante + límite de fallos.
- Sesiones: cookie HttpOnly/SameSite=Strict (+`Secure` si sirves por HTTPS), revocables en el servidor.
- Cabeceras de seguridad (CSP, nosniff, anti-framing) incluidas también en las páginas estáticas.
- Todo input validado con Zod; cuerpos >10 KB rechazados; límites de uso por IP; registro de auditoría de acciones admin.
- **Tu parte** como operador: HTTPS en el proxy (Caddy lo hace solo), `BOOTSTRAP_TOKEN` si el panel está expuesto a internet, y backups del archivo SQLite + `MASTER_KEY` en lugar seguro.

## 10. Problemas frecuentes

| Síntoma | Causa/solución |
|---|---|
| `❌ Puerto 8787 ocupado` | Ya hay otra instancia. Cambia `PORT` o para la otra. |
| `MASTER_KEY too weak` | Tu clave tiene menos de 32 caracteres: genera con `openssl rand -hex 32`. |
| Pide crear admin tras reiniciar | Cambiaste `JWT_SECRET` — usa el reset del §4 y crea la cuenta de nuevo. |
| Todos los visitantes comparten límite de uso | Estás detrás de un proxy sin `TRUST_PROXY_IP=1` (§6). |
| `La API devolvió HTTP 401` en un agente | API key incorrecta o caducada — edítala en el panel y prueba conexión. |
